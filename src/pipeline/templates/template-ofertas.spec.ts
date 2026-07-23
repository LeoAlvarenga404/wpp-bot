import { ofertasTemplate, linkLabel } from './template-ofertas';
import type { ScoredDeal, DealLevel } from '../../deal-score/types';

function makeScored(
  over: {
    source?: 'ml' | 'shopee';
    level?: DealLevel;
    priceCents?: number;
    isFull?: boolean;
    title?: string;
  } = {},
): ScoredDeal {
  const source = over.source ?? 'ml';
  const key = { source, externalId: 'X1' };
  return {
    deal: {
      key,
      source,
      raw: {
        key,
        title: over.title ?? 'Echo Dot 5',
        priceCents: over.priceCents ?? 8700,
        originalPriceCents: 20000,
        discountPercent: 56,
        thumbnail: '',
        permalink: 'p',
        feedId: 'F',
      },
      seller: null,
      condition: 'new',
      signals: {
        freeShipping: true,
        installmentsNoInterest: false,
        volumeTier: 'mid',
        isVerifiedStore: false,
        isFull: over.isFull ?? false,
      },
      extras: {},
    },
    score: 90,
    rawScore: 90,
    level: over.level ?? 'good',
    reasons: [],
    penalties: [],
    factors: {},
  };
}

describe('linkLabel', () => {
  it('maps sources to link labels', () => {
    expect(linkLabel('ml')).toBe('Link:');
    expect(linkLabel('shopee')).toBe('Link do produto:');
  });
});

describe('ofertasTemplate', () => {
  it('renders layout: uppercased title first, price block, link — no hashtag or hook', () => {
    const out = ofertasTemplate({
      sd: makeScored({ source: 'ml', priceCents: 8700 }),
      link: 'https://meli.la/ABC',
    });
    const lines = out.split('\n');
    expect(lines[0]).toBe('➡️ ECHO DOT 5');
    expect(out).not.toContain('#MercadoLivre');
    expect(out).toContain('❌ De ~R$ 200~');
    expect(out).toContain('✅ Por R$ 87 no PIX');
    expect(out).toContain('🛒 Link: https://meli.la/ABC');
    expect(out).not.toMatch(/Link de afiliado/);
  });

  it('shows "no PIX" with the pix price when priceView has one', () => {
    const out = ofertasTemplate({
      sd: makeScored({ priceCents: 10000 }),
      link: 'l',
      priceView: {
        priceCents: 10000,
        originalPriceCents: 20000,
        discountPercent: 50,
        pixPriceCents: 8780,
        installments: null,
        scrapedAt: '2026-07-15T20:00:00.000Z',
      },
    });
    expect(out).toContain('✅ Por R$ 87 no PIX');
    expect(out).toContain('(-50%)');
    expect(out).not.toContain('à vista');
  });

  it('renders the struck "De" full price only when it beats the promo', () => {
    const withDe = ofertasTemplate({
      sd: makeScored({ priceCents: 8700 }), // original 20000 > promo
      link: 'l',
    });
    expect(withDe).toContain('❌ De ~R$ 200~');

    const noDe = ofertasTemplate({
      sd: makeScored({ priceCents: 8700 }),
      link: 'l',
      priceView: {
        priceCents: 8700,
        originalPriceCents: 8700, // equal → no fake "De"
        discountPercent: null,
        pixPriceCents: null,
        installments: null,
        scrapedAt: '2026-07-15T20:00:00.000Z',
      },
    });
    expect(noDe).not.toContain('❌ De');
  });

  it('renders the card installment line from priceView', () => {
    const out = ofertasTemplate({
      sd: makeScored({ priceCents: 100000 }),
      link: 'l',
      priceView: {
        priceCents: 100000,
        originalPriceCents: 150000,
        discountPercent: 33,
        pixPriceCents: 95000,
        installments: { count: 10, amountCents: 10000, noInterest: true },
        scrapedAt: '2026-07-15T20:00:00.000Z',
      },
    });
    expect(out).toContain('✅ Por R$ 950 no PIX');
    expect(out).toContain('💳 ou 10x de R$ 100 sem juros');
  });

  it('renders ⚡ FULL only when signals.isFull', () => {
    const withFull = ofertasTemplate({ sd: makeScored({ isFull: true }), link: 'l' });
    const noFull = ofertasTemplate({ sd: makeScored({ isFull: false }), link: 'l' });
    expect(withFull).toContain('⚡ FULL');
    expect(noFull).not.toContain('⚡ FULL');
  });

  it('stacks a PERCENT coupon on the PIX promo price', () => {
    const out = ofertasTemplate({
      sd: makeScored({ priceCents: 10000 }),
      link: 'l',
      priceView: {
        priceCents: 10000,
        originalPriceCents: 20000,
        discountPercent: 50,
        pixPriceCents: 8800, // promo shown = PIX
        installments: null,
        scrapedAt: '2026-07-15T20:00:00.000Z',
      },
      couponView: {
        code: 'LOOKEMDIA',
        mode: 'PRICE',
        finalCents: 9000, // resolution-time value (à-vista) — ignored at render
        discountLabel: '-10%',
        minCents: null,
        validUntil: '2999-01-01T00:00:00.000Z',
        type: 'PERCENT',
        value: 10,
        capCents: null,
      },
    });
    const lines = out.split('\n');
    const couponIdx = lines.findIndex((l) => l.startsWith('🎟️'));
    const linkIdx = lines.findIndex((l) => l.startsWith('🛒'));
    // 8800 - 10% = 7920 -> floored R$ 79, over the PIX promo not the à-vista.
    expect(lines[couponIdx]).toBe('🎟️ Com o cupom LOOKEMDIA: R$ 79  (-10%)');
    expect(couponIdx).toBeLessThan(linkIdx);
    expect(out).not.toMatch(/válido até/);
  });

  it('stacks a FIXED coupon on the PIX promo price', () => {
    const out = ofertasTemplate({
      sd: makeScored({ priceCents: 8700 }),
      link: 'l',
      couponView: {
        code: 'MENOS20',
        mode: 'PRICE',
        finalCents: 6700,
        discountLabel: '-R$ 20',
        minCents: null,
        validUntil: '2999-01-01T00:00:00.000Z',
        type: 'FIXED',
        value: 2000, // R$ 20 off
        capCents: null,
      },
    });
    // 8700 - 2000 = 6700 -> R$ 67.
    expect(out).toContain('🎟️ Com o cupom MENOS20: R$ 67  (-R$ 20)');
  });

  it('falls back to code-only when a FINAL price does not beat the promo (pix lower)', () => {
    const out = ofertasTemplate({
      sd: makeScored({ priceCents: 10000 }),
      link: 'l',
      priceView: {
        priceCents: 10000,
        originalPriceCents: 20000,
        discountPercent: 50,
        pixPriceCents: 7500, // pix already below the informed final
        installments: null,
        scrapedAt: '2026-07-15T20:00:00.000Z',
      },
      couponView: {
        code: 'FRACO',
        mode: 'PRICE',
        finalCents: 9000, // absolute informed price, still above the pix promo
        discountLabel: '-R$ 10',
        minCents: null,
        validUntil: '2999-01-01T00:00:00.000Z',
        type: 'FINAL',
        value: 9000,
        capCents: null,
      },
    });
    expect(out).toContain('🎟️ Use o cupom: FRACO');
    expect(out).not.toContain('Com o cupom');
  });

  it('renders the minimum-purchase CTA when the deal is below the coupon minimum', () => {
    const out = ofertasTemplate({
      sd: makeScored({ priceCents: 8700 }),
      link: 'l',
      couponView: {
        code: 'ACIMA200',
        mode: 'CTA',
        finalCents: null,
        discountLabel: '-R$ 30',
        minCents: 20000,
        validUntil: '2999-01-01T00:00:00.000Z',
        type: 'FIXED',
        value: 3000,
        capCents: null,
      },
    });
    expect(out).toContain('🎟️ Cupom ACIMA200 em compras acima de R$ 200');
  });

  it('omits coupon line when no couponView', () => {
    const out = ofertasTemplate({ sd: makeScored(), link: 'l' });
    expect(out).not.toContain('🎟️');
  });

  it('uses Shopee link label for shopee source, without hashtag', () => {
    const out = ofertasTemplate({
      sd: makeScored({ source: 'shopee' }),
      link: 'https://s.shopee.com.br/x',
    });
    expect(out).not.toContain('#Shopee');
    expect(out).toContain('🛒 Link do produto: https://s.shopee.com.br/x');
  });

  it('uppercases the title with pt-BR locale', () => {
    const out = ofertasTemplate({
      sd: makeScored({ title: 'Fone é ótimo ção' }),
      link: 'l',
    });
    expect(out.split('\n')[0]).toBe('➡️ FONE É ÓTIMO ÇÃO');
  });

  it('formats thousands and floors cents', () => {
    const out = ofertasTemplate({
      sd: makeScored({ priceCents: 484699 }),
      link: 'l',
    });
    expect(out).toContain('✅ Por R$ 4.846 no PIX');
  });
});
