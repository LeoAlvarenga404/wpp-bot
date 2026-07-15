import type { PriceAnalytics, ScoredDeal } from '../deal-score/types';
import type { JudgeInput } from './judge.port';

export function buildJudgeInput(
  sd: ScoredDeal,
  analytics: PriceAnalytics,
): JudgeInput {
  const raw = sd.deal.raw;
  return {
    title: raw.title,
    priceCents: raw.priceCents,
    originalPriceCents: raw.originalPriceCents,
    discountPercent: raw.discountPercent,
    condition: sd.deal.condition,
    score: sd.score,
    level: sd.level,
    reasons: sd.reasons.map((r) => r.message),
    penalties: sd.penalties.map((p) => p.message),
    priceRaiseSuspicious: 'price_raise_before_discount' in sd.factors,
    analytics: {
      median30d: analytics.median30d,
      min30d: analytics.min30d,
      min14d: analytics.min14d,
      min7d: analytics.min7d,
      distinctDays: analytics.distinctDays,
      trend: analytics.trend,
    },
    seller: sd.deal.seller
      ? {
          trust: sd.deal.seller.sellerTrust,
          isVerifiedStore: sd.deal.seller.isVerifiedStore,
          displayName: sd.deal.seller.displayName,
        }
      : null,
    volumeTier: sd.deal.signals.volumeTier,
  };
}
