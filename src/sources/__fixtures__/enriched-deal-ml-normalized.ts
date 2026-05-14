import type { EnrichedDeal } from '../source.port';
import { rawDealMl } from './raw-deal-ml';
import { sellerHigh } from './normalized-seller-high';

export const enrichedDealMlNormalized: EnrichedDeal = {
  key: { source: 'ml', externalId: 'MLB1234' },
  source: 'ml',
  raw: rawDealMl,
  seller: sellerHigh,
  condition: 'new',
  signals: {
    freeShipping: true,
    installmentsNoInterest: true,
    volumeTier: 'mid',
    isVerifiedStore: true,
  },
  extras: {
    powerSellerStatus: 'platinum',
    reputationLevel: '5_green',
    officialStoreId: 99,
    soldQuantity: 250,
    catalogId: 'MLB1234',
    itemId: 'MLBI1234',
  },
};
