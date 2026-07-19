import { Inject, Injectable } from '@nestjs/common';
import {
  PRODUCT_SCRAPER_PORT,
  type ProductScraperPort,
} from '../../pricing/product-scraper.port';
import {
  SHORT_URL_EXPANDER,
  isShortMeliUrl,
  type ShortUrlExpander,
} from './url-expander';
import {
  ManualResolveError,
  type ManualDealResolver,
  type ResolvedManualDeal,
} from './manual-resolver.port';

/**
 * Pull the Mercado Livre id from a pasted URL. Prefers the catalog id
 * (`/p/MLB123`) so the dedup key lines up with pipeline-sourced deals; falls
 * back to the item id (`MLB-123…`). Returns the canonical `MLB<digits>` form
 * (dash stripped) or null when the URL carries no id.
 */
export function extractMlId(url: string): string | null {
  const catalog = url.match(/\/p\/(MLB\d+)/i);
  if (catalog) return catalog[1].toUpperCase();
  const item = url.match(/MLB-?(\d+)/i);
  return item ? `MLB${item[1]}` : null;
}

/**
 * Resolves a Mercado Livre product URL into an approval card by scraping the
 * page (title, image, à-vista price, no-interest installments). The affiliate
 * short link is left to the send path — `formatScored` already mints it for ML
 * deals — so a manual deal and a pipeline deal publish through identical code.
 */
@Injectable()
export class MlManualResolver implements ManualDealResolver {
  readonly source = 'ml' as const;

  constructor(
    @Inject(PRODUCT_SCRAPER_PORT)
    private readonly scraper: ProductScraperPort,
    @Inject(SHORT_URL_EXPANDER)
    private readonly expander: ShortUrlExpander,
  ) {}

  canResolve(url: string): boolean {
    return /mercadolivre\.com|mercadolibre\.com|meli\.la/i.test(url);
  }

  async resolve(url: string): Promise<ResolvedManualDeal> {
    let target = url;
    let externalId = extractMlId(target);
    // A short meli.la link carries no MLB id — expand the redirect first, then
    // extract the id and scrape the canonical page.
    if (!externalId && isShortMeliUrl(target)) {
      target = await this.expander.expand(target);
      externalId = extractMlId(target);
    }
    if (!externalId) {
      throw new ManualResolveError(
        'invalid_url',
        'URL sem código do produto (MLB…). Cole o link direto do anúncio.',
      );
    }

    const view = await this.scraper.scrapeProductView(target);
    if (!view || typeof view.priceCents !== 'number') {
      throw new ManualResolveError(
        'scrape_failed',
        'Não consegui ler a página do produto — verifique o link ou tente de novo.',
      );
    }

    return {
      key: { source: 'ml', externalId },
      source: 'ml',
      title: view.title,
      priceCents: view.priceCents,
      originalPriceCents: view.originalPriceCents,
      // scrapeProductView already derives the discount from original vs. price
      // when the page shows no explicit "-N%" label (see buildPriceView).
      discountPercent: view.discountPercent ?? 0,
      thumbnail: view.thumbnail,
      permalink: target,
      installmentsNoInterest: view.installments?.noInterest ?? false,
    };
  }
}
