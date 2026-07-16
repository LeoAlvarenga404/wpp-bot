import {
  parseBrlToCents,
  parseInstallments,
  parseJsonLdPrice,
} from './price-parse';

describe('parseBrlToCents', () => {
  it('parses spaced-comma cents (ML DOM render)', () => {
    expect(parseBrlToCents('R$ 59 , 90')).toBe(5990);
    expect(parseBrlToCents('R$ 239 , 90')).toBe(23990);
  });

  it('parses compact comma cents', () => {
    expect(parseBrlToCents('R$59,90')).toBe(5990);
    expect(parseBrlToCents('R$ 66,93')).toBe(6693);
  });

  it('parses thousands separator', () => {
    expect(parseBrlToCents('R$ 1.899,00')).toBe(189900);
    expect(parseBrlToCents('R$ 1.234.567,89')).toBe(123456789);
  });

  it('parses integer price with no cents', () => {
    expect(parseBrlToCents('R$69')).toBe(6900);
    expect(parseBrlToCents('R$\n1.899')).toBe(189900);
  });

  it('returns null for non-price text', () => {
    expect(parseBrlToCents('')).toBeNull();
    expect(parseBrlToCents('grátis')).toBeNull();
  });
});

describe('parseInstallments', () => {
  it('parses spaced no-interest installments (real ML DOM)', () => {
    expect(
      parseInstallments(
        '2x R$ 29 , 95 sem juros com outros cartões ou parcelado com Crédito disponível',
      ),
    ).toEqual({ count: 2, amountCents: 2995, noInterest: true });
  });

  it('parses compact no-interest installments', () => {
    expect(parseInstallments('3x R$22,31 sem juros')).toEqual({
      count: 3,
      amountCents: 2231,
      noInterest: true,
    });
  });

  it('marks interest when "sem juros" absent', () => {
    expect(parseInstallments('10x R$ 50,00')).toEqual({
      count: 10,
      amountCents: 5000,
      noInterest: false,
    });
  });

  it('returns null when no installment pattern', () => {
    expect(parseInstallments('')).toBeNull();
    expect(parseInstallments('Frete grátis')).toBeNull();
  });
});

describe('parseJsonLdPrice', () => {
  const jsonld =
    '{"name":"Creatina 1kg","image":"https://x","offers":{"price":59.9,"availability":"https://schema.org/InStock","@type":"Offer","priceCurrency":"BRL","priceValidUntil":"2026-07-18"}}';

  it('extracts offers.price as cents', () => {
    expect(parseJsonLdPrice(jsonld)).toBe(5990);
  });

  it('returns null for malformed / priceless json-ld', () => {
    expect(parseJsonLdPrice('not json')).toBeNull();
    expect(parseJsonLdPrice('{"name":"x"}')).toBeNull();
  });
});
