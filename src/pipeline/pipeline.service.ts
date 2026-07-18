// src/pipeline/pipeline.service.ts

import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { CurationGateService } from '../curation/curation-gate.service';
import { CurationService } from '../curation/curation.service';
import { DealScoreService } from '../deal-score/deal-score.service';
import type {
  PriceAnalytics,
  PriceObservation,
  ScoredDeal,
} from '../deal-score/types';
import { MercadoLivreService } from '../mercado-livre/ml.service';
import { SEND_DEAL_QUEUE_TOKEN } from '../queue/queue.module';
import type { SendJob, TrustBadge } from '../queue/queue.types';
import {
  EnrichedDeal,
  keyToString,
  RawDeal,
  SourceId,
} from '../sources/source.port';
import { SourceRegistry } from '../sources/source-registry.service';
import {
  PRICE_SCRAPER_PORT,
  type PriceScraperPort,
} from '../pricing/price-scraper.port';
import type { PriceView } from '../pricing/price-view';
import { CouponService } from '../coupon/coupon.service';
import type { CouponView } from '../coupon/coupon.types';
import { couponViewFromCuratorEdit } from '../shared/curator-edits';
import type { CopyVariant } from '../shared/variant';
import { TargetsService } from '../whatsapp/targets.service';
import { WhatsappService } from '../whatsapp/wa.service';
import { FormatterService } from './formatter.service';

export interface EnqueueResult {
  enqueued: number;
  targets: number;
  topScore: number | null;
}

export interface EnqueueOptions {
  /** Urgent send: job jumps the queue (LIFO) and carries the urgent flag. */
  urgent?: boolean;
  /**
   * Suffix the coalescing jobId with a timestamp so a completed job for the
   * same (deal, target) can't swallow this enqueue — required for urgent
   * sends and curator dedup overrides (human said "send", so send).
   */
  uniqueJobId?: boolean;
}

@Injectable()
export class PipelineService {
  private readonly logger = new Logger(PipelineService.name);

  constructor(
    private readonly ml: MercadoLivreService,
    private readonly wa: WhatsappService,
    private readonly formatter: FormatterService,
    private readonly config: ConfigService,
    private readonly curation: CurationService,
    private readonly gate: CurationGateService,
    private readonly registry: SourceRegistry,
    private readonly dealScore: DealScoreService,
    private readonly targets: TargetsService,
    @Inject(SEND_DEAL_QUEUE_TOKEN)
    private readonly sendQueue: Queue<SendJob>,
    @Inject(PRICE_SCRAPER_PORT)
    private readonly priceScraper: PriceScraperPort,
    private readonly coupons: CouponService,
  ) {}

  async collectScored(sourceId: SourceId): Promise<ScoredDeal[]> {
    const source = this.registry.getById(sourceId);
    const raws = await source.discover();
    return this.scorePipeline(source, raws);
  }

  async collectScoredOne(sourceId: SourceId): Promise<ScoredDeal[]> {
    const source = this.registry.getById(sourceId);
    const raws = await source.discoverOne();
    return this.scorePipeline(source, raws);
  }

  async collectAllScored(): Promise<ScoredDeal[]> {
    const all: ScoredDeal[] = [];
    for (const source of this.registry.getAll()) {
      try {
        const raws = await source.discover();
        const scored = await this.scorePipeline(source, raws);
        all.push(...scored);
      } catch (err) {
        this.logger.error(
          `collectAllScored source=${source.id} failed: ${(err as Error).message}`,
        );
      }
    }
    all.sort((a, b) => b.score - a.score);
    return all;
  }

  private async scorePipeline(
    source: {
      id: SourceId;
      enrichMany: (raws: RawDeal[]) => Promise<EnrichedDeal[]>;
    },
    rawDeals: RawDeal[],
  ): Promise<ScoredDeal[]> {
    const scoreMin = Number(this.config.get<string>('DEAL_SCORE_MIN', '75'));
    const enrichTopN = Number(
      this.config.get<string>('DEAL_ENRICH_TOP_N', '10'),
    );

    const survivors: RawDeal[] = [];
    for (const raw of rawDeals) {
      // Screen BEFORE recording: an observation captured in this tick must
      // not influence this same tick's screen decision. On a cold start the
      // just-recorded promo price became the median itself, so isFakeDiscount
      // saw "price >= median*threshold" and rejected the very deal that
      // created the observation (false negative). Recording still happens for
      // every raw deal — screen rejects included — so history keeps building.
      const passedScreen = await this.gate.screenRaw(raw);
      await this.curation.record(keyToString(raw.key), raw.priceCents);
      if (!passedScreen) continue;
      survivors.push(raw);
    }

    if (survivors.length === 0) {
      this.logger.log(
        `scorePipeline ${source.id} - raw=${rawDeals.length} survivors=0`,
      );
      return [];
    }

    const preScoredAll = survivors
      .map((r) => ({ raw: r, pre: this.prescore(r) }))
      .sort((a, b) => b.pre - a.pre);
    const preScored = preScoredAll.slice(0, enrichTopN).map((x) => x.raw);
    await this.gate.recordPrescoreCut(
      preScoredAll.slice(enrichTopN).map((x) => x.raw),
    );

    const enriched = await source.enrichMany(preScored);

    const scored: ScoredDeal[] = [];
    for (const e of enriched) {
      const keyStr = keyToString(e.key);
      const analytics = this.curation.getAnalytics(keyStr);
      const observations = this.curation.getObservations(keyStr);
      const base = this.dealScore.computeWithObservations(
        e,
        analytics,
        observations,
      );
      scored.push(
        await this.applyCouponBoost(base, e, analytics, observations),
      );
    }

    const passing = scored.filter((s) => s.score >= scoreMin);
    passing.sort((a, b) => b.score - a.score);

    for (const s of scored) {
      if (s.score < scoreMin) await this.gate.recordScoreReject(s);
    }

    this.logger.log(
      `scorePipeline ${source.id} - raw=${rawDeals.length} survivors=${survivors.length} ` +
        `enriched=${enriched.length} passing=${passing.length}`,
    );

    return passing;
  }

  /**
   * Coupon-aware score: a deal that only becomes good WITH its coupon must
   * still be able to pass DEAL_SCORE_MIN. Resolves the deal's coupon and,
   * when it yields a concrete final price (mode 'PRICE'), re-scores against
   * that effective price. The returned ScoredDeal keeps the ORIGINAL deal
   * object — price history, gate audit rows and the published message must
   * all keep the BASE price (a couponed price would contaminate the price
   * series). The improvement lands as one explicit `coupon_boost` factor
   * (value = rawScore delta) so factors keep summing to rawScore and the
   * decision stays auditable.
   *
   * enqueueScored re-resolves the coupon later ON PURPOSE: the dispatch path
   * first corrects the price with a live page scrape, and the coupon line
   * shown to the user must be computed against that corrected price.
   */
  // TODO(coupon-effective-price): gate.screenRaw (dedup / fake-discount) runs
  // on the BASE price only. If the gate ever grows a "repost when the price
  // dropped" compare, it should compare against the coupon EFFECTIVE price
  // resolved here, not the base price. (curation-gate.service.ts is owned by
  // another agent — flagging here instead of editing it.)
  private async applyCouponBoost(
    base: ScoredDeal,
    deal: EnrichedDeal,
    analytics: PriceAnalytics,
    observations: PriceObservation[],
  ): Promise<ScoredDeal> {
    let coupon: CouponView | null = null;
    try {
      coupon = await this.coupons.resolveForDeal(deal, deal.raw.priceCents);
    } catch (err) {
      this.logger.warn(
        `coupon resolve (score) failed for ${keyToString(deal.key)}: ${(err as Error).message}`,
      );
    }
    if (
      !coupon ||
      coupon.mode !== 'PRICE' ||
      coupon.finalCents == null ||
      coupon.finalCents >= deal.raw.priceCents
    ) {
      return base;
    }

    const effectivePriceCents = coupon.finalCents;
    const effRaw: RawDeal = { ...deal.raw, priceCents: effectivePriceCents };
    if (
      deal.raw.originalPriceCents != null &&
      deal.raw.originalPriceCents > 0
    ) {
      effRaw.discountPercent = Math.round(
        (1 - effectivePriceCents / deal.raw.originalPriceCents) * 100,
      );
    }
    const eff = this.dealScore.computeWithObservations(
      { ...deal, raw: effRaw },
      analytics,
      observations,
    );
    const boost = eff.rawScore - base.rawScore;
    if (boost <= 0) return base;

    return {
      ...eff,
      deal, // keep the base-price deal downstream
      factors: { ...base.factors, coupon_boost: boost },
      reasons: [
        ...base.reasons,
        {
          code: 'coupon_boost',
          weight: boost,
          message: `Cupom ${coupon.code} (${coupon.discountLabel}) melhora o preço efetivo`,
        },
      ],
      penalties: base.penalties,
    };
  }

  /**
   * Enqueue approved deals per active target, honoring a per-channel cap:
   * MAX_DEALS_PER_RUN_WA for 'wa' targets, MAX_DEALS_PER_RUN_TELEGRAM for
   * 'telegram' targets. `overrideMax` (manual /pipeline/run) caps both.
   * The gate returns deals sorted by score desc, so slicing by index keeps
   * the best deals on every channel.
   *
   * Falls back to `WA_TARGET_JID` when the TargetsService registry is empty
   * so single-target installs keep working without DB seeding.
   */
  async enqueueScored(
    scored: ScoredDeal[],
    overrideMax?: number,
    opts?: EnqueueOptions,
  ): Promise<EnqueueResult> {
    const num = (k: string, def: number) =>
      Number(this.config.get<string>(k, String(def)));
    const waCap = overrideMax ?? num('MAX_DEALS_PER_RUN_WA', 4);
    const tgCap = overrideMax ?? num('MAX_DEALS_PER_RUN_TELEGRAM', 10);
    const digestSize = Math.max(1, num('WA_DIGEST_SIZE', 4));

    const selected = await this.gate.selectForDispatch(
      scored,
      Math.max(waCap, tgCap),
    );
    if (selected.length === 0) {
      return { enqueued: 0, targets: 0, topScore: null };
    }

    let activeTargets = await this.targets.getActiveTargets();
    if (activeTargets.length === 0) {
      const fallback = this.config.get<string>('WA_TARGET_JID', '');
      if (fallback) {
        activeTargets = [
          {
            jid: fallback,
            name: 'env:WA_TARGET_JID',
            active: true,
            channel: 'wa',
          },
        ];
      }
    }
    if (activeTargets.length === 0) {
      throw new Error(
        'No active targets and WA_TARGET_JID unset — nothing to publish',
      );
    }

    const trustBadgeEnabled =
      this.config.get<string>('TRUST_BADGE_ENABLED', 'true') !== 'false';
    const waTargets = activeTargets.filter((t) => t.channel !== 'telegram');
    const tgTargets = activeTargets.filter((t) => t.channel === 'telegram');

    let enqueued = 0;
    const topScore = selected[0]?.scored.score ?? null;
    // catalogKey -> deal aprovado + flag "chegou em alguma fila"
    const posted = new Map<
      string,
      { sd: ScoredDeal; variant: CopyVariant; sent: boolean }
    >();
    for (const { scored: sd, variant } of selected) {
      posted.set(keyToString(sd.deal.key), { sd, variant, sent: false });
    }

    // Scrape the real displayed price (Pix + no-interest installments) once per
    // approved deal, then correct the deal's price fields so the message shows
    // the same number as the site. Scrape failure keeps the API price.
    // Scrapes run through a small hand-rolled worker pool (SCRAPE_CONCURRENCY,
    // default 2); results land in index-aligned slots so result-to-deal
    // association and the enqueue order below stay untouched.
    const priceViews = new Map<string, PriceView>();
    const scrapeLimit = Math.max(1, num('SCRAPE_CONCURRENCY', 2));
    const scrapeResults: Array<PriceView | null> = new Array<PriceView | null>(
      selected.length,
    ).fill(null);
    let nextScrape = 0;
    const scrapeWorker = async (): Promise<void> => {
      for (;;) {
        const i = nextScrape++;
        if (i >= selected.length) return;
        const sd = selected[i].scored;
        // A curator-edited price was just read off the product page by a
        // human (approval panel) — it beats the scraper. Skip the scrape so
        // no PriceView overrides the edited value downstream.
        if (sd.curatorEdits?.priceCents != null) continue;
        try {
          scrapeResults[i] = await this.priceScraper.scrapePriceView(
            sd.deal.raw.permalink,
          );
        } catch (err) {
          this.logger.warn(
            `price scrape failed for ${keyToString(sd.deal.key)}: ${(err as Error).message}`,
          );
        }
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(scrapeLimit, selected.length) },
        scrapeWorker,
      ),
    );
    for (let i = 0; i < selected.length; i++) {
      const view = scrapeResults[i];
      if (!view) continue;
      this.applyPriceView(selected[i].scored, view);
      priceViews.set(keyToString(selected[i].scored.deal.key), view);
    }

    // Resolve one matching coupon per approved deal (format-only). Uses the
    // corrected (post-scrape) priceCents so the gate's minimum test and the
    // final-price math match the number shown to the user.
    const couponViews = new Map<string, CouponView>();
    for (const { scored: sd } of selected) {
      // Curator-edited coupon (approval panel) replaces the resolver.
      if (sd.curatorEdits?.coupon) {
        couponViews.set(
          keyToString(sd.deal.key),
          couponViewFromCuratorEdit(
            sd.curatorEdits.coupon,
            sd.deal.raw.priceCents,
          ),
        );
        continue;
      }
      try {
        const cv = await this.coupons.resolveForDeal(
          sd.deal,
          sd.deal.raw.priceCents,
        );
        if (cv) couponViews.set(keyToString(sd.deal.key), cv);
      } catch (err) {
        this.logger.warn(
          `coupon resolve failed for ${keyToString(sd.deal.key)}: ${(err as Error).message}`,
        );
      }
    }

    const addSingle = async (
      sd: ScoredDeal,
      variant: CopyVariant,
      target: { jid: string; channel?: 'wa' | 'telegram' },
    ) => {
      const catalogKey = keyToString(sd.deal.key);

      let trustBadge: TrustBadge | undefined;
      if (trustBadgeEnabled) {
        const label = this.curation.getLowestPriceBadge(
          catalogKey,
          sd.deal.raw.priceCents,
        );
        if (label) {
          trustBadge = {
            label,
            monitoredDays: this.curation.historyDays(catalogKey),
          };
        }
      }

      // jobId = `<key>_<jid>` so re-enqueues for the same deal+target
      // coalesce while waiting in the queue. BullMQ only allows a custom
      // jobId to contain ':' when it splits into exactly 3 segments (legacy
      // repeatable-job compat) — catalogKey/jid can contain ':' themselves,
      // so avoid it entirely instead of relying on the segment count.
      // uniqueJobId (urgent / dedup override) appends a timestamp so the
      // completed-job coalesce can't swallow a human-decided resend.
      let jobId = `${catalogKey}_${target.jid}`.replace(/:/g, '_');
      if (opts?.uniqueJobId) jobId += `_${Date.now()}`;
      try {
        await this.sendQueue.add(
          'send-deal',
          {
            targetJid: target.jid,
            channel: target.channel,
            catalogKey,
            scored: sd,
            variant,
            trustBadge,
            priceView: priceViews.get(catalogKey),
            couponView: couponViews.get(catalogKey),
            ...(opts?.urgent ? { urgent: true } : {}),
          },
          // LIFO puts the urgent job at the head of the wait list — it is
          // picked next, ahead of everything already queued.
          { jobId, ...(opts?.urgent ? { lifo: true } : {}) },
        );
        enqueued++;
        posted.get(catalogKey)!.sent = true;
      } catch (err) {
        this.logger.error(`enqueue ${jobId} failed: ${(err as Error).message}`);
      }
    };

    // Telegram: 1 job por (deal × target), como sempre.
    for (const { scored: sd, variant } of selected.slice(0, tgCap)) {
      for (const target of tgTargets) await addSingle(sd, variant, target);
    }

    // WhatsApp: chunks de até WA_DIGEST_SIZE viram 1 mensagem; chunk de 1
    // continua job individual (digest de uma oferta não faz sentido).
    const waSelected = selected.slice(0, waCap);
    for (let c = 0; c < waSelected.length; c += digestSize) {
      const chunk = waSelected.slice(c, c + digestSize);
      if (chunk.length === 1) {
        for (const target of waTargets) {
          await addSingle(chunk[0].scored, chunk[0].variant, target);
        }
        continue;
      }
      const keys = chunk.map(({ scored: sd }) => keyToString(sd.deal.key));
      const digestId = `dg-${Date.now()}-${c / digestSize}`;
      for (const target of waTargets) {
        const jobId = `digest_${target.jid}_${keys.join('+')}`.replace(
          /:/g,
          '_',
        );
        try {
          await this.sendQueue.add(
            'send-digest',
            {
              targetJid: target.jid,
              channel: 'wa',
              digestId,
              deals: chunk.map(({ scored: sd, variant }) => ({
                catalogKey: keyToString(sd.deal.key),
                variant,
                scored: sd,
                priceView: priceViews.get(keyToString(sd.deal.key)),
                couponView: couponViews.get(keyToString(sd.deal.key)),
              })),
            },
            { jobId },
          );
          enqueued++;
          for (const k of keys) posted.get(k)!.sent = true;
        } catch (err) {
          this.logger.error(
            `enqueue ${jobId} failed: ${(err as Error).message}`,
          );
        }
      }
    }

    for (const { sd, variant, sent } of posted.values()) {
      if (sent) await this.gate.recordPosted(sd, variant);
    }

    this.logger.log(
      `enqueueScored: deals=${selected.length} targets=${activeTargets.length} enqueued=${enqueued}`,
    );
    return { enqueued, targets: activeTargets.length, topScore };
  }

  /**
   * Overwrite the deal's price fields with the scraped values so the published
   * message (and the posted-decision audit) reflect the real site price rather
   * than the stale/base API price. Only non-null scraped fields overwrite.
   */
  private applyPriceView(sd: ScoredDeal, view: PriceView): void {
    const raw = sd.deal.raw;
    raw.priceCents = view.priceCents;
    if (view.originalPriceCents != null) {
      raw.originalPriceCents = view.originalPriceCents;
    }
    if (view.discountPercent != null) {
      raw.discountPercent = view.discountPercent;
    }
  }

  private prescore(raw: RawDeal): number {
    const keyStr = keyToString(raw.key);
    const analytics = this.curation.getAnalytics(keyStr);
    let s = 0;
    s += Math.min(20, Math.max(0, raw.discountPercent - 25));
    if (analytics.median30d != null && raw.priceCents < analytics.median30d) {
      const ratio = 1 - raw.priceCents / analytics.median30d;
      s += Math.min(25, ratio * 100);
    }
    if (analytics.min30d != null && raw.priceCents <= analytics.min30d) s += 15;
    else if (analytics.min14d != null && raw.priceCents <= analytics.min14d)
      s += 10;
    else if (analytics.min7d != null && raw.priceCents <= analytics.min7d)
      s += 5;
    if (analytics.distinctDays < 7) s -= 25;
    return s;
  }

  async runOnce(opts?: { sourceId?: SourceId; max?: number }) {
    const sourceId: SourceId = opts?.sourceId ?? 'ml';

    const scored = await this.collectScored(sourceId);
    const result = await this.enqueueScored(scored, opts?.max);
    return {
      enqueued: result.enqueued,
      targets: result.targets,
      scored: scored.length,
      topScore: result.topScore,
      sourceId,
    };
  }

  async preview(opts?: {
    categories?: string[];
    minDiscount?: number;
    perCategory?: number;
  }) {
    const DEFAULT_CATEGORIES = [
      'MLB1648',
      'MLB1000',
      'MLB1051',
      'MLB5726',
      'MLB1276',
      'MLB1246',
      'MLB1144',
      'MLB1430',
    ];
    const categories = opts?.categories?.length
      ? opts.categories
      : DEFAULT_CATEGORIES;
    const minDiscount =
      opts?.minDiscount ??
      Number(this.config.get<string>('ML_MIN_DISCOUNT', '25'));
    const perCategory = opts?.perCategory ?? 5;

    const results: Record<
      string,
      {
        permalink: string;
        title: string;
        price: number;
        discountPercent: number;
      }[]
    > = {};
    const flatUrls: string[] = [];
    for (const cat of categories) {
      const deals = await this.ml.getDealsFromHighlights({
        category: cat,
        minDiscount,
        max: perCategory,
      });
      results[cat] = deals.map((d) => ({
        permalink: d.permalink,
        title: d.title,
        price: d.price,
        discountPercent: d.discountPercent,
      }));
      for (const d of deals) flatUrls.push(d.permalink);
    }
    return {
      minDiscount,
      perCategory,
      totalUrls: flatUrls.length,
      pasteIntoAffiliatePanel: flatUrls.join('\n'),
      byCategory: results,
    };
  }
}
