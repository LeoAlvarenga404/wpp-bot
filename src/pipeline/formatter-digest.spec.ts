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
  } as ScoredDeal;
}

function makeFormatter() {
  const affiliate = {
    resolve: jest.fn(async (u: string) => `aff:${u}`),
  };
  const headline = { generate: jest.fn(async () => 'HOOK 🔥') };
  return {
    formatter: new FormatterService(affiliate as any, headline as any),
    affiliate,
  };
}

describe('FormatterService.formatDigest', () => {
  it('renders one block per deal, links resolved, single disclaimer', async () => {
    const { formatter, affiliate } = makeFormatter();
    const entries = [
      { scored: makeScored('MLB1', 'super'), variant: 'A' as const },
      { scored: makeScored('MLB2', 'top'), variant: 'B' as const },
      { scored: makeScored('MLB3', 'good'), variant: 'A' as const },
    ];

    const { caption, imageUrl } = await formatter.formatDigest(entries);

    expect(caption).toContain('3 ACHADOS');
    expect(caption).toContain('Produto MLB1');
    expect(caption).toContain('Produto MLB2');
    expect(caption).toContain('Produto MLB3');
    expect(caption).toContain('aff:https://ml/MLB1');
    expect(caption).toContain('aff:https://ml/MLB3');
    expect(affiliate.resolve).toHaveBeenCalledTimes(3);
    // disclaimer única, no fim
    expect(caption.match(/Link de afiliado/g)).toHaveLength(1);
    // imagem = oferta top (primeira da lista, gate já ordena por score)
    expect(imageUrl).toBe('https://t/-F.jpg');
  });

  it('variant B block uses De/Por anchor; variant A does not', async () => {
    const { formatter } = makeFormatter();
    const { caption } = await formatter.formatDigest([
      { scored: makeScored('MLB1', 'top'), variant: 'B' as const },
      { scored: makeScored('MLB2', 'good'), variant: 'A' as const },
    ]);

    expect(caption).toContain('❌ De:');
    // bloco A: preço direto com 💰
    expect(caption).toContain('💰');
  });
});
