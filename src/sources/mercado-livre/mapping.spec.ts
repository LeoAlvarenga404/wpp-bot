import {
  mapSellerTrust,
  mapVolumeTier,
  mapCondition,
  toNormalizedSeller,
  toRawDeal,
  toEnrichedDeal,
} from './mapping';
import type { SellerInfo, ItemDetails } from '../../enrichment/types';
import type { DealItem } from '../../mercado-livre/types';

describe('mapSellerTrust', () => {
  it.each([
    ['5_green', 'high'],
    ['4_light_green', 'high'],
    ['3_yellow', 'medium'],
    ['2_orange', 'low'],
    ['1_red', 'low'],
    [null, 'unknown'],
    ['unexpected', 'unknown'],
  ])('maps %p to %p', (input, expected) => {
    expect(mapSellerTrust(input)).toBe(expected);
  });
});

describe('mapVolumeTier', () => {
  it.each([
    [null, 'none'],
    [0, 'none'],
    [19, 'none'],
    [20, 'low'],
    [99, 'low'],
    [100, 'mid'],
    [499, 'mid'],
    [500, 'high'],
    [10000, 'high'],
  ])('maps sold=%p to %p', (sold, expected) => {
    expect(mapVolumeTier(sold)).toBe(expected);
  });
});

describe('mapCondition', () => {
  it.each([
    ['new', 'new'],
    ['used', 'used'],
    ['refurbished', 'refurbished'],
    ['not_specified', 'unknown'],
    [null, 'unknown'],
    [undefined, 'unknown'],
  ])('maps %p to %p', (input, expected) => {
    expect(mapCondition(input as any)).toBe(expected);
  });
});

describe('toNormalizedSeller', () => {
  it('maps a 5_green official store correctly', () => {
    const ml: SellerInfo = {
      sellerId: 42,
      nickname: 'BIG STORE',
      powerSellerStatus: 'platinum',
      reputationLevel: '5_green',
      isOfficialStore: true,
      officialStoreId: 99,
      ratingAverage: 4.5,
      fetchedAt: '2026-05-14T00:00:00.000Z',
    };
    const out = toNormalizedSeller(ml);
    expect(out).toEqual({
      externalSellerId: '42',
      displayName: 'BIG STORE',
      sellerTrust: 'high',
      isVerifiedStore: true,
      ratingAverage: 0.9, // 4.5 / 5
      fetchedAt: '2026-05-14T00:00:00.000Z',
    });
  });

  it('returns null-rating when missing', () => {
    const ml: SellerInfo = {
      sellerId: 7,
      nickname: null,
      powerSellerStatus: null,
      reputationLevel: null,
      isOfficialStore: false,
      officialStoreId: null,
      ratingAverage: null,
      fetchedAt: '2026-05-14T00:00:00.000Z',
    };
    expect(toNormalizedSeller(ml).ratingAverage).toBeNull();
    expect(toNormalizedSeller(ml).sellerTrust).toBe('unknown');
  });
});

describe('toRawDeal', () => {
  it('maps a DealItem to a RawDeal with ml: source key', () => {
    const d: DealItem = {
      catalogId: 'MLB123',
      itemId: 'MLBI1',
      title: 'iPhone',
      thumbnail: 'http://img/x.jpg',
      price: 4999.9,
      originalPrice: 9999.9,
      sellerId: 7,
      freeShipping: true,
      permalink: 'https://x',
      discountPercent: 50,
    };
    const out = toRawDeal(d, 'MLB1648');
    expect(out).toEqual({
      key: { source: 'ml', externalId: 'MLB123' },
      title: 'iPhone',
      priceCents: 499990,
      originalPriceCents: 999990,
      discountPercent: 50,
      thumbnail: 'http://img/x.jpg',
      permalink: 'https://x',
      feedId: 'MLB1648',
    });
  });
});

describe('toEnrichedDeal', () => {
  it('composes RawDeal + ML seller/item into normalized EnrichedDeal', () => {
    const raw = toRawDeal(
      {
        catalogId: 'MLB1',
        itemId: 'MLBI1',
        title: 'X',
        thumbnail: '',
        price: 100,
        originalPrice: 200,
        sellerId: 7,
        freeShipping: true,
        permalink: 'p',
        discountPercent: 50,
      },
      'MLB1648',
    );
    const seller: SellerInfo = {
      sellerId: 7,
      nickname: 'S',
      powerSellerStatus: 'gold',
      reputationLevel: '5_green',
      isOfficialStore: true,
      officialStoreId: 99,
      ratingAverage: 5,
      fetchedAt: '2026-05-14T00:00:00.000Z',
    };
    const item: ItemDetails = {
      itemId: 'MLBI1',
      soldQuantity: 250,
      condition: 'new',
      hasInstallmentsNoInterest: true,
    };

    const out = toEnrichedDeal(raw, seller, item, true);

    expect(out.key).toEqual({ source: 'ml', externalId: 'MLB1' });
    expect(out.source).toBe('ml');
    expect(out.seller?.sellerTrust).toBe('high');
    expect(out.seller?.isVerifiedStore).toBe(true);
    expect(out.condition).toBe('new');
    expect(out.signals).toEqual({
      freeShipping: true,
      installmentsNoInterest: true,
      volumeTier: 'mid',
      isVerifiedStore: true,
      isFull: false,
    });
    expect(out.extras).toMatchObject({
      powerSellerStatus: 'gold',
      reputationLevel: '5_green',
      officialStoreId: 99,
      soldQuantity: 250,
      catalogId: 'MLB1',
      itemId: 'MLBI1',
    });
  });

  it('handles null seller and null item gracefully', () => {
    const raw = toRawDeal(
      {
        catalogId: 'MLB1',
        itemId: 'MLBI1',
        title: 'X',
        thumbnail: '',
        price: 100,
        originalPrice: 200,
        sellerId: 7,
        freeShipping: false,
        permalink: 'p',
        discountPercent: 50,
      },
      'MLB1648',
    );
    const out = toEnrichedDeal(raw, null, null, false);
    expect(out.seller).toBeNull();
    expect(out.condition).toBe('unknown');
    expect(out.signals).toEqual({
      freeShipping: false,
      installmentsNoInterest: false,
      volumeTier: 'none',
      isVerifiedStore: false,
      isFull: false,
    });
    expect(out.extras.soldQuantity).toBeNull();
  });
});

describe('toEnrichedDeal isFull', () => {
  const raw = {
    key: { source: 'ml' as const, externalId: 'MLB1' },
    title: 'T',
    priceCents: 10000,
    originalPriceCents: 20000,
    discountPercent: 50,
    thumbnail: '',
    permalink: 'p',
    feedId: 'F',
  };

  it('sets signals.isFull=true when isFull arg is true', () => {
    const e = toEnrichedDeal(raw, null, null, true, true);
    expect(e.signals.isFull).toBe(true);
  });

  it('defaults signals.isFull to false when arg omitted', () => {
    const e = toEnrichedDeal(raw, null, null, true);
    expect(e.signals.isFull).toBe(false);
  });
});
