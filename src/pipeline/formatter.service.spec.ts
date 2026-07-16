import { FormatterService } from './formatter.service';
import { AffiliateLinkPort } from '../affiliate/affiliate-link.port';
import { HeadlineGenerator } from '../headline/headline.port';
import { DealItem } from '../mercado-livre/types';
import type { ScoredDeal } from '../deal-score/types';

function makeDeal(overrides: Partial<DealItem> = {}): DealItem {
  return {
    catalogId: 'MLB123',
    itemId: 'MLBI1',
    title: 'Echo Dot 5',
    thumbnail: 'http://http2.mlstatic.com/D_NQ_NP_xxx-O.jpg',
    price: 199.9,
    originalPrice: 299.9,
    sellerId: 1,
    freeShipping: true,
    permalink: 'https://www.mercadolivre.com.br/p/MLB123',
    discountPercent: 33,
    ...overrides,
  };
}

function makeAffiliate(shortUrl = 'https://meli.la/ABC'): AffiliateLinkPort {
  return {
    resolve: jest.fn().mockResolvedValue(shortUrl),
    reload: jest.fn().mockResolvedValue(undefined),
  };
}

function makeHeadline(hook = 'TEST HOOK! 🔥🔥'): HeadlineGenerator {
  return {
    generate: jest.fn().mockResolvedValue(hook),
  };
}

describe('FormatterService', () => {
  it('produces caption with hook, title, price, shipping and link', async () => {
    const service = new FormatterService(makeAffiliate(), makeHeadline());
    const deal = makeDeal();

    const { caption, imageUrl } = await service.formatItem(deal);

    expect(caption).toContain('TEST HOOK!');
    expect(caption).toContain('#MercadoLivre');
    expect(caption).toContain(`*${deal.title}*`);
    expect(caption).toMatch(/~R\$[^~]+~/);
    expect(caption).toMatch(/\*R\$[^*]+\*/);
    expect(caption).toContain('-33% OFF');
    expect(caption).toContain('Frete grátis');
    expect(caption).toContain('https://meli.la/ABC');
    expect(imageUrl).toContain('https://');
  });

  it('appends affiliate disclaimer with price timestamp', async () => {
    const service = new FormatterService(makeAffiliate(), makeHeadline());
    const deal = makeDeal();

    const { caption } = await service.formatItem(deal);

    expect(caption).toContain('Link de afiliado');
    expect(caption).toMatch(/Preço visto às \d{2}:\d{2}/);
    // disclaimer is the last line, italicized
    const lastLine = caption.trimEnd().split('\n').pop() ?? '';
    expect(lastLine.startsWith('_')).toBe(true);
    expect(lastLine.endsWith('_')).toBe(true);
  });

  it('transforms thumbnails to hi-res (-O.jpg -> -F.jpg, http -> https)', async () => {
    const service = new FormatterService(makeAffiliate(), makeHeadline());
    const deal = makeDeal({
      thumbnail: 'http://http2.mlstatic.com/D_NQ_NP_xxx-O.jpg',
    });

    const { imageUrl } = await service.formatItem(deal);

    expect(imageUrl).toBe('https://http2.mlstatic.com/D_NQ_NP_xxx-F.jpg');
  });

  it('transforms -I.jpg -> -F.jpg as well', async () => {
    const service = new FormatterService(makeAffiliate(), makeHeadline());
    const deal = makeDeal({
      thumbnail: 'http://http2.mlstatic.com/D_NQ_NP_yyy-I.jpg',
    });

    const { imageUrl } = await service.formatItem(deal);

    expect(imageUrl).toBe('https://http2.mlstatic.com/D_NQ_NP_yyy-F.jpg');
  });

  it('inserts badge when provided', async () => {
    const service = new FormatterService(makeAffiliate(), makeHeadline());
    const deal = makeDeal();
    const badge = '📉 Menor preço em 30 dias';

    const { caption } = await service.formatItem(deal, badge);

    expect(caption).toContain(badge);
  });

  it('handles missing thumbnail gracefully', async () => {
    const service = new FormatterService(makeAffiliate(), makeHeadline());
    const deal = makeDeal({ thumbnail: '' });

    const { imageUrl, caption } = await service.formatItem(deal);

    expect(imageUrl).toBe('');
    expect(caption).toContain(deal.title);
  });

  it('omits shipping line when freeShipping is false', async () => {
    const service = new FormatterService(makeAffiliate(), makeHeadline());
    const deal = makeDeal({ freeShipping: false });

    const { caption } = await service.formatItem(deal);

    expect(caption).not.toContain('Frete grátis');
  });

  it('formatBRL returns Brazilian currency format', () => {
    const service = new FormatterService(makeAffiliate(), makeHeadline());

    const out = service.formatBRL(1234.5);

    expect(out).toMatch(/R\$/);
    expect(out).toContain('1.234,50');
  });

  it('calls headline generator with the deal item', async () => {
    const headlineGen = makeHeadline('CAVEMAN HOOK! 💪');
    const service = new FormatterService(makeAffiliate(), headlineGen);
    const deal = makeDeal();

    const { caption } = await service.formatItem(deal);

    expect(headlineGen.generate).toHaveBeenCalledWith(deal);
    expect(caption).toContain('CAVEMAN HOOK!');
  });
});

function makeScored(level: ScoredDeal['level']): ScoredDeal {
  const key = { source: 'ml' as const, externalId: 'MLB1' };
  return {
    deal: {
      key,
      source: 'ml',
      raw: {
        key,
        title: 'T',
        priceCents: 10000,
        originalPriceCents: 20000,
        discountPercent: 50,
        thumbnail: '',
        permalink: 'p',
        feedId: 'MLB1648',
      },
      seller: {
        externalSellerId: '1',
        displayName: 'X',
        sellerTrust: 'high',
        isVerifiedStore: true,
        ratingAverage: 4.8,
        fetchedAt: '2026-05-13T12:00:00.000Z',
      },
      condition: 'new',
      signals: {
        freeShipping: true,
        installmentsNoInterest: true,
        volumeTier: 'mid',
        isVerifiedStore: true,
      },
      extras: {},
    },
    score: 92,
    rawScore: 92,
    level,
    reasons: [
      {
        code: 'lowest_price_30d',
        weight: 15,
        message: 'Menor preço dos últimos 30 dias',
      },
    ],
    penalties: [],
    factors: { lowest_price_30d: 15 },
  };
}

describe('FormatterService.formatScored', () => {
  it('renders the imperdível template for level=super', async () => {
    const svc = new FormatterService(makeAffiliate(), makeHeadline('HOOK'));
    const { caption } = await svc.formatScored(makeScored('super'));
    expect(caption).toMatch(/PROMOÇÃO IMPERDÍVEL/);
    expect(caption).toMatch(/Menor preço dos últimos 30 dias/);
  });

  it('renders the top template for level=top', async () => {
    const svc = new FormatterService(makeAffiliate(), makeHeadline('HOOK'));
    const { caption } = await svc.formatScored(makeScored('top'));
    expect(caption).toMatch(/PROMOÇÃO TOP/);
  });

  it('renders the good template for level=good (no analysis bullets)', async () => {
    const svc = new FormatterService(makeAffiliate(), makeHeadline('HOOK'));
    const { caption } = await svc.formatScored(makeScored('good'));
    expect(caption).toMatch(/Promoção/);
    expect(caption).not.toMatch(/Menor preço/);
  });

  it('renders a no-interest installments line when priceView provides it', async () => {
    const svc = new FormatterService(makeAffiliate(), makeHeadline('HOOK'));
    const { caption } = await svc.formatScored(makeScored('good'), 'A', undefined, {
      priceCents: 10000,
      originalPriceCents: 20000,
      discountPercent: 50,
      pixPriceCents: null,
      installments: { count: 3, amountCents: 3333, noInterest: true },
      scrapedAt: '2026-07-15T20:00:00.000Z',
    });
    expect(caption).toMatch(/3x de R\$\s?33,33 sem juros/);
    // installments sit right under the price line, before the link
    const lines = caption.split('\n');
    const priceIdx = lines.findIndex((l) => /\(-\d+%\)/.test(l));
    const instIdx = lines.findIndex((l) => /sem juros/.test(l));
    const linkIdx = lines.findIndex((l) => /🛒/.test(l));
    expect(priceIdx).toBeGreaterThanOrEqual(0);
    expect(instIdx).toBeGreaterThan(priceIdx);
    expect(instIdx).toBeLessThan(linkIdx);
  });

  it('renders a Pix line when priceView has a lower Pix price', async () => {
    const svc = new FormatterService(makeAffiliate(), makeHeadline('HOOK'));
    const { caption } = await svc.formatScored(makeScored('good'), 'A', undefined, {
      priceCents: 10000,
      originalPriceCents: 20000,
      discountPercent: 50,
      pixPriceCents: 8780,
      installments: null,
      scrapedAt: '2026-07-15T20:00:00.000Z',
    });
    expect(caption).toMatch(/R\$\s?87,80.*Pix/i);
  });

  it('omits Pix/installments lines when priceView is absent (API fallback)', async () => {
    const svc = new FormatterService(makeAffiliate(), makeHeadline('HOOK'));
    const { caption } = await svc.formatScored(makeScored('good'));
    expect(caption).not.toMatch(/sem juros/);
    expect(caption).not.toMatch(/no Pix/i);
  });
});
