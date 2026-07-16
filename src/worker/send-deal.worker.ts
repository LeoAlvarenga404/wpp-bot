import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Job, Worker } from 'bullmq';
import type { ConnectionOptions } from 'bullmq';
import { PrismaService } from '../db/prisma.service';
import { DedupService } from '../dedup/dedup.service';
import { CountersService } from '../metrics/counters.service';
import { FormatterService } from '../pipeline/formatter.service';
import { PublisherRegistry } from '../publisher/publisher-registry.service';
import {
  SEND_DEAL_QUEUE,
  SendDealJob,
  SendDigestJob,
  SendJob,
} from '../queue/queue.types';
import { keyToString } from '../sources/source.port';

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
 */
@Injectable()
export class SendDealWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SendDealWorker.name);
  private worker: Worker<SendJob> | null = null;

  constructor(
    @Inject('REDIS_CONNECTION_OPTIONS')
    private readonly connection: ConnectionOptions,
    private readonly publishers: PublisherRegistry,
    private readonly formatter: FormatterService,
    private readonly dedup: DedupService,
    private readonly prisma: PrismaService,
    private readonly counters: CountersService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.worker = new Worker<SendJob>(
      SEND_DEAL_QUEUE,
      async (job) => this.process(job),
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

  private async process(job: Job<SendJob>): Promise<void> {
    if (job.name === 'send-digest') {
      return this.processDigest(job as Job<SendDigestJob>);
    }
    return this.processSingle(job as Job<SendDealJob>);
  }

  private async processDigest(job: Job<SendDigestJob>): Promise<void> {
    const { targetJid, deals, digestId } = job.data;

    const publisher = this.publishers.get('wa');
    const { caption, imageUrl } = await this.formatter.formatDigest(
      deals.map((d) => ({
        scored: d.scored,
        variant: d.variant,
        priceView: d.priceView,
        couponView:
          d.couponView &&
          new Date(d.couponView.validUntil).getTime() > Date.now()
            ? d.couponView
            : undefined,
      })),
    );
    await publisher.publish({ caption, imageUrl }, targetJid);

    for (const d of deals) {
      await this.dedup.markPosted(d.catalogKey);
      try {
        await (this.prisma as any).sentMessage.create({
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
      `send-digest job ${job.id} ok (${deals.length} deals -> ${targetJid})`,
    );
  }

  private async processSingle(job: Job<SendDealJob>): Promise<void> {
    const { targetJid, scored } = job.data;
    const channel = job.data.channel ?? 'wa';
    const keyStr = keyToString(scored.deal.key);

    const variant = job.data.variant ?? 'A';
    const publisher = this.publishers.get(channel);
    // Re-check coupon validity at send time — a job can sit in the queue past
    // the coupon's expiry; never post a stale code (ml-coupons-v1).
    const couponView =
      job.data.couponView &&
      new Date(job.data.couponView.validUntil).getTime() > Date.now()
        ? job.data.couponView
        : undefined;
    const { caption, imageUrl } = await this.formatter.formatScored(
      scored,
      variant,
      job.data.trustBadge,
      job.data.priceView,
      couponView,
    );
    await publisher.publish({ caption, imageUrl }, targetJid);

    await this.dedup.markPosted(keyStr);
    try {
      await (this.prisma as any).sentMessage.create({
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

  /** Map BullMQ error messages to short labels for Prometheus. */
  private classifyReason(msg: string): string {
    if (msg.startsWith('throttled:')) return msg.slice('throttled:'.length);
    if (msg.includes('whatsapp_not_ready')) return 'wa_not_ready';
    if (msg.includes('formatter')) return 'formatter_error';
    return 'other';
  }
}
