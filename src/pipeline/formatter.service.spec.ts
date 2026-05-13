import { ConfigService } from '@nestjs/config';
import { FormatterService } from './formatter.service';
import { AffiliateLinkPort } from '../affiliate/affiliate-link.port';
import { DealItem } from '../mercado-livre/types';

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

function makeConfig(map: Record<string, string> = {}): ConfigService {
  return {
    get: jest
      .fn()
      .mockImplementation((key: string, def?: any) => map[key] ?? def),
  } as unknown as ConfigService;
}

function makeAffiliate(shortUrl = 'https://meli.la/ABC'): AffiliateLinkPort {
  return {
    resolve: jest.fn().mockResolvedValue(shortUrl),
    reload: jest.fn().mockResolvedValue(undefined),
  };
}

describe('FormatterService', () => {
  it('produces caption with title, price, shipping, link and default disclaimer', async () => {
    const service = new FormatterService(makeAffiliate(), makeConfig());
    const deal = makeDeal();

    const { caption, imageUrl } = await service.formatItem(deal);

    expect(caption).toContain(deal.title);
    expect(caption).toContain('R$'); // BRL formatting
    expect(caption).toContain('33%');
    expect(caption).toContain('Frete grátis');
    expect(caption).toContain('https://meli.la/ABC');
    expect(caption).toContain('Link de afiliado');
    expect(imageUrl).toContain('https://');
  });

  it('transforms thumbnails to hi-res (-O.jpg -> -F.jpg, http -> https)', async () => {
    const service = new FormatterService(makeAffiliate(), makeConfig());
    const deal = makeDeal({
      thumbnail: 'http://http2.mlstatic.com/D_NQ_NP_xxx-O.jpg',
    });

    const { imageUrl } = await service.formatItem(deal);

    expect(imageUrl).toBe('https://http2.mlstatic.com/D_NQ_NP_xxx-F.jpg');
  });

  it('transforms -I.jpg -> -F.jpg as well', async () => {
    const service = new FormatterService(makeAffiliate(), makeConfig());
    const deal = makeDeal({
      thumbnail: 'http://http2.mlstatic.com/D_NQ_NP_yyy-I.jpg',
    });

    const { imageUrl } = await service.formatItem(deal);

    expect(imageUrl).toBe('https://http2.mlstatic.com/D_NQ_NP_yyy-F.jpg');
  });

  it('never picks the same template twice in a row for the same catalogId', async () => {
    // Force Math.random to return values that would collide (same idx)
    // on consecutive picks; service must rotate to a different idx.
    const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0); // idx=0 both times
    const service = new FormatterService(makeAffiliate(), makeConfig());
    const deal = makeDeal();

    const a = await service.formatItem(deal);
    const b = await service.formatItem(deal);

    expect(a.caption).not.toBe(b.caption);

    randomSpy.mockRestore();
  });

  it('inserts badge when provided', async () => {
    const service = new FormatterService(makeAffiliate(), makeConfig());
    const deal = makeDeal();
    const badge = '📉 Menor preço em 30 dias';

    const { caption } = await service.formatItem(deal, badge);

    expect(caption).toContain(badge);
  });

  it('handles missing thumbnail gracefully', async () => {
    const service = new FormatterService(makeAffiliate(), makeConfig());
    const deal = makeDeal({ thumbnail: '' });

    const { imageUrl, caption } = await service.formatItem(deal);

    expect(imageUrl).toBe('');
    expect(caption).toContain(deal.title);
  });

  it('respects custom disclaimer from config (error-ish: non-default value)', async () => {
    const custom = 'Conteúdo patrocinado.';
    const service = new FormatterService(
      makeAffiliate(),
      makeConfig({ AFFILIATE_DISCLAIMER: custom }),
    );
    const deal = makeDeal();

    const { caption } = await service.formatItem(deal);

    expect(caption).toContain(custom);
    expect(caption).not.toContain('Link de afiliado');
  });

  it('omits shipping line when freeShipping is false', async () => {
    const service = new FormatterService(makeAffiliate(), makeConfig());
    const deal = makeDeal({ freeShipping: false });

    const { caption } = await service.formatItem(deal);

    expect(caption).not.toContain('Frete grátis');
  });

  it('formatBRL returns Brazilian currency format', () => {
    const service = new FormatterService(makeAffiliate(), makeConfig());

    const out = service.formatBRL(1234.5);

    expect(out).toMatch(/R\$/);
    expect(out).toContain('1.234,50');
  });
});
