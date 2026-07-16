import { FormatterService } from './formatter.service';
import type { ScoredDeal } from '../deal-score/types';

function makeScored(
  id: string,
  level: 'good' | 'top' | 'super',
  priceCents = 8990,
): ScoredDeal {
  return {
    deal: {
      key: { source: 'ml', externalId: id },
      source: 'ml',
      raw: {
        key: { source: 'ml', externalId: id },
        title: `Produto ${id}`,
        priceCents,
        originalPriceCents: priceCents * 2,
        discountPercent: 50,
        thumbnail: 'https://t/-I.jpg',
        permalink: `https://ml/${id}`,
        feedId: 'f1',
      },
      seller: null,
      condition: 'new',
      signals: {
        freeShipping: true,
        installmentsNoInterest: false,
        volumeTier: 'none',
        isVerifiedStore: false,
      },
      extras: {},
    },
    score: 80,
    rawScore: 80,
    level,
    reasons: [],
    penalties: [],
    factors: {},
  };
}

function makeFormatter() {
  const affiliate = {
    resolve: jest.fn(async (u: string) => `aff:${u}`),
  };
  const headline = { generate: jest.fn(async () => 'HOOK 🔥') };
  return {
    formatter: new FormatterService(affiliate as any, headline),
    affiliate,
  };
}

describe('FormatterService.formatDigest (ofertas clone)', () => {
  it('renders one clone block per deal, links resolved, header, no disclaimer', async () => {
    const { formatter, affiliate } = makeFormatter();
    const entries = [
      { scored: makeScored('MLB1', 'super'), variant: 'A' as const },
      { scored: makeScored('MLB2', 'top'), variant: 'B' as const },
      { scored: makeScored('MLB3', 'good'), variant: 'A' as const },
    ];

    const { caption, imageUrl } = await formatter.formatDigest(entries);

    expect(caption).toContain('🔥 3 ACHADOS NUM POST SÓ');
    expect(caption).toContain('➖➖➖');
    expect(caption).toContain('➡️ Produto MLB1');
    expect(caption).toContain('➡️ Produto MLB2');
    expect(caption).toContain('➡️ Produto MLB3');
    expect(caption).toContain('🛒 Link: aff:https://ml/MLB1');
    expect(caption).toContain('🛒 Link: aff:https://ml/MLB3');
    expect(affiliate.resolve).toHaveBeenCalledTimes(3);
    // sem disclaimer
    expect(caption).not.toMatch(/Link de afiliado/);
    // imagem = oferta top (primeira da lista, gate já ordena por score)
    expect(imageUrl).toBe('https://t/-F.jpg');
  });

  it('shopee deals use the feed permalink as-is + Shopee link label', async () => {
    const { formatter, affiliate } = makeFormatter();
    const shopee = makeScored('77', 'good');
    (shopee.deal as any).key = { source: 'shopee', externalId: '77' };
    (shopee.deal.raw as any).key = { source: 'shopee', externalId: '77' };
    (shopee.deal.raw as any).permalink = 'https://s.shopee.com.br/aff77';

    const { caption } = await formatter.formatDigest([
      { scored: shopee, variant: 'A' as const },
      { scored: makeScored('MLB1', 'top'), variant: 'A' as const },
    ]);

    expect(caption).toContain(
      '🛒 Link do produto: https://s.shopee.com.br/aff77',
    );
    expect(caption).toContain('🛒 Link: aff:https://ml/MLB1');
    expect(affiliate.resolve).toHaveBeenCalledTimes(1); // só o deal ML
  });

  it('threads couponView code into a digest block', async () => {
    const { formatter } = makeFormatter();
    const { caption } = await formatter.formatDigest([
      {
        scored: makeScored('MLB1', 'top'),
        variant: 'A' as const,
        couponView: {
          code: 'DIGCUP',
          mode: 'PRICE',
          finalCents: 9000,
          discountLabel: '-10%',
          minCents: null,
          validUntil: '2999-01-01T00:00:00.000Z',
        },
      },
      { scored: makeScored('MLB2', 'good'), variant: 'A' as const },
    ]);

    expect(caption).toContain('🎟️ Use o cupom: DIGCUP');
  });
});
