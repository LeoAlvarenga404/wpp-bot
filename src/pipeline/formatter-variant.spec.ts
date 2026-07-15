import { FormatterService } from './formatter.service';
import type { ScoredDeal } from '../deal-score/types';

function makeScored(level: 'good' | 'top' | 'super' = 'good'): ScoredDeal {
  return {
    deal: {
      key: { source: 'ml', externalId: 'MLB1' },
      source: 'ml',
      raw: {
        key: { source: 'ml', externalId: 'MLB1' },
        title: 'Produto X',
        priceCents: 8990,
        originalPriceCents: 14990,
        discountPercent: 40,
        thumbnail: 'https://t/-I.jpg',
        permalink: 'https://ml/p',
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

function makeFormatter(): FormatterService {
  const affiliate = { resolve: jest.fn().mockResolvedValue('https://aff/x') };
  const headline = { generate: jest.fn().mockResolvedValue('HOOK TESTE 🔥') };
  return new FormatterService(affiliate as any, headline as any);
}

describe('FormatterService.formatScored variants', () => {
  it('defaults to variant A (current template)', async () => {
    const f = makeFormatter();
    const { caption } = await f.formatScored(makeScored());
    expect(caption).not.toContain('❌ De:');
  });

  it('renders De/Por block on variant B', async () => {
    const f = makeFormatter();
    const { caption } = await f.formatScored(makeScored(), 'B');
    expect(caption).toContain('❌ De:');
    expect(caption).toContain('✅ Por:');
    expect(caption).toContain('https://aff/x');
  });

  it('keeps the disclaimer on both variants', async () => {
    const f = makeFormatter();
    const a = await f.formatScored(makeScored(), 'A');
    const b = await f.formatScored(makeScored(), 'B');
    expect(a.caption).toContain('Link de afiliado');
    expect(b.caption).toContain('Link de afiliado');
  });
});
