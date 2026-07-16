// Pure parsers for Mercado Livre product-page price data. No I/O — fed the
// strings scraped from the PDP (JSON-LD offers block + DOM price/installment
// text) so they can be unit-tested against real captured fixtures.

export interface Installments {
  count: number;
  amountCents: number;
  noInterest: boolean;
}

/**
 * Parse a BRL price token to integer cents. Tolerates the messy shapes the ML
 * PDP renders: spaced cents ("R$ 59 , 90"), thousands dots ("R$ 1.899,00"),
 * newline between symbol and value ("R$\n1.899"), and integer-only ("R$69").
 * Returns null when no numeric price is present ("grátis", "").
 */
export function parseBrlToCents(input: string): number | null {
  if (!input) return null;
  const cleaned = input.replace(/R\$/gi, '').replace(/\s/g, '');
  const m = cleaned.match(/\d[\d.]*(,\d{1,2})?/);
  if (!m) return null;
  const token = m[0];
  let reais: string;
  let cents: string;
  if (token.includes(',')) {
    const [intPart, frac] = token.split(',');
    reais = intPart.replace(/\./g, '');
    cents = (frac + '00').slice(0, 2);
  } else {
    reais = token.replace(/\./g, '');
    cents = '00';
  }
  if (!/^\d+$/.test(reais)) return null;
  return parseInt(reais, 10) * 100 + parseInt(cents, 10);
}

/**
 * Parse an installment phrase like "2x R$ 29 , 95 sem juros …" into structured
 * data. `noInterest` is true only when "sem juros" is present. Returns null
 * when no "<n>x R$<value>" pattern is found.
 */
export function parseInstallments(input: string): Installments | null {
  if (!input) return null;
  const m = input.match(/(\d+)\s*x\s*(R\$[\s\d.,]*\d)/i);
  if (!m) return null;
  const count = parseInt(m[1], 10);
  const amountCents = parseBrlToCents(m[2]);
  if (amountCents == null) return null;
  const noInterest = /sem\s+juros/i.test(input);
  return { count, amountCents, noInterest };
}

/**
 * Extract the current price (cents) from a JSON-LD Product/Offer blob. Falls
 * back to a "price": regex when the blob isn't parseable as a whole (ML embeds
 * several and some are truncated). Returns null when no price is found.
 */
export function parseJsonLdPrice(input: string): number | null {
  if (!input) return null;
  const toCents = (v: unknown): number | null => {
    if (typeof v === 'number') return Math.round(v * 100);
    if (typeof v === 'string' && /^[0-9]+(\.[0-9]+)?$/.test(v)) {
      return Math.round(parseFloat(v) * 100);
    }
    return null;
  };
  try {
    const obj = JSON.parse(input) as any;
    const price = obj?.offers?.price ?? obj?.price;
    const cents = toCents(price);
    if (cents != null) return cents;
  } catch {
    // fall through to regex
  }
  const m = input.match(/"price"\s*:\s*"?([0-9]+(?:\.[0-9]+)?)"?/);
  return m ? Math.round(parseFloat(m[1]) * 100) : null;
}
