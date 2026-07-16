import { ofertasTemplate, sourceHashtag, linkLabel } from './template-ofertas';
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

describe('sourceHashtag / linkLabel', () => {
  it('maps sources to hashtags', () => {
    expect(sourceHashtag('ml')).toBe('#MercadoLivre');
    expect(sourceHashtag('shopee')).toBe('#Shopee');
  });
  it('maps sources to link labels', () => {
    expect(linkLabel('ml')).toBe('Link:');
    expect(linkLabel('shopee')).toBe('Link do produto:');
  });
});

describe('ofertasTemplate', () => {
  it('renders ML layout: hashtag, uppercased hook, title, price à vista, link', () => {
    const out = ofertasTemplate({
      sd: makeScored({ source: 'ml', priceCents: 8700 }),
      link: 'https://meli.la/ABC',
      hook: 'que preço é esse',
    });
    const lines = out.split('\n');
    expect(lines[0]).toBe('#MercadoLivre');
    expect(out).toContain('QUE PREÇO É ESSE 🔥');
    expect(out).toContain('➡️ Echo Dot 5');
    expect(out).toContain('✅ R$ 87 à vista');
    expect(out).toContain('🛒 Link: https://meli.la/ABC');
    expect(out).not.toMatch(/Link de afiliado/);
  });

  it('shows "NO PIX" with the pix price when priceView has one', () => {
    const out = ofertasTemplate({
      sd: makeScored({ priceCents: 10000 }),
      link: 'l',
      hook: 'x',
      priceView: {
        priceCents: 10000,
        originalPriceCents: 20000,
        discountPercent: 50,
        pixPriceCents: 8780,
        installments: null,
        scrapedAt: '2026-07-15T20:00:00.000Z',
      },
    });
    expect(out).toContain('✅ R$ 87 NO PIX');
    expect(out).not.toContain('à vista');
  });

  it('renders ⚡ FULL only when signals.isFull', () => {
    const withFull = ofertasTemplate({
      sd: makeScored({ isFull: true }),
      link: 'l',
      hook: 'h',
    });
    const noFull = ofertasTemplate({
      sd: makeScored({ isFull: false }),
      link: 'l',
      hook: 'h',
    });
    expect(withFull).toContain('⚡ FULL');
    expect(noFull).not.toContain('⚡ FULL');
  });

  it('renders coupon code only (no validity/price) when couponView present', () => {
    const out = ofertasTemplate({
      sd: makeScored(),
      link: 'l',
      hook: 'h',
      couponView: {
        code: 'SHOWNOCAMPO',
        mode: 'PRICE',
        finalCents: 8000,
        discountLabel: '-R$ 20',
        minCents: null,
        validUntil: '2999-01-01T00:00:00.000Z',
      },
    });
    expect(out).toContain('🎟️ Use o cupom: SHOWNOCAMPO');
    expect(out).not.toMatch(/válido até/);
    expect(out).not.toMatch(/R\$\s?80,00/);
  });

  it('omits coupon line when no couponView', () => {
    const out = ofertasTemplate({ sd: makeScored(), link: 'l', hook: 'h' });
    expect(out).not.toContain('🎟️');
  });

  it('uses Shopee hashtag + link label for shopee source', () => {
    const out = ofertasTemplate({
      sd: makeScored({ source: 'shopee' }),
      link: 'https://s.shopee.com.br/x',
      hook: 'h',
    });
    expect(out.split('\n')[0]).toBe('#Shopee');
    expect(out).toContain('🛒 Link do produto: https://s.shopee.com.br/x');
  });

  it('picks hook emoji by level', () => {
    expect(
      ofertasTemplate({
        sd: makeScored({ level: 'good' }),
        link: 'l',
        hook: 'h',
      }),
    ).toContain('H 🔥');
    expect(
      ofertasTemplate({
        sd: makeScored({ level: 'top' }),
        link: 'l',
        hook: 'h',
      }),
    ).toContain('H 🔥🔥');
    expect(
      ofertasTemplate({
        sd: makeScored({ level: 'super' }),
        link: 'l',
        hook: 'h',
      }),
    ).toContain('H 🚨');
  });

  it('omits the hook line entirely when hook is empty', () => {
    const out = ofertasTemplate({ sd: makeScored(), link: 'l', hook: '' });
    const lines = out.split('\n');
    expect(lines[0]).toBe('#MercadoLivre');
    expect(lines[1]).toBe('');
    expect(lines[2]).toContain('➡️');
  });

  it('formats thousands and floors cents', () => {
    const out = ofertasTemplate({
      sd: makeScored({ priceCents: 484699 }),
      link: 'l',
      hook: 'h',
    });
    expect(out).toContain('✅ R$ 4.846 à vista');
  });
});
