import type { Installments } from './price-parse';

/**
 * Accurate price snapshot scraped from the product page at dispatch time.
 * Carried on the send job (optional) so the formatter can show the real
 * displayed price + Pix + no-interest installments. Absent = fall back to the
 * API price already on the deal.
 */
export interface PriceView {
  /** Displayed "à vista" price in cents (JSON-LD offers.price). */
  priceCents: number;
  originalPriceCents: number | null;
  discountPercent: number | null;
  /** Pix price in cents when the page shows one distinct from priceCents. */
  pixPriceCents: number | null;
  installments: Installments | null;
  /** ISO timestamp of the scrape. */
  scrapedAt: string;
}
