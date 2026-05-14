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

  it('omits affiliate disclaimer line', async () => {
    const service = new FormatterService(makeAffiliate(), makeHeadline());
    const deal = makeDeal();

    const { caption } = await service.formatItem(deal);

    expect(caption).not.toContain('Link de afiliado');
    expect(caption).not.toMatch(/_.*afiliado.*_/i);
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
  return {
    deal: {
      catalogId: 'C', itemId: 'I', title: 'T', thumbnail: '',
      price: 100, originalPrice: 200, sellerId: 1, freeShipping: true,
      permalink: 'p', discountPercent: 50,
      seller: {
        sellerId: 1, nickname: 'X', powerSellerStatus: 'platinum',
        reputationLevel: '5_green', isOfficialStore: true,
        officialStoreId: 9, ratingAverage: 4.8,
        fetchedAt: '2026-05-13T12:00:00.000Z',
      },
      item: {
        itemId: 'I', soldQuantity: 100, condition: 'new',
        hasInstallmentsNoInterest: true,
      },
    } as any,
    score: 92, rawScore: 92, level,
    reasons: [{ code: 'lowest_price_30d', weight: 15, message: 'Menor preço dos últimos 30 dias' }],
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
});
