import type { DealItem } from '../../mercado-livre/types';
import type { ItemDetails, SellerInfo } from '../../enrichment/types';
import type { EnrichedDeal, NormalizedSeller, RawDeal } from '../source.port';

export function mapSellerTrust(
  reputationLevel: string | null,
): 'high' | 'medium' | 'low' | 'unknown' {
  switch (reputationLevel) {
    case '5_green':
    case '4_light_green':
      return 'high';
    case '3_yellow':
      return 'medium';
    case '2_orange':
    case '1_red':
      return 'low';
    default:
      return 'unknown';
  }
}

export function mapVolumeTier(
  sold: number | null,
): 'high' | 'mid' | 'low' | 'none' {
  if (sold == null) return 'none';
  if (sold >= 500) return 'high';
  if (sold >= 100) return 'mid';
  if (sold >= 20) return 'low';
  return 'none';
}

export function mapCondition(
  c: 'new' | 'used' | 'refurbished' | 'not_specified' | null | undefined,
): 'new' | 'used' | 'refurbished' | 'unknown' {
  if (c === 'new' || c === 'used' || c === 'refurbished') return c;
  return 'unknown';
}

export function toNormalizedSeller(s: SellerInfo): NormalizedSeller {
  return {
    externalSellerId: String(s.sellerId),
    displayName: s.nickname,
    sellerTrust: mapSellerTrust(s.reputationLevel),
    isVerifiedStore: s.isOfficialStore,
    ratingAverage: s.ratingAverage == null ? null : s.ratingAverage / 5,
    fetchedAt: s.fetchedAt,
  };
}

export function toRawDeal(d: DealItem, feedId: string): RawDeal {
  return {
    key: { source: 'ml', externalId: d.catalogId },
    title: d.title,
    priceCents: Math.round(d.price * 100),
    originalPriceCents: d.originalPrice
      ? Math.round(d.originalPrice * 100)
      : null,
    discountPercent: d.discountPercent,
    thumbnail: d.thumbnail,
    permalink: d.permalink,
    feedId,
  };
}

export function toEnrichedDeal(
  raw: RawDeal,
  seller: SellerInfo | null,
  item: ItemDetails | null,
  freeShipping: boolean,
  isFull = false,
): EnrichedDeal {
  const normalizedSeller = seller ? toNormalizedSeller(seller) : null;
  const condition = mapCondition(item?.condition);
  const installmentsNoInterest = !!item?.hasInstallmentsNoInterest;
  const volumeTier = mapVolumeTier(item?.soldQuantity ?? null);
  const isVerifiedStore = !!seller?.isOfficialStore;

  return {
    key: raw.key,
    source: 'ml',
    raw,
    seller: normalizedSeller,
    condition,
    signals: {
      freeShipping,
      installmentsNoInterest,
      volumeTier,
      isVerifiedStore,
      isFull,
    },
    extras: {
      powerSellerStatus: seller?.powerSellerStatus ?? null,
      reputationLevel: seller?.reputationLevel ?? null,
      officialStoreId: seller?.officialStoreId ?? null,
      soldQuantity: item?.soldQuantity ?? null,
      catalogId: raw.key.externalId,
      itemId: item?.itemId ?? null,
    },
  };
}
