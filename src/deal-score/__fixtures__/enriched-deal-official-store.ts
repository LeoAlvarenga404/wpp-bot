import { EnrichedDeal } from '../../enrichment/types';

export const enrichedDealOfficialStore: EnrichedDeal = {
  catalogId: 'MLB123',
  itemId: 'MLBI123',
  title: 'Sample Product',
  thumbnail: '',
  price: 749,
  originalPrice: 999.9,
  sellerId: 7,
  freeShipping: true,
  permalink: 'https://x',
  discountPercent: 25,
  seller: {
    sellerId: 7,
    nickname: 'SHOP',
    powerSellerStatus: 'platinum',
    reputationLevel: '5_green',
    isOfficialStore: true,
    officialStoreId: 9001,
    ratingAverage: 4.8,
    fetchedAt: new Date().toISOString(),
  },
  item: {
    itemId: 'MLBI123',
    soldQuantity: 1847,
    condition: 'new',
    hasInstallmentsNoInterest: true,
  },
};
