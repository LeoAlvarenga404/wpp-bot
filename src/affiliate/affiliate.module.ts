import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import {
  PRICE_SCRAPER_PORT,
  PriceScraperPort,
  NoopPriceScraper,
} from '../pricing/price-scraper.port';
import {
  PRODUCT_SCRAPER_PORT,
  ProductScraperPort,
  NoopProductScraper,
} from '../pricing/product-scraper.port';
import { AFFILIATE_LINK_PORT, AffiliateLinkPort } from './affiliate-link.port';
import { AffiliateController } from './affiliate.controller';
import { JsonCacheAffiliateAdapter } from './json-cache-adapter';
import { PlaywrightAffiliateAdapter } from './playwright-adapter';

/**
 * Wraps the Playwright adapter so a stale session falls back to the JSON
 * cache adapter at runtime instead of crashing the pipeline.
 */
class FallbackAffiliateAdapter implements AffiliateLinkPort {
  private readonly logger = new Logger(FallbackAffiliateAdapter.name);
  private playwrightDisabled = false;

  constructor(
    private readonly primary: PlaywrightAffiliateAdapter,
    private readonly fallback: JsonCacheAffiliateAdapter,
  ) {}

  async resolve(originalUrl: string): Promise<string> {
    if (!this.playwrightDisabled) {
      try {
        return await this.primary.resolve(originalUrl);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === 'PLAYWRIGHT_SESSION_EXPIRED') {
          this.logger.warn(
            'Playwright session expired — falling back to JSON cache for the ' +
              'rest of this process. Delete auth_info/playwright-state.json ' +
              'and restart to re-login.',
          );
          this.playwrightDisabled = true;
        } else {
          this.logger.warn(
            `Playwright resolve failed (${msg}) — falling back to JSON cache for this URL`,
          );
        }
      }
    }
    return this.fallback.resolve(originalUrl);
  }

  async reload(): Promise<void> {
    this.playwrightDisabled = false;
    await Promise.allSettled([this.primary.reload(), this.fallback.reload()]);
  }
}

@Module({
  imports: [AuthModule],
  controllers: [AffiliateController],
  providers: [
    JsonCacheAffiliateAdapter,
    PlaywrightAffiliateAdapter,
    {
      provide: AFFILIATE_LINK_PORT,
      inject: [
        ConfigService,
        JsonCacheAffiliateAdapter,
        PlaywrightAffiliateAdapter,
      ],
      useFactory: (
        config: ConfigService,
        json: JsonCacheAffiliateAdapter,
        playwright: PlaywrightAffiliateAdapter,
      ): AffiliateLinkPort => {
        const provider = (
          config.get<string>('AFFILIATE_PROVIDER', 'json') ?? 'json'
        )
          .toLowerCase()
          .trim();
        if (provider === 'playwright') {
          return new FallbackAffiliateAdapter(playwright, json);
        }
        return json;
      },
    },
    {
      provide: PRICE_SCRAPER_PORT,
      inject: [ConfigService, PlaywrightAffiliateAdapter],
      useFactory: (
        config: ConfigService,
        playwright: PlaywrightAffiliateAdapter,
      ): PriceScraperPort => {
        const provider = (
          config.get<string>('AFFILIATE_PROVIDER', 'json') ?? 'json'
        )
          .toLowerCase()
          .trim();
        // Only the Playwright provider has a logged-in browser to scrape with.
        return provider === 'playwright' ? playwright : new NoopPriceScraper();
      },
    },
    {
      provide: PRODUCT_SCRAPER_PORT,
      inject: [ConfigService, PlaywrightAffiliateAdapter],
      useFactory: (
        config: ConfigService,
        playwright: PlaywrightAffiliateAdapter,
      ): ProductScraperPort => {
        const provider = (
          config.get<string>('AFFILIATE_PROVIDER', 'json') ?? 'json'
        )
          .toLowerCase()
          .trim();
        return provider === 'playwright'
          ? playwright
          : new NoopProductScraper();
      },
    },
  ],
  exports: [AFFILIATE_LINK_PORT, PRICE_SCRAPER_PORT, PRODUCT_SCRAPER_PORT],
})
export class AffiliateModule {}
