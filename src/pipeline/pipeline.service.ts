// src/pipeline/pipeline.service.ts

import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { CurationService } from '../curation/curation.service';
import { DealScoreService } from '../deal-score/deal-score.service';
import type { ScoredDeal } from '../deal-score/types';
import { DedupService } from '../dedup/dedup.service';
import { MercadoLivreService } from '../mercado-livre/ml.service';
import { CountersService } from '../metrics/counters.service';
import { SEND_DEAL_QUEUE_TOKEN } from '../queue/queue.module';
import type { SendDealJob } from '../queue/queue.types';
import {
  EnrichedDeal,
  keyToString,
  RawDeal,
  SourceId,
} from '../sources/source.port';
import { SourceRegistry } from '../sources/source-registry.service';
import { TargetsService } from '../whatsapp/targets.service';
import { WhatsappService } from '../whatsapp/wa.service';
import { FormatterService } from './formatter.service';

@Injectable()
export class PipelineService {
  private readonly logger = new Logger(PipelineService.name);

  constructor(
    private readonly ml: MercadoLivreService,
    private readonly wa: WhatsappService,
    private readonly formatter: FormatterService,
    private readonly config: ConfigService,
    private readonly dedup: DedupService,
    private readonly curation: CurationService,
    private readonly registry: SourceRegistry,
    private readonly dealScore: DealScoreService,
    private readonly targets: TargetsService,
    private readonly counters: CountersService,
    @Inject(SEND_DEAL_QUEUE_TOKEN)
    private readonly sendQueue: Queue<SendDealJob>,
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
    const windowDays = Number(
      this.config.get<string>('DEDUP_WINDOW_DAYS', '7'),
    );
    const scoreMin = Number(this.config.get<string>('DEAL_SCORE_MIN', '75'));
    const enrichTopN = Number(
      this.config.get<string>('DEAL_ENRICH_TOP_N', '10'),
    );

    const survivors: RawDeal[] = [];
    for (const raw of rawDeals) {
      const keyStr = keyToString(raw.key);
      await this.curation.record(keyStr, raw.priceCents);
      if (await this.dedup.wasRecentlyPosted(keyStr, windowDays)) {
        this.counters.dedupSkip.inc();
        continue;
      }
      if (this.curation.isFakeDiscount(keyStr, raw.priceCents)) continue;
      survivors.push(raw);
    }

    if (survivors.length === 0) {
      this.logger.log(
        `scorePipeline ${source.id} - raw=${rawDeals.length} survivors=0`,
      );
      return [];
    }

    const preScored = survivors
      .map((r) => ({ raw: r, pre: this.prescore(r) }))
      .sort((a, b) => b.pre - a.pre)
      .slice(0, enrichTopN)
      .map((x) => x.raw);

    const enriched = await source.enrichMany(preScored);

    const scored: ScoredDeal[] = enriched.map((e) => {
      const keyStr = keyToString(e.key);
      const analytics = this.curation.getAnalytics(keyStr);
      const observations = this.curation.getObservations(keyStr);
      return this.dealScore.computeWithObservations(e, analytics, observations);
    });

    const passing = scored.filter((s) => s.score >= scoreMin);
    passing.sort((a, b) => b.score - a.score);

    this.logger.log(
      `scorePipeline ${source.id} - raw=${rawDeals.length} survivors=${survivors.length} ` +
        `enriched=${enriched.length} passing=${passing.length}`,
    );

    return passing;
  }

  /**
   * Enqueue the top `max` scored deals for every active target. One job per
   * (deal × target) so a multi-broadcast publish doesn't block on the
   * slowest send. The BullMQ worker (`SendDealWorker`) handles retries,
   * dedup marking, and rate-limit backoff.
   *
   * Falls back to `WA_TARGET_JID` when the TargetsService registry is empty
   * so single-target installs keep working without DB seeding.
   */
  async enqueueScored(
    scored: ScoredDeal[],
    max: number,
  ): Promise<{
    enqueued: number;
    targets: number;
    topScore: number | null;
  }> {
    const sorted = [...scored].sort((a, b) => b.score - a.score).slice(0, max);
    if (sorted.length === 0) {
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

    let enqueued = 0;
    let topScore: number | null = null;
    for (const sd of sorted) {
      if (topScore === null) topScore = sd.score;
      const catalogKey = keyToString(sd.deal.key);
      for (const target of activeTargets) {
        // jobId = `<key>:<jid>` so re-enqueues for the same deal+target
        // coalesce while waiting in the queue.
        const jobId = `${catalogKey}:${target.jid}`;
        try {
          await this.sendQueue.add(
            'send-deal',
            {
              targetJid: target.jid,
              channel: target.channel,
              catalogKey,
              scored: sd,
            },
            { jobId },
          );
          enqueued++;
        } catch (err) {
          this.logger.error(
            `enqueue ${jobId} failed: ${(err as Error).message}`,
          );
        }
      }
    }

    this.logger.log(
      `enqueueScored: deals=${sorted.length} targets=${activeTargets.length} enqueued=${enqueued}`,
    );
    return { enqueued, targets: activeTargets.length, topScore };
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
    const max =
      opts?.max ?? Number(this.config.get<string>('MAX_DEALS_PER_RUN', '3'));

    const scored = await this.collectScored(sourceId);
    const result = await this.enqueueScored(scored, max);
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
