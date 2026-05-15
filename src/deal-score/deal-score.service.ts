import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnrichedDeal } from '../sources/source.port';
import { detectPriceRaiseBeforeDiscount } from './price-analytics';
import type {
  DealLevel,
  PriceAnalytics,
  ScoreReason,
  ScoredDeal,
} from './types';

interface Weights {
  discountMax: number;
  belowMedianMax: number;
  lowest30d: number;
  lowest14d: number;
  lowest7d: number;
  officialStore: number;
  sellerReputationMax: number;
  freeShipping: number;
  installmentsNoInterest: number;
  highSoldQtyMax: number;
  priceStability: number;
  priceRaisePenalty: number;
  usedPenalty: number;
  discountFromOriginalOnly: number;
  aboveMedianPenalty: number;
  unknownSeller: number;
  insufficientHistoryPenalty: number;
}

interface ScoreThresholds {
  min: number;
  top: number;
  super: number;
  minHistoryDays: number;
}

interface PriceRaiseOpts {
  peakWindowDays: number;
  baselineWindowDays: number;
  peakRatio: number;
  currentBaselineRatio: number;
}

@Injectable()
export class DealScoreService {
  private readonly logger = new Logger(DealScoreService.name);
  private readonly w: Weights;
  private readonly t: ScoreThresholds;
  private readonly priceRaiseOpts: PriceRaiseOpts;

  constructor(private readonly config: ConfigService) {
    const num = (k: string, def: number) =>
      Number(this.config.get<string>(k, String(def)));

    this.w = {
      discountMax: num('DEAL_SCORE_W_DISCOUNT_MAX', 20),
      belowMedianMax: num('DEAL_SCORE_W_BELOW_MEDIAN_MAX', 25),
      lowest30d: num('DEAL_SCORE_W_LOWEST_30D', 15),
      lowest14d: num('DEAL_SCORE_W_LOWEST_14D', 10),
      lowest7d: num('DEAL_SCORE_W_LOWEST_7D', 5),
      officialStore: num('DEAL_SCORE_W_OFFICIAL_STORE', 10),
      sellerReputationMax: num('DEAL_SCORE_W_SELLER_REPUTATION_MAX', 10),
      freeShipping: num('DEAL_SCORE_W_FREE_SHIPPING', 5),
      installmentsNoInterest: num('DEAL_SCORE_W_INSTALLMENTS_NO_INTEREST', 5),
      highSoldQtyMax: num('DEAL_SCORE_W_HIGH_SOLD_QTY_MAX', 5),
      priceStability: num('DEAL_SCORE_W_PRICE_STABILITY', 5),
      priceRaisePenalty: num('DEAL_SCORE_W_PRICE_RAISE_PENALTY', 30),
      usedPenalty: num('DEAL_SCORE_W_USED_PENALTY', 15),
      discountFromOriginalOnly: num('DEAL_SCORE_W_DISCOUNT_FROM_ORIGINAL_ONLY', 10),
      aboveMedianPenalty: num('DEAL_SCORE_W_ABOVE_MEDIAN_PENALTY', 10),
      unknownSeller: num('DEAL_SCORE_W_UNKNOWN_SELLER', 5),
      insufficientHistoryPenalty: num(
        'DEAL_SCORE_INSUFFICIENT_HISTORY_PENALTY',
        25,
      ),
    };

    this.t = {
      min: num('DEAL_SCORE_MIN', 75),
      top: num('DEAL_SCORE_TOP', 90),
      super: num('DEAL_SCORE_SUPER', 95),
      minHistoryDays: num('CURATION_MIN_HISTORY_DAYS', 7),
    };

    this.priceRaiseOpts = {
      peakWindowDays: num('PRICE_RAISE_PEAK_WINDOW_DAYS', 14),
      baselineWindowDays: num('PRICE_RAISE_BASELINE_WINDOW_DAYS', 30),
      peakRatio: num('PRICE_RAISE_PEAK_RATIO', 1.2),
      currentBaselineRatio: num('PRICE_RAISE_CURRENT_BASELINE_RATIO', 0.95),
    };
  }

  compute(
    deal: EnrichedDeal,
    analytics: PriceAnalytics,
    opts?: { now?: Date },
  ): ScoredDeal {
    const priceCents = deal.raw.priceCents;
    const factors: Record<string, number> = {};
    const reasons: ScoreReason[] = [];
    const penalties: ScoreReason[] = [];

    const add = (code: string, weight: number, message: string) => {
      factors[code] = weight;
      const reason: ScoreReason = { code, weight, message };
      if (weight >= 0) reasons.push(reason);
      else penalties.push(reason);
    };

    // 1. discount_percent
    const discountWeight = clamp(
      ((deal.raw.discountPercent - 25) / 25) * this.w.discountMax,
      0,
      this.w.discountMax,
    );
    if (discountWeight > 0) {
      add(
        'discount_percent',
        Math.round(discountWeight),
        `Desconto de ${deal.raw.discountPercent}% no Mercado Livre`,
      );
    }

    // 2. below_median_30d
    if (analytics.median30d != null && analytics.median30d > 0) {
      const ratio = 1 - priceCents / analytics.median30d;
      const w = clamp(ratio * 100, 0, this.w.belowMedianMax);
      if (w > 0) {
        add(
          'below_median_30d',
          Math.round(w),
          `${Math.round(ratio * 100)}% abaixo da mediana de 30 dias`,
        );
      } else if (priceCents > analytics.median30d) {
        add(
          'current_above_median_30d',
          -this.w.aboveMedianPenalty,
          'Preço atual acima da mediana de 30 dias',
        );
      }
    }

    // 3. lowest_price_*
    if (analytics.min30d != null && priceCents <= analytics.min30d) {
      add('lowest_price_30d', this.w.lowest30d, 'Menor preço dos últimos 30 dias');
    } else if (analytics.min14d != null && priceCents <= analytics.min14d) {
      add('lowest_price_14d', this.w.lowest14d, 'Menor preço dos últimos 14 dias');
    } else if (analytics.min7d != null && priceCents <= analytics.min7d) {
      add('lowest_price_7d', this.w.lowest7d, 'Menor preço dos últimos 7 dias');
    }

    // 4. official_store
    if (deal.signals.isVerifiedStore) {
      add('official_store', this.w.officialStore, 'Loja oficial');
    }

    // 5. seller_reputation
    if (deal.seller) {
      const map: Record<string, number> = {
        high: this.w.sellerReputationMax,
        medium: Math.round(this.w.sellerReputationMax * 0.3),
        low: -Math.round(this.w.sellerReputationMax * 1.5),
        unknown: 0,
      };
      const w = map[deal.seller.sellerTrust];
      if (typeof w === 'number' && w !== 0) {
        const label = w > 0 ? `Vendedor com boa reputação` : `Vendedor com reputação baixa`;
        add('seller_reputation', w, label);
      }
    } else {
      add('unknown_seller', -this.w.unknownSeller, 'Vendedor não identificado');
    }

    // 6. free_shipping
    if (deal.signals.freeShipping) {
      add('free_shipping', this.w.freeShipping, 'Frete grátis');
    }

    // 7. installments_no_interest
    if (deal.signals.installmentsNoInterest) {
      add('installments_no_interest', this.w.installmentsNoInterest, 'Parcelas sem juros');
    }

    // 8. high_sold_quantity
    const tierW: Record<string, number> = {
      high: this.w.highSoldQtyMax,
      mid: Math.round(this.w.highSoldQtyMax * 0.6),
      low: Math.round(this.w.highSoldQtyMax * 0.2),
      none: 0,
    };
    const soldW = tierW[deal.signals.volumeTier];
    if (soldW > 0) {
      const label =
        deal.signals.volumeTier === 'high' ? 'Muitas vendas' :
        deal.signals.volumeTier === 'mid'  ? 'Boa quantidade de vendas' :
        'Algumas vendas';
      add('high_sold_quantity', soldW, label);
    }

    // 9. price_stability
    if (analytics.median30d != null) {
      if (
        analytics.median14d != null &&
        Math.abs(analytics.median30d - analytics.median14d) / analytics.median30d < 0.05
      ) {
        add('price_stability', this.w.priceStability, 'Preço base estável');
      }
    }

    // 10. used_or_refurbished
    if (deal.condition === 'used' || deal.condition === 'refurbished') {
      add('used_or_refurbished', -this.w.usedPenalty, 'Produto não é novo');
    }

    // 11. price_raise_before_discount placeholder (computeWithObservations gives the real signal)
    // intentionally skipped in `compute()` — see `computeWithObservations`

    // 12. insufficient_history
    const insufficient = analytics.distinctDays < this.t.minHistoryDays;
    if (insufficient) {
      add(
        'insufficient_history',
        -this.w.insufficientHistoryPenalty,
        'Histórico de preço ainda limitado',
      );
    }

    // 13. discount_from_original_only
    if (analytics.distinctDays === 0 && (factors.discount_percent ?? 0) > 0) {
      const otherPositives = reasons.filter((r) => r.code !== 'discount_percent').length;
      if (otherPositives === 0) {
        add(
          'discount_from_original_only',
          -this.w.discountFromOriginalOnly,
          'Desconto apoiado apenas no preço original',
        );
      }
    }

    const rawScore = Object.values(factors).reduce((a, b) => a + b, 0);
    const score = clamp(rawScore, 0, 100);

    reasons.sort((a, b) => b.weight - a.weight);

    const level = this.deriveLevel(score, insufficient);

    return {
      deal,
      score,
      rawScore,
      level,
      reasons,
      penalties,
      factors,
    };
  }

  /**
   * Variant that uses real observations to compute the price-raise signal.
   * Pipeline must use this; standalone `compute()` skips the signal.
   */
  computeWithObservations(
    deal: EnrichedDeal,
    analytics: PriceAnalytics,
    observations: { priceCents: number; at: string }[],
    opts?: { now?: Date },
  ): ScoredDeal {
    const base = this.compute(deal, analytics, opts);
    const priceCents = deal.raw.priceCents;
    const raise = detectPriceRaiseBeforeDiscount(
      { observations, now: opts?.now },
      priceCents,
      this.priceRaiseOpts,
    );

    if (!raise.suspicious) return base;

    const penalty: ScoreReason = {
      code: 'price_raise_before_discount',
      weight: -this.w.priceRaisePenalty,
      message: raise.reason ?? 'Indício de preço inflado antes do desconto',
    };

    const penalties = [...base.penalties, penalty];
    const factors = { ...base.factors, price_raise_before_discount: penalty.weight };
    const rawScore = Object.values(factors).reduce((a, b) => a + b, 0);
    const score = clamp(rawScore, 0, 100);
    const insufficient = analytics.distinctDays < this.t.minHistoryDays;

    return {
      ...base,
      penalties,
      factors,
      rawScore,
      score,
      level: this.deriveLevel(score, insufficient),
    };
  }

  private deriveLevel(score: number, insufficientHistory: boolean): DealLevel {
    if (score < this.t.min) return 'rejected';
    let level: DealLevel;
    if (score >= this.t.super) level = 'super';
    else if (score >= this.t.top) level = 'top';
    else level = 'good';
    if (insufficientHistory && level === 'super') level = 'top';
    return level;
  }
}

function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}
