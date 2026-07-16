import { Injectable } from '@nestjs/common';
import type { EnrichedDeal } from '../sources/source.port';
import { computeCouponView } from './coupon-math';
import type { Coupon, CouponView } from './coupon.types';
import { CouponRepository } from './coupon.repository';

@Injectable()
export class CouponService {
  constructor(private readonly repo: CouponRepository) {}

  /** One coupon line for this deal, or null. ML-only in v1. */
  async resolveForDeal(
    deal: EnrichedDeal,
    priceCents: number,
    now: Date = new Date(),
  ): Promise<CouponView | null> {
    if (deal.key.source !== 'ml') return null;

    const sellerId = deal.seller?.externalSellerId ?? null;
    const productId = deal.key.externalId;
    const matches = await this.repo.findMatching(sellerId, productId, now);
    if (matches.length === 0) return null;

    const rank = (c: Coupon, v: CouponView): [number, number] => {
      const scopeRank = c.scope === 'PRODUCT' ? 1 : 0; // product wins
      const priceRank = v.mode === 'PRICE' ? -(v.finalCents ?? 0) : -Infinity;
      return [scopeRank, priceRank]; // higher is better
    };

    let best: CouponView | null = null;
    let bestKey: [number, number] = [-1, -Infinity];
    for (const c of matches) {
      const v = computeCouponView(c, priceCents, now);
      if (!v) continue;
      const k = rank(c, v);
      if (k[0] > bestKey[0] || (k[0] === bestKey[0] && k[1] > bestKey[1])) {
        best = v;
        bestKey = k;
      }
    }
    return best;
  }
}
