import { toEnrichedDeal, toRawDeal } from './mapping';
import type { ShopeeOfferNode } from './mapping';

function node(overrides: Partial<ShopeeOfferNode> = {}): ShopeeOfferNode {
  return {
    itemId: 12345,
    productName: 'Teclado Mecânico RGB',
    price: '99.90',
    priceDiscountRate: 50,
    imageUrl: 'https://cf.shopee.com.br/img.jpg',
    offerLink: 'https://s.shopee.com.br/aff123',
    productLink: 'https://shopee.com.br/product/1/12345',
    sales: 1500,
    ratingStar: '4.8',
    shopName: 'Loja Tech',
    shopType: [1],
    ...overrides,
  };
}

describe('toRawDeal (shopee)', () => {
  it('maps node to RawDeal with shopee key and affiliated permalink', () => {
    const raw = toRawDeal(node(), 'kw:teclado mecanico');
    expect(raw.key).toEqual({ source: 'shopee', externalId: '12345' });
    expect(raw.priceCents).toBe(9990);
    // 50% off => original = price / 0.5
    expect(raw.originalPriceCents).toBe(19980);
    expect(raw.discountPercent).toBe(50);
    expect(raw.permalink).toBe('https://s.shopee.com.br/aff123');
    expect(raw.feedId).toBe('kw:teclado mecanico');
    expect(raw.condition).toBe('new');
  });

  it('null discount => no original price', () => {
    const raw = toRawDeal(node({ priceDiscountRate: null }), 'kw:x');
    expect(raw.originalPriceCents).toBeNull();
    expect(raw.discountPercent).toBe(0);
  });

  it('falls back to productLink when offerLink is empty', () => {
    const raw = toRawDeal(node({ offerLink: '' }), 'kw:x');
    expect(raw.permalink).toBe('https://shopee.com.br/product/1/12345');
  });
});

describe('toEnrichedDeal (shopee)', () => {
  it('derives seller trust and signals from the feed node', () => {
    const raw = toRawDeal(node(), 'kw:x');
    const e = toEnrichedDeal(raw, node());
    expect(e.source).toBe('shopee');
    expect(e.seller?.sellerTrust).toBe('high'); // 4.8
    expect(e.seller?.isVerifiedStore).toBe(true); // shopType [1]
    expect(e.signals.volumeTier).toBe('high'); // 1500 vendas
    expect(e.signals.isVerifiedStore).toBe(true);
  });

  it('unknown rating => trust unknown; few sales => tier none', () => {
    const n = node({ ratingStar: null, sales: 3, shopType: null });
    const raw = toRawDeal(n, 'kw:x');
    const e = toEnrichedDeal(raw, n);
    expect(e.seller?.sellerTrust).toBe('unknown');
    expect(e.signals.volumeTier).toBe('none');
    expect(e.signals.isVerifiedStore).toBe(false);
  });
});
