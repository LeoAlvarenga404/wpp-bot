import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CurationService } from '../curation/curation.service';
import { DealScoreService } from '../deal-score/deal-score.service';
import type { ScoredDeal } from '../deal-score/types';
import { DedupService } from '../dedup/dedup.service';
import { EnrichmentService } from '../enrichment/enrichment.service';
import { MercadoLivreService } from '../mercado-livre/ml.service';
import { DealItem } from '../mercado-livre/types';
import { WhatsappService } from '../whatsapp/wa.service';
import { FormatterService } from './formatter.service';

const DEFAULT_CATEGORIES = [
  'MLB1648', 'MLB1000', 'MLB1051', 'MLB5726',
  'MLB1276', 'MLB1246', 'MLB1144', 'MLB1430',
];

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
    private readonly enrichment: EnrichmentService,
    private readonly dealScore: DealScoreService,
  ) {}

  /**
   * Collect candidate deals for `category`, run pre-score → enrich → full score → filter.
   * Returns ScoredDeals with score >= DEAL_SCORE_MIN, sorted desc.
   * Does NOT dispatch.
   */
  async collectScored(
    category: string,
    opts: { minDiscount: number; enrichTopN: number },
  ): Promise<ScoredDeal[]> {
    const windowDays = Number(this.config.get<string>('DEDUP_WINDOW_DAYS', '7'));
    const scoreMin = Number(this.config.get<string>('DEAL_SCORE_MIN', '75'));
    const minDiscountNoHistory = Number(
      this.config.get<string>('DEAL_SCORE_MIN_DISCOUNT_NO_HISTORY', '40'),
    );

    const rawDeals = await this.ml.getDealsFromHighlights({
      category,
      minDiscount: opts.minDiscount,
      max: opts.enrichTopN * 3,
    });

    const survivors: DealItem[] = [];
    for (const deal of rawDeals) {
      const priceCents = Math.round(deal.price * 100);
      // 1. Record FIRST — always, even if we skip below
      await this.curation.record(deal.catalogId, priceCents);
      // 2. Dedup
      if (await this.dedup.wasRecentlyPosted(deal.catalogId, windowDays)) continue;
      // 3. Hard curation gate
      if (this.curation.isFakeDiscount(deal.catalogId, priceCents)) continue;
      survivors.push(deal);
    }

    if (survivors.length === 0) {
      this.logger.log(
        `collectScored ${category} — raw=${rawDeals.length} survivors=0 enriched=0 scored=0 passing=0`,
      );
      return [];
    }

    // 4. Pre-score (cheap) and take top-N
    const preScored = survivors
      .map((d) => ({ deal: d, pre: this.prescore(d) }))
      .sort((a, b) => b.pre - a.pre)
      .slice(0, opts.enrichTopN);

    // 5. Enrich
    const enriched = await this.enrichment.enrichMany(preScored.map((x) => x.deal));

    // 6. Full score with real observations
    const scored: ScoredDeal[] = enriched.map((e) => {
      const observations = this.curation.getObservations(e.catalogId);
      const analytics = this.curation.getAnalytics(e.catalogId);
      return this.dealScore.computeWithObservations(e, analytics, observations);
    });

    // 7. Filter
    const passing = scored.filter((s) => {
      if (s.score < scoreMin) return false;
      // Without history, demand higher raw discount
      if (s.deal.seller === null && s.deal.discountPercent < minDiscountNoHistory) {
        const analytics = this.curation.getAnalytics(s.deal.catalogId);
        if (analytics.distinctDays === 0) return false;
      }
      return true;
    });

    passing.sort((a, b) => b.score - a.score);

    this.logger.log(
      `collectScored ${category} — raw=${rawDeals.length} survivors=${survivors.length} ` +
      `enriched=${enriched.length} scored=${scored.length} passing=${passing.length}`,
    );

    return passing;
  }

  /**
   * Dispatch a sorted list of ScoredDeals via WhatsApp, capped at `max`.
   */
  async dispatchScored(
    scored: ScoredDeal[],
    max: number,
  ): Promise<{ sent: number; failed: number; topScore: number | null }> {
    const targetJid = this.config.get<string>('WA_TARGET_JID', '');
    if (!targetJid) throw new Error('WA_TARGET_JID not set in .env');
    if (!this.wa.isReady()) throw new Error('WhatsApp not ready — scan QR first');

    const sorted = [...scored].sort((a, b) => b.score - a.score).slice(0, max);
    let sent = 0;
    let failed = 0;
    let topScore: number | null = null;

    for (const sd of sorted) {
      if (topScore === null) topScore = sd.score;
      try {
        const { caption, imageUrl } = await this.formatter.formatScored(sd);
        if (imageUrl) await this.wa.sendImage(targetJid, imageUrl, caption);
        else await this.wa.sendText(targetJid, caption);
        await this.dedup.markPosted(sd.deal.catalogId);
        this.logger.log(
          `dispatch ${sd.deal.catalogId} → WA sent ok (level=${sd.level}, score=${sd.score})`,
        );
        sent++;
      } catch (err) {
        failed++;
        this.logger.error(
          `dispatch ${sd.deal.catalogId} failed: ${(err as Error).message}`,
        );
      }
      await this.sleep(2000);
    }

    return { sent, failed, topScore };
  }

  /**
   * Cheap pre-score using only fields already on DealItem + curation analytics.
   * Used to budget enrichment calls to top-N candidates.
   */
  private prescore(deal: DealItem): number {
    const priceCents = Math.round(deal.price * 100);
    const analytics = this.curation.getAnalytics(deal.catalogId);
    let s = 0;
    s += Math.min(20, Math.max(0, deal.discountPercent - 25));
    if (analytics.median30d != null && priceCents < analytics.median30d) {
      const ratio = 1 - priceCents / analytics.median30d;
      s += Math.min(25, ratio * 100);
    }
    if (analytics.min30d != null && priceCents <= analytics.min30d) s += 15;
    else if (analytics.min14d != null && priceCents <= analytics.min14d) s += 10;
    else if (analytics.min7d != null && priceCents <= analytics.min7d) s += 5;
    if (deal.freeShipping) s += 5;
    if (analytics.distinctDays < 7) s -= 25;
    return s;
  }

  async runOnce(opts?: {
    category?: string;
    minDiscount?: number;
    max?: number;
  }) {
    const category =
      opts?.category ?? this.config.get<string>('ML_CATEGORY', 'MLB1648');
    const minDiscount =
      opts?.minDiscount ??
      Number(this.config.get<string>('ML_MIN_DISCOUNT', '25'));
    const enrichTopN = Number(this.config.get<string>('DEAL_ENRICH_TOP_N', '10'));
    const max = opts?.max ?? Number(this.config.get<string>('MAX_DEALS_PER_RUN', '3'));

    const scored = await this.collectScored(category, { minDiscount, enrichTopN });
    const dispatch = await this.dispatchScored(scored, max);
    return {
      sent: dispatch.sent,
      failed: dispatch.failed,
      scored: scored.length,
      topScore: dispatch.topScore,
      category,
      minDiscount,
    };
  }

  async preview(opts?: {
    categories?: string[];
    minDiscount?: number;
    perCategory?: number;
  }) {
    const categories = opts?.categories?.length ? opts.categories : DEFAULT_CATEGORIES;
    const minDiscount =
      opts?.minDiscount ??
      Number(this.config.get<string>('ML_MIN_DISCOUNT', '25'));
    const perCategory = opts?.perCategory ?? 5;

    const results: Record<string, { permalink: string; title: string; price: number; discountPercent: number }[]> = {};
    const flatUrls: string[] = [];

    for (const cat of categories) {
      const deals = await this.ml.getDealsFromHighlights({ category: cat, minDiscount, max: perCategory });
      results[cat] = deals.map((d: DealItem) => ({
        permalink: d.permalink, title: d.title, price: d.price, discountPercent: d.discountPercent,
      }));
      for (const d of deals) flatUrls.push(d.permalink);
    }

    return {
      minDiscount, perCategory, totalUrls: flatUrls.length,
      pasteIntoAffiliatePanel: flatUrls.join('\n'),
      byCategory: results,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
