import { EnrichedDeal, NormalizedSeller, RawDeal } from '../source.port';

/**
 * Node do `productOfferV2` (API GraphQL de afiliados Shopee BR).
 * `price` chega como string decimal ("99.90"); `priceDiscountRate` é
 * percentual inteiro; `offerLink` já vem comissionado com o appId.
 */
export interface ShopeeOfferNode {
  itemId: number | string;
  productName: string;
  price: string;
  priceDiscountRate: number | null;
  imageUrl: string;
  offerLink: string;
  productLink: string;
  sales: number | null;
  ratingStar: string | null;
  shopName: string | null;
  shopType: number[] | null;
}

/** Código de loja oficial/mall na API de afiliados. */
const OFFICIAL_SHOP_TYPE = 1;

export function toRawDeal(node: ShopeeOfferNode, feedId: string): RawDeal {
  const priceCents = Math.round(parseFloat(node.price) * 100);
  const rate = node.priceDiscountRate ?? 0;
  const originalPriceCents =
    rate > 0 && rate < 100 ? Math.round(priceCents / (1 - rate / 100)) : null;
  return {
    key: { source: 'shopee', externalId: String(node.itemId) },
    title: node.productName,
    priceCents,
    originalPriceCents,
    discountPercent: rate,
    thumbnail: node.imageUrl ?? '',
    permalink: node.offerLink || node.productLink,
    feedId,
    condition: 'new',
  };
}

export function toEnrichedDeal(
  raw: RawDeal,
  node: ShopeeOfferNode,
): EnrichedDeal {
  const rating = node.ratingStar != null ? parseFloat(node.ratingStar) : null;
  const isOfficial = (node.shopType ?? []).includes(OFFICIAL_SHOP_TYPE);
  const seller: NormalizedSeller = {
    externalSellerId: node.shopName ?? 'unknown',
    displayName: node.shopName,
    sellerTrust:
      rating == null || Number.isNaN(rating)
        ? 'unknown'
        : rating >= 4.5
          ? 'high'
          : rating >= 4
            ? 'medium'
            : 'low',
    isVerifiedStore: isOfficial,
    ratingAverage: rating != null && !Number.isNaN(rating) ? rating : null,
    fetchedAt: new Date().toISOString(),
  };
  const sales = node.sales ?? 0;
  return {
    key: raw.key,
    source: 'shopee',
    raw,
    seller,
    condition: 'new',
    signals: {
      freeShipping: false,
      installmentsNoInterest: false,
      volumeTier:
        sales > 1000
          ? 'high'
          : sales > 100
            ? 'mid'
            : sales > 10
              ? 'low'
              : 'none',
      isVerifiedStore: isOfficial,
    },
    extras: { sales },
  };
}
