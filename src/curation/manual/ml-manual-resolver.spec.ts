import type {
  ProductScraperPort,
  ProductView,
} from '../../pricing/product-scraper.port';
import { ManualResolveError } from './manual-resolver.port';
import { MlManualResolver, extractMlId } from './ml-manual-resolver';

function makeView(over: Partial<ProductView> = {}): ProductView {
  return {
    title: 'Fone Bluetooth XYZ',
    thumbnail: 'https://http2.mlstatic.com/img.jpg',
    priceCents: 19990,
    originalPriceCents: 39990,
    discountPercent: 50,
    installments: { count: 10, amountCents: 1999, noInterest: true },
    ...over,
  };
}

describe('extractMlId', () => {
  it('prefers the catalog id from a /p/MLB… URL', () => {
    expect(
      extractMlId('https://www.mercadolivre.com.br/fone-xyz/p/MLB123456?x=1'),
    ).toBe('MLB123456');
  });

  it('extracts the item id from a produto.mercadolivre MLB-… URL', () => {
    expect(
      extractMlId(
        'https://produto.mercadolivre.com.br/MLB-1234567890-fone-_JM',
      ),
    ).toBe('MLB1234567890');
  });

  it('returns null when there is no MLB id', () => {
    expect(extractMlId('https://example.com/nope')).toBeNull();
  });
});

describe('MlManualResolver', () => {
  const makeResolver = (view: ProductView | null) => {
    const scraper: ProductScraperPort = {
      scrapeProductView: jest.fn(async () => view),
    };
    return { resolver: new MlManualResolver(scraper), scraper };
  };

  it('claims mercadolivre and meli.la URLs, rejects foreign ones', () => {
    const { resolver } = makeResolver(makeView());
    expect(resolver.canResolve('https://www.mercadolivre.com.br/p/MLB1')).toBe(
      true,
    );
    expect(resolver.canResolve('https://meli.la/abc')).toBe(true);
    expect(resolver.canResolve('https://shopee.com.br/x')).toBe(false);
  });

  it('resolves a URL into a card with key, price and installments', async () => {
    const { resolver, scraper } = makeResolver(makeView());
    const r = await resolver.resolve(
      'https://www.mercadolivre.com.br/fone/p/MLB123456',
    );

    expect(scraper.scrapeProductView).toHaveBeenCalledWith(
      'https://www.mercadolivre.com.br/fone/p/MLB123456',
    );
    expect(r).toMatchObject({
      key: { source: 'ml', externalId: 'MLB123456' },
      source: 'ml',
      title: 'Fone Bluetooth XYZ',
      priceCents: 19990,
      originalPriceCents: 39990,
      discountPercent: 50,
      permalink: 'https://www.mercadolivre.com.br/fone/p/MLB123456',
      installmentsNoInterest: true,
    });
  });

  it('trusts the discount the scraper already derived, defaulting to 0', async () => {
    // buildPriceView (the scraper) owns discount derivation; the resolver
    // passes it through and falls back to 0 when the page reported none.
    const { resolver } = makeResolver(makeView({ discountPercent: 30 }));
    expect(
      (await resolver.resolve('https://mercadolivre.com.br/p/MLB9'))
        .discountPercent,
    ).toBe(30);

    const { resolver: r2 } = makeResolver(makeView({ discountPercent: null }));
    expect(
      (await r2.resolve('https://mercadolivre.com.br/p/MLB9')).discountPercent,
    ).toBe(0);
  });

  it('throws invalid_url when no MLB id is present', async () => {
    const { resolver } = makeResolver(makeView());
    await expect(
      resolver.resolve('https://www.mercadolivre.com.br/ofertas'),
    ).rejects.toMatchObject({ code: 'invalid_url' });
  });

  it('throws scrape_failed (not a phantom card) when the page cannot be read', async () => {
    const { resolver } = makeResolver(null);
    await expect(
      resolver.resolve('https://www.mercadolivre.com.br/fone/p/MLB123456'),
    ).rejects.toBeInstanceOf(ManualResolveError);
    await expect(
      resolver.resolve('https://www.mercadolivre.com.br/fone/p/MLB123456'),
    ).rejects.toMatchObject({ code: 'scrape_failed' });
  });
});
