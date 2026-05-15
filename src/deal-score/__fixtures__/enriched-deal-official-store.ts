// src/deal-score/__fixtures__/enriched-deal-official-store.ts

import type { EnrichedDeal } from '../../sources/source.port';

export const enrichedOfficialStore: EnrichedDeal = {
  key: { source: 'ml', externalId: 'MLB1234' },
  source: 'ml',
  raw: {
    key: { source: 'ml', externalId: 'MLB1234' },
    title: 'iPhone',
    priceCents: 499900,
    originalPriceCents: 999900,
    discountPercent: 50,
    thumbnail: '',
    permalink: 'p',
    feedId: 'MLB1648',
  },
  seller: {
    externalSellerId: '42',
    displayName: 'TOP',
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
};
