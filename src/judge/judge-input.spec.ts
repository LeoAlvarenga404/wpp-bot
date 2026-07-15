import type { PriceAnalytics, ScoredDeal } from '../deal-score/types';
import { buildJudgeInput } from './judge-input';

const analytics: PriceAnalytics = {
  median7d: 10000,
  median14d: 10500,
  median30d: 11000,
  min7d: 9800,
  min14d: 9500,
  min30d: 9000,
  distinctDays: 12,
  lastObservedBefore: null,
  trend: 'falling',
};

function makeScored(overrides: Partial<ScoredDeal> = {}): ScoredDeal {
  return {
    deal: {
      key: { source: 'ml', externalId: 'MLB1' },
      source: 'ml',
      raw: {
        key: { source: 'ml', externalId: 'MLB1' },
        title: 'Fone Bluetooth XYZ',
        priceCents: 8990,
        originalPriceCents: 14990,
        discountPercent: 40,
        thumbnail: '',
        permalink: 'https://ml/p',
        feedId: 'f1',
      },
      seller: {
        externalSellerId: 's1',
        displayName: 'Loja XYZ',
        sellerTrust: 'high',
        isVerifiedStore: true,
        ratingAverage: 4.8,
        fetchedAt: '2026-07-15T00:00:00Z',
      },
      condition: 'new',
      signals: {
        freeShipping: true,
        installmentsNoInterest: false,
        volumeTier: 'high',
        isVerifiedStore: true,
      },
      extras: {},
    },
    score: 82,
    rawScore: 82,
    level: 'good',
    reasons: [{ code: 'discount_percent', weight: 12, message: 'Desconto de 40%' }],
    penalties: [],
    factors: { discount_percent: 12 },
    ...overrides,
  } as ScoredDeal;
}

describe('buildJudgeInput', () => {
  it('maps deal, analytics, seller and reason messages', () => {
    const input = buildJudgeInput(makeScored(), analytics);
    expect(input.title).toBe('Fone Bluetooth XYZ');
    expect(input.priceCents).toBe(8990);
    expect(input.score).toBe(82);
    expect(input.reasons).toEqual(['Desconto de 40%']);
    expect(input.analytics.median30d).toBe(11000);
    expect(input.seller).toEqual({
      trust: 'high',
      isVerifiedStore: true,
      displayName: 'Loja XYZ',
    });
    expect(input.priceRaiseSuspicious).toBe(false);
  });

  it('flags price raise when factor present and handles null seller', () => {
    const sd = makeScored({
      factors: { price_raise_before_discount: -30 },
    });
    (sd.deal as any).seller = null;
    const input = buildJudgeInput(sd, analytics);
    expect(input.priceRaiseSuspicious).toBe(true);
    expect(input.seller).toBeNull();
  });
});
