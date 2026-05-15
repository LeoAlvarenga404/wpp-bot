// src/deal-score/score-parity.spec.ts

import { ConfigService } from '@nestjs/config';
import { DealScoreService } from './deal-score.service';
import type { EnrichedDeal } from '../sources/source.port';
import type { PriceAnalytics } from './types';

const config = { get: (k: string, def?: string) => def } as unknown as ConfigService;
const svc = new DealScoreService(config);

const baseDeal = (over: Partial<EnrichedDeal> = {}): EnrichedDeal => ({
  key: { source: 'ml', externalId: 'MLB1' },
  source: 'ml',
  raw: {
    key: { source: 'ml', externalId: 'MLB1' },
    title: 'X',
    priceCents: 10000,
    originalPriceCents: 20000,
    discountPercent: 50,
    thumbnail: '',
    permalink: 'p',
    feedId: 'MLB1648',
  },
  seller: {
    externalSellerId: '1',
    displayName: 'S',
    sellerTrust: 'high',
    isVerifiedStore: true,
    ratingAverage: 0.9,
    fetchedAt: '2026-05-14T00:00:00.000Z',
  },
  condition: 'new',
  signals: {
    freeShipping: true,
    installmentsNoInterest: true,
    volumeTier: 'high',
    isVerifiedStore: true,
  },
  extras: {},
  ...over,
});

const fullAnalytics: PriceAnalytics = {
  median7d: 12000,
  median14d: 12000,
  median30d: 12000,
  min7d: 11000,
  min14d: 10500,
  min30d: 10000,
  distinctDays: 30,
  lastObservedBefore: null,
  trend: 'flat',
};

describe('Score parity (golden values vs spec §5)', () => {
  it('high-trust + official + free + no-interest + high-volume + lowest-30d + 50% discount → 92 (±1)', () => {
    const sd = svc.compute(baseDeal(), fullAnalytics);
    // discount 20 + below_median 17 + lowest_30d 15 + official 10 + seller 10 + free 5 + inst 5 + volume 5 + stab 5 = 92
    // Below the clamp ceiling of 100. Spec acceptance: ±1.
    expect(Math.abs(sd.score - 92)).toBeLessThanOrEqual(1);
  });

  it('unknown seller → unknown_seller penalty applied', () => {
    const sd = svc.compute(baseDeal({ seller: null }), fullAnalytics);
    expect(sd.factors.unknown_seller).toBe(-5);
  });

  it('used condition → used penalty', () => {
    const sd = svc.compute(baseDeal({ condition: 'used' }), fullAnalytics);
    expect(sd.factors.used_or_refurbished).toBe(-15);
  });

  it('volumeTier=mid → +3 (60% of max)', () => {
    const deal = baseDeal({
      signals: { ...baseDeal().signals, volumeTier: 'mid' },
    });
    const sd = svc.compute(deal, fullAnalytics);
    expect(sd.factors.high_sold_quantity).toBe(3);
  });

  it('sellerTrust=low → -15 (1.5× max penalty)', () => {
    const deal = baseDeal({
      seller: { ...baseDeal().seller!, sellerTrust: 'low' },
    });
    const sd = svc.compute(deal, fullAnalytics);
    expect(sd.factors.seller_reputation).toBe(-15);
  });
});
