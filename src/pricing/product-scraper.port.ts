import type { Installments } from './price-parse';

export const PRODUCT_SCRAPER_PORT = Symbol('PRODUCT_SCRAPER_PORT');

/**
 * Full product snapshot scraped from a product page for the manual-deal
 * resolver (issue #8): unlike PriceScraperPort (price only, used at send time)
 * this also carries the title and image needed to build the approval card.
 * Implementations must never throw — return null on any failure so the caller
 * can report a clean "scrape failed" to the panel instead of a phantom card.
 */
export interface ProductView {
  title: string;
  thumbnail: string;
  /** Displayed "à vista" price in cents. */
  priceCents: number;
  originalPriceCents: number | null;
  discountPercent: number | null;
  installments: Installments | null;
}

export interface ProductScraperPort {
  scrapeProductView(url: string): Promise<ProductView | null>;
}

/** No-op scraper for providers without a browser (AFFILIATE_PROVIDER=json). */
export class NoopProductScraper implements ProductScraperPort {
  async scrapeProductView(): Promise<ProductView | null> {
    return null;
  }
}
