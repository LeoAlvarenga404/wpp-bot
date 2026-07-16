import type { PriceView } from './price-view';

export const PRICE_SCRAPER_PORT = Symbol('PRICE_SCRAPER_PORT');

/**
 * Scrapes the accurate displayed price (Pix + no-interest installments) from a
 * product page. Implementations must never throw — return null on any failure
 * so the pipeline falls back to the API price.
 */
export interface PriceScraperPort {
  scrapePriceView(permalink: string): Promise<PriceView | null>;
}

/** No-op scraper for providers without a browser (AFFILIATE_PROVIDER=json). */
export class NoopPriceScraper implements PriceScraperPort {
  async scrapePriceView(): Promise<PriceView | null> {
    return null;
  }
}
