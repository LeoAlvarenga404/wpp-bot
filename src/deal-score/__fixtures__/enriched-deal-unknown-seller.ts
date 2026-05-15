// src/deal-score/__fixtures__/enriched-deal-unknown-seller.ts

import type { EnrichedDeal } from '../../sources/source.port';

export const enrichedUnknownSeller: EnrichedDeal = {
  key: { source: 'ml', externalId: 'MLB9999' },
  source: 'ml',
  raw: {
    key: { source: 'ml', externalId: 'MLB9999' },
    title: 'X',
    priceCents: 10000,
    originalPriceCents: 20000,
    discountPercent: 50,
    thumbnail: '',
    permalink: 'p',
    feedId: 'MLB1648',
  },
  seller: null,
  condition: 'unknown',
  signals: {
    freeShipping: false,
    installmentsNoInterest: false,
    volumeTier: 'none',
    isVerifiedStore: false,
  },
  extras: {},
};
