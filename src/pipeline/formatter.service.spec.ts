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
        isFull: false,
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

describe('FormatterService.formatScored (ofertas clone)', () => {
  it('emits uppercased title first, price and link — no hashtag, hook or disclaimer', async () => {
    const headlineGen = makeHeadline('que preço');
    const svc = new FormatterService(makeAffiliate(), headlineGen);
    const { caption } = await svc.formatScored(makeScored('good'));
    expect(caption.split('\n')[0]).toBe('➡️ T');
    expect(caption).not.toContain('#MercadoLivre');
    expect(caption).not.toContain('QUE PREÇO');
    expect(headlineGen.generate).not.toHaveBeenCalled();
    expect(caption).toContain('🛒 Link: https://meli.la/ABC');
    expect(caption).not.toMatch(/Link de afiliado/);
    expect(caption).not.toMatch(/PROMOÇÃO/);
  });

  it('shows à vista when no priceView, no PIX when pixPriceCents present', async () => {
    const svc = new FormatterService(makeAffiliate(), makeHeadline('h'));
    const noPix = await svc.formatScored(makeScored('good'));
    expect(noPix.caption).toContain('✅ Por R$ 100 à vista');

    const withPix = await svc.formatScored(makeScored('good'), 'A', undefined, {
      priceCents: 10000,
      originalPriceCents: 20000,
      discountPercent: 50,
      pixPriceCents: 8780,
      installments: { count: 12, amountCents: 731, noInterest: true },
      scrapedAt: '2026-07-15T20:00:00.000Z',
    });
    expect(withPix.caption).toContain('✅ Por R$ 87 no PIX');
    expect(withPix.caption).toContain('❌ De ~R$ 200~');
    expect(withPix.caption).toContain('💳 ou 12x de R$ 7 sem juros');
  });

  it('renders ⚡ FULL when signals.isFull', async () => {
    const svc = new FormatterService(makeAffiliate(), makeHeadline('h'));
    const scored = makeScored('good');
    scored.deal.signals.isFull = true;
    const { caption } = await svc.formatScored(scored);
    expect(caption).toContain('⚡ FULL');
  });

  it('renders the final "com cupom" price when it beats the promo', async () => {
    const svc = new FormatterService(makeAffiliate(), makeHeadline('h'));
    const { caption } = await svc.formatScored(
      makeScored('good'), // priceCents 10000, no priceView -> promo à vista
      'A',
      undefined,
      undefined,
      {
        code: 'ABC',
        mode: 'PRICE',
        finalCents: 8000,
        discountLabel: '-R$ 20',
        minCents: null,
        validUntil: '2999-01-01T00:00:00.000Z',
      },
    );
    expect(caption).toContain('🎟️ Com o cupom ABC: R$ 80  (-R$ 20)');
    expect(caption).not.toMatch(/válido até/);
  });

  it('no couponView -> no coupon line', async () => {
    const svc = new FormatterService(makeAffiliate(), makeHeadline('h'));
    const { caption } = await svc.formatScored(makeScored('good'));
    expect(caption).not.toContain('🎟️');
  });
});
