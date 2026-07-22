import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PrismaClient } from '@prisma/client';
import { DelayedError, Job, Worker } from 'bullmq';
import type { ConnectionOptions } from 'bullmq';
import { CouponService } from '../coupon/coupon.service';
import type { CouponView } from '../coupon/coupon.types';
import { PrismaService } from '../db/prisma.service';
import type { ScoredDeal } from '../deal-score/types';
import { DedupService } from '../dedup/dedup.service';
import { CountersService } from '../metrics/counters.service';
import { FormatterService } from '../pipeline/formatter.service';
import {
  PRICE_SCRAPER_PORT,
  type PriceScraperPort,
} from '../pricing/price-scraper.port';
import type { PriceView } from '../pricing/price-view';
import { PublisherRegistry } from '../publisher/publisher-registry.service';
import {
  SEND_DEAL_QUEUE,
  SendDealJob,
  SendDigestJob,
  SendJob,
} from '../queue/queue.types';
import { OpsConfigService } from '../ops-config/ops-config.service';
import { msUntilQuietEnd } from '../scheduler/quiet-hours';
import { keyToString } from '../sources/source.port';
import { couponViewFromCuratorEdit } from '../shared/curator-edits';

/**
 * Worker that consumes `send-deal` jobs and dispatches them through Baileys.
 * BullMQ handles retries (5 attempts, exponential backoff defined on the
 * queue). On success the deal is marked posted in `DedupEntry` so retries
 * from a later run don't re-publish it.
 *
 * Errors classified as "throttled:*" are surfaced as job failures so BullMQ
 * applies its retry strategy — they typically mean the per-chip rate limit
 * window will reopen within minutes. Other errors (formatter failure, fatal
 * WhatsApp errors) likewise fail and retry; if they exhaust attempts BullMQ
 * keeps them in the dead-letter set for inspection.
 *
 * Stale-price re-check: a job can sit in the queue for hours (quiet hours,
 * retries). When it is older than SEND_MAX_JOB_AGE_MIN minutes the price is
 * re-scraped at send time — observed price always beats the estimate frozen
 * at enqueue. If the re-scrape fails the deal is DISCARDED silently (never
 * publish a price we can't confirm) and `stalePriceDrop` is incremented.
 *
 * WA jitter: consecutive WhatsApp publishes are spaced by a random
 * human-like pause (WA_JITTER_MIN_MS..WA_JITTER_MAX_MS). Telegram is a bot
 * API — no jitter needed.
 */
@Injectable()
export class SendDealWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SendDealWorker.name);
  private worker: Worker<SendJob> | null = null;

  /** Epoch ms of the last successful WA publish from this instance. */
  private lastWaPublishAt: number | null = null;

  // Seams for unit tests (overridden so specs never actually wait).
  protected sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms));
  protected random: () => number = Math.random;
  protected now: () => number = Date.now;

  constructor(
    @Inject('REDIS_CONNECTION_OPTIONS')
    private readonly connection: ConnectionOptions,
    private readonly publishers: PublisherRegistry,
    private readonly formatter: FormatterService,
    private readonly dedup: DedupService,
    private readonly prisma: PrismaService,
    private readonly counters: CountersService,
    private readonly config: ConfigService,
    @Inject(PRICE_SCRAPER_PORT)
    private readonly priceScraper: PriceScraperPort,
    private readonly coupons: CouponService,
    private readonly opsConfig: OpsConfigService,
  ) {}

  /**
   * PrismaService deliberately erases the generated client types (see the
   * header comment in src/db/prisma.service.ts). The client has been
   * generated in this repo, so re-assert the real type once here — typed
   * model access below, no `any`.
   */
  private get db(): PrismaClient {
    return this.prisma as unknown as PrismaClient;
  }

  async onModuleInit(): Promise<void> {
    this.worker = new Worker<SendJob>(
      SEND_DEAL_QUEUE,
      async (job, token) => this.process(job, token),
      {
        connection: this.connection,
        concurrency: 1,
        // The per-chip warmup limiter inside WhatsappService is the
        // authoritative throttle; this rate-limiter is a soft secondary
        // cap to keep the queue from hammering Redis on tight loops.
        limiter: { max: 30, duration: 60_000 },
      },
    );

    this.worker.on('failed', (job, err) => {
      const attempts = job?.attemptsMade ?? 0;
      const max = job?.opts.attempts ?? 1;
      this.logger.warn(
        `send-deal job ${job?.id} failed (attempt ${attempts}/${max}): ${err?.message}`,
      );
      this.counters.wppMessagesFailed
        .labels(this.classifyReason(err?.message ?? ''))
        .inc();
    });

    this.worker.on('completed', (job) => {
      const channel = job.data.channel ?? 'wa';
      this.counters.wppMessagesSent.labels(channel).inc();
    });

    this.logger.log(`SendDealWorker listening on queue=${SEND_DEAL_QUEUE}`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }

  private async process(job: Job<SendJob>, token?: string): Promise<void> {
    // Quiet-hours hold at send time (issue #7): a non-urgent job that reaches
    // the worker inside the quiet window is parked until the window ends —
    // retries and backlogs can no longer leak into the night. Urgent jobs
    // ("enviar agora", a human decision) pierce the hold.
    const urgent =
      job.name !== 'send-digest' && (job.data as SendDealJob).urgent === true;
    if (!urgent) await this.holdDuringQuietHours(job, token);

    if (job.name === 'send-digest') {
      return this.processDigest(job as Job<SendDigestJob>);
    }
    return this.processSingle(job as Job<SendDealJob>);
  }

  /** Parks the job until the quiet window ends (throws DelayedError). */
  private async holdDuringQuietHours(
    job: Job<SendJob>,
    token?: string,
  ): Promise<void> {
    if (!(await this.opsConfig.quietHoursEnabled())) return;
    const start = this.envInt('QUIET_START', 23);
    const end = this.envInt('QUIET_END', 7);
    const tz = this.config.get<string>('TZ') ?? 'America/Sao_Paulo';
    const delayMs = msUntilQuietEnd(new Date(this.now()), start, end, tz);
    if (delayMs <= 0) return;
    this.logger.log(
      `job ${job.id} held for quiet hours — resuming in ${Math.round(delayMs / 60_000)}min`,
    );
    await job.moveToDelayed(this.now() + delayMs, token);
    throw new DelayedError();
  }

  private async processDigest(job: Job<SendDigestJob>): Promise<void> {
    const { targetJid, deals, digestId } = job.data;
    const stale = this.isStale(job);

    const sendable: Array<{
      catalogKey: string;
      variant: 'A' | 'B';
      scored: ScoredDeal;
      priceView?: PriceView;
      couponView?: CouponView;
    }> = [];
    for (const d of deals) {
      const edits = d.scored.curatorEdits;
      // A curator-edited price is human-confirmed — never re-scraped, never
      // dropped as stale (issue #6).
      if (!stale || edits?.priceCents != null) {
        sendable.push({
          ...d,
          // Re-check coupon validity at send time — never post a stale code
          // (ml-coupons-v1).
          couponView: this.effectiveCouponView(
            d.scored,
            d.couponView &&
              new Date(d.couponView.validUntil).getTime() > this.now()
              ? d.couponView
              : undefined,
          ),
        });
        continue;
      }
      const fresh = await this.refreshPrice(d.scored);
      if (!fresh) {
        this.counters.stalePriceDrop.inc();
        this.logger.warn(
          `send-digest job ${job.id}: dropped ${d.catalogKey} — stale price re-check failed`,
        );
        continue;
      }
      sendable.push({
        ...d,
        priceView: fresh.priceView,
        couponView: this.effectiveCouponView(d.scored, fresh.couponView),
      });
    }

    if (sendable.length === 0) {
      this.logger.warn(
        `send-digest job ${job.id} discarded entirely: stale price re-check failed for all ${deals.length} deal(s)`,
      );
      return;
    }

    const publisher = this.publishers.get('wa');
    const { caption, imageUrl } = await this.formatter.formatDigest(
      sendable.map((d) => ({
        scored: d.scored,
        variant: d.variant,
        priceView: d.priceView,
        couponView: d.couponView,
      })),
    );
    await this.waJitter();
    await publisher.publish({ caption, imageUrl }, targetJid);
    this.lastWaPublishAt = this.now();

    for (const d of sendable) {
      await this.dedup.markPosted(d.catalogKey);
      try {
        await this.db.sentMessage.create({
          data: {
            catalogId: d.catalogKey,
            targetJid,
            caption,
            variant: d.variant,
            digestId,
          },
        });
      } catch (err) {
        // Audit row must never fail a job that already published.
        this.logger.warn(
          `sentMessage audit insert failed: ${(err as Error).message}`,
        );
      }
    }
    this.logger.log(
      `send-digest job ${job.id} ok (${sendable.length}/${deals.length} deals -> ${targetJid})`,
    );
  }

  private async processSingle(job: Job<SendDealJob>): Promise<void> {
    const { targetJid, scored } = job.data;
    const channel = job.data.channel ?? 'wa';
    const keyStr = keyToString(scored.deal.key);

    const variant = job.data.variant ?? 'A';
    const publisher = this.publishers.get(channel);
    let priceView = job.data.priceView;
    // Re-check coupon validity at send time — a job can sit in the queue past
    // the coupon's expiry; never post a stale code (ml-coupons-v1).
    let couponView =
      job.data.couponView &&
      new Date(job.data.couponView.validUntil).getTime() > this.now()
        ? job.data.couponView
        : undefined;

    // A curator-edited price is human-confirmed — never re-scraped, never
    // dropped as stale (issue #6).
    if (this.isStale(job) && scored.curatorEdits?.priceCents == null) {
      const fresh = await this.refreshPrice(scored);
      if (!fresh) {
        this.counters.stalePriceDrop.inc();
        this.logger.warn(
          `send-deal job ${job.id} discarded: stale price re-check failed (${keyStr})`,
        );
        return;
      }
      priceView = fresh.priceView;
      couponView = fresh.couponView;
    }
    couponView = this.effectiveCouponView(scored, couponView);

    const { caption, imageUrl, linkUrl } = await this.formatter.formatScored(
      scored,
      variant,
      job.data.trustBadge,
      priceView,
      couponView,
    );
    if (channel === 'wa') await this.waJitter(job.data.urgent === true);
    await publisher.publish({ caption, imageUrl, linkUrl }, targetJid);
    if (channel === 'wa') this.lastWaPublishAt = this.now();

    await this.dedup.markPosted(keyStr);
    try {
      await this.db.sentMessage.create({
        data: { catalogId: keyStr, targetJid, caption, variant },
      });
    } catch (err) {
      // Audit row must never fail a job that already published.
      this.logger.warn(
        `sentMessage audit insert failed: ${(err as Error).message}`,
      );
    }
    this.logger.log(
      `send-deal job ${job.id} ok (${keyStr} -> ${targetJid} via ${channel}, level=${scored.level}, score=${scored.score})`,
    );
  }

  /**
   * A curator-edited coupon (approval panel) always beats whatever the job
   * carries or the stale re-resolve produced: the human decision IS the
   * validity, so no expiry re-check applies. Rebuilt against the deal's
   * current à-vista price (the same basis the automatic resolver uses) so
   * the "com cupom" line only prints when it still beats that price.
   */
  private effectiveCouponView(
    scored: ScoredDeal,
    resolved: CouponView | undefined,
  ): CouponView | undefined {
    const edit = scored.curatorEdits?.coupon;
    if (!edit) return resolved;
    return couponViewFromCuratorEdit(
      edit,
      scored.deal.raw.priceCents,
      new Date(this.now()),
    );
  }

  /** True when the job waited in the queue longer than SEND_MAX_JOB_AGE_MIN. */
  private isStale(job: Job<SendJob>): boolean {
    const ts = job.timestamp;
    if (typeof ts !== 'number' || !Number.isFinite(ts)) return false;
    const maxAgeMs = this.envInt('SEND_MAX_JOB_AGE_MIN', 10) * 60_000;
    return this.now() - ts > maxAgeMs;
  }

  /**
   * Re-scrape the displayed price and recompute the coupon line against it.
   * Returns null when the deal must be discarded (scrape failed / no price).
   * On success the deal's raw price fields are corrected in place, mirroring
   * PipelineService.applyPriceView — observed price always beats estimated.
   */
  private async refreshPrice(scored: ScoredDeal): Promise<{
    priceView: PriceView;
    couponView?: CouponView;
  } | null> {
    const raw = scored.deal.raw;
    let view: PriceView | null = null;
    try {
      view = await this.priceScraper.scrapePriceView(raw.permalink);
    } catch (err) {
      // Port contract says never throw, but a discarded deal must never
      // depend on that.
      this.logger.warn(
        `stale price re-scrape threw for ${keyToString(scored.deal.key)}: ${(err as Error).message}`,
      );
      view = null;
    }
    if (!view || typeof view.priceCents !== 'number') return null;

    raw.priceCents = view.priceCents;
    if (view.originalPriceCents != null) {
      raw.originalPriceCents = view.originalPriceCents;
    }
    if (view.discountPercent != null) {
      raw.discountPercent = view.discountPercent;
    }

    let couponView: CouponView | undefined;
    try {
      couponView =
        (await this.coupons.resolveForDeal(scored.deal, view.priceCents)) ??
        undefined;
    } catch (err) {
      this.logger.warn(
        `coupon re-resolve failed for ${keyToString(scored.deal.key)}: ${(err as Error).message}`,
      );
      couponView = undefined;
    }
    return { priceView: view, couponView };
  }

  /**
   * Human-like pause between consecutive WA publishes. Picks a random target
   * gap in [WA_JITTER_MIN_MS, WA_JITTER_MAX_MS] and sleeps only the part not
   * already covered by naturally elapsed time — an idle queue never waits.
   *
   * Urgent jobs skip the pacing window but NEVER the jitter itself: a short
   * random gap ([URGENT_WA_JITTER_MIN_MS, URGENT_WA_JITTER_MAX_MS], default
   * 2–8s) always protects the number (issue #7).
   */
  private async waJitter(urgent = false): Promise<void> {
    if (this.lastWaPublishAt == null) return;
    const min = urgent
      ? this.envInt('URGENT_WA_JITTER_MIN_MS', 2_000)
      : this.envInt('WA_JITTER_MIN_MS', 30_000);
    const max = Math.max(
      min,
      urgent
        ? this.envInt('URGENT_WA_JITTER_MAX_MS', 8_000)
        : this.envInt('WA_JITTER_MAX_MS', 120_000),
    );
    const target = min + this.random() * (max - min);
    const wait = Math.round(target - (this.now() - this.lastWaPublishAt));
    if (wait > 0) await this.sleep(wait);
  }

  /** Integer env via ConfigService with a default for absent/garbage values. */
  private envInt(name: string, dflt: number): number {
    const raw = this.config.get<string>(name);
    if (raw == null || raw === '') return dflt;
    const n = Number(raw);
    return Number.isFinite(n) ? n : dflt;
  }

  /** Map BullMQ error messages to short labels for Prometheus. */
  private classifyReason(msg: string): string {
    if (msg.startsWith('throttled:')) return msg.slice('throttled:'.length);
    if (msg.includes('whatsapp_not_ready')) return 'wa_not_ready';
    if (msg.includes('formatter')) return 'formatter_error';
    return 'other';
  }
}
