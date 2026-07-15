import { FormatterService } from './formatter.service';
import type { ScoredDeal } from '../deal-score/types';
import type { TrustBadge } from '../queue/queue.types';

function makeScored(
  level: 'good' | 'top' | 'super' = 'top',
  reasons: { code: string; message: string }[] = [],
): ScoredDeal {
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
    score: 90,
    rawScore: 90,
    level,
    reasons,
    penalties: [],
    factors: {},
  } as ScoredDeal;
}

function makeFormatter(): FormatterService {
  const affiliate = { resolve: jest.fn().mockResolvedValue('https://aff/x') };
  const headline = { generate: jest.fn().mockResolvedValue('HOOK 🔥') };
  return new FormatterService(affiliate as any, headline as any);
}

const badge: TrustBadge = {
  label: '📉 Menor preço em 30 dias',
  monitoredDays: 42,
};
const SELO = '📉 Menor preço em 30 dias ✓ monitorado há 42 dias';

describe('formatScored trust badge', () => {
  it.each(['good', 'top', 'super'] as const)(
    'renders selo on variant A level=%s',
    async (level) => {
      const f = makeFormatter();
      const { caption } = await f.formatScored(makeScored(level), 'A', badge);
      expect(caption).toContain(SELO);
    },
  );

  it.each(['good', 'top', 'super'] as const)(
    'renders selo on variant B level=%s',
    async (level) => {
      const f = makeFormatter();
      const { caption } = await f.formatScored(makeScored(level), 'B', badge);
      expect(caption).toContain(SELO);
    },
  );

  it('falls back to reason line on top when no badge', async () => {
    const f = makeFormatter();
    const scored = makeScored('top', [
      { code: 'lowest_price_30d', message: 'Menor preço dos últimos 30 dias' },
    ]);
    const { caption } = await f.formatScored(scored, 'A');
    expect(caption).toContain('📉 Menor preço dos últimos 30 dias');
    expect(caption).not.toContain('monitorado há');
  });

  it('renders no history line without badge and without reasons', async () => {
    const f = makeFormatter();
    const { caption } = await f.formatScored(makeScored('top'), 'A');
    expect(caption).not.toContain('📉');
    expect(caption).not.toContain('monitorado há');
  });

  it('selo replaces (not duplicates) the reason line', async () => {
    const f = makeFormatter();
    const scored = makeScored('top', [
      { code: 'lowest_price_30d', message: 'Menor preço dos últimos 30 dias' },
    ]);
    const { caption } = await f.formatScored(scored, 'A', badge);
    expect(caption).toContain(SELO);
    expect(caption).not.toContain('📉 Menor preço dos últimos 30 dias');
  });
});
