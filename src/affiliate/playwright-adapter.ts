import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { Browser, BrowserContext, Page } from 'playwright';
import { AffiliateLinkPort } from './affiliate-link.port';

const LINKBUILDER_URL = 'https://www.mercadolivre.com.br/afiliados/linkbuilder';
const CREATE_LINK_API = '/affiliate-program/api/v2/affiliates/createLink';

/**
 * Playwright-driven affiliate link resolver (P2-19).
 *
 * First run (no storage state on disk):
 *   - Launches a HEADED Chromium so the operator can manually log into
 *     mercadolivre.com.br. When the user closes the window the storage state
 *     is persisted to `auth_info/playwright-state.json`. From then on the
 *     adapter runs headless using that state.
 *
 * Steady state:
 *   - Single Browser + Context per process (lazy-launched on first
 *     `resolve()`), reused across calls.
 *   - For each url: open a new page, navigate to the linkbuilder, paste the
 *     long url, click "Gerar", and intercept the createLink API response (or
 *     fall back to scraping the meli.la value from the DOM).
 *
 * Errors:
 *   - Throws `Error('PLAYWRIGHT_SESSION_EXPIRED')` if a login redirect is
 *     detected so callers can fall back to the JSON adapter and operators
 *     can re-run the headed flow.
 *
 * Cache:
 *   - Resolved (long → short) pairs are persisted to
 *     `./data/playwright-cache.json` to avoid driving the browser for the
 *     same URL twice. Eventually replaced by the `AffiliateLink` Prisma
 *     model (P1-9), but the file cache is the durable layer for now.
 */
@Injectable()
export class PlaywrightAffiliateAdapter
  implements AffiliateLinkPort, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PlaywrightAffiliateAdapter.name);

  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private initPromise: Promise<void> | null = null;

  private cache: Record<string, string> = {};
  private cachePath = path.resolve('./data/playwright-cache.json');
  private statePath = path.resolve('./auth_info/playwright-state.json');

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    this.statePath = path.resolve(
      this.config.get<string>(
        'PLAYWRIGHT_STATE_PATH',
        './auth_info/playwright-state.json',
      ),
    );
    this.cachePath = path.resolve(
      this.config.get<string>(
        'PLAYWRIGHT_CACHE_PATH',
        './data/playwright-cache.json',
      ),
    );
    await this.loadCache();
  }

  async onModuleDestroy(): Promise<void> {
    await this.closeBrowser();
  }

  async reload(): Promise<void> {
    // Force re-init of browser on next resolve, and re-read the cache from
    // disk in case it was edited externally.
    await this.closeBrowser();
    await this.loadCache();
  }

  async resolve(originalUrl: string): Promise<string> {
    if (this.cache[originalUrl]) return this.cache[originalUrl];

    await this.ensureBrowser();
    if (!this.context) {
      throw new Error('PLAYWRIGHT_SESSION_EXPIRED');
    }

    const page = await this.context.newPage();
    try {
      const shortUrl = await this.runLinkbuilder(page, originalUrl);
      this.cache[originalUrl] = shortUrl;
      await this.saveCache();
      return shortUrl;
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async runLinkbuilder(
    page: Page,
    originalUrl: string,
  ): Promise<string> {
    let apiShortUrl: string | null = null;

    // Race the API response with DOM scraping — whichever fires first wins.
    const responsePromise = page
      .waitForResponse(
        (res) => res.url().includes(CREATE_LINK_API) && res.status() < 500,
        { timeout: 20_000 },
      )
      .then(async (res) => {
        try {
          const body = (await res.json()) as Record<string, unknown>;
          const short =
            (body.short_url as string | undefined) ??
            (body.shortUrl as string | undefined) ??
            (body.url as string | undefined) ??
            (body.urls as Record<string, string> | undefined)?.short_url;
          if (typeof short === 'string' && short.includes('meli.la')) {
            apiShortUrl = short;
          }
        } catch {
          // ignore — fall back to DOM scrape
        }
      })
      .catch(() => undefined);

    await page.goto(LINKBUILDER_URL, { waitUntil: 'domcontentloaded' });

    // Login redirect detection — ML sends unauthenticated visitors to a
    // /jms/mlb/lgz/login URL.
    if (/\/lgz\/login|\/sign-?in/i.test(page.url())) {
      throw new Error('PLAYWRIGHT_SESSION_EXPIRED');
    }

    const textarea = page.locator('textarea').first();
    await textarea.waitFor({ state: 'visible', timeout: 15_000 });
    await textarea.fill(originalUrl);

    const generateButton = page
      .getByRole('button', { name: /gerar|generate/i })
      .first();
    await generateButton.click();

    // Either the API listener resolves first, or we scrape the rendered
    // short URL from the DOM.
    const domShortUrl = await page
      .locator('text=/meli\\.la\\/[A-Za-z0-9]+/')
      .first()
      .innerText({ timeout: 20_000 })
      .catch(() => null);

    await responsePromise;

    const short = apiShortUrl ?? this.extractMeliLa(domShortUrl);
    if (!short) {
      throw new Error('Failed to extract meli.la short URL from linkbuilder');
    }
    return short;
  }

  private extractMeliLa(text: string | null): string | null {
    if (!text) return null;
    const match = text.match(/https?:\/\/meli\.la\/[A-Za-z0-9]+/);
    if (match) return match[0];
    const bareMatch = text.match(/meli\.la\/[A-Za-z0-9]+/);
    return bareMatch ? `https://${bareMatch[0]}` : null;
  }

  private async ensureBrowser(): Promise<void> {
    if (this.context) return;
    if (!this.initPromise) {
      this.initPromise = this.initBrowser().finally(() => {
        this.initPromise = null;
      });
    }
    await this.initPromise;
  }

  private async initBrowser(): Promise<void> {
    // Dynamic import keeps the optional Playwright dep out of the default
    // load path when AFFILIATE_PROVIDER=json.
    const { chromium } = await import('playwright');

    const hasState = await this.fileExists(this.statePath);

    if (!hasState) {
      this.logger.warn(
        `No Playwright storage state at ${this.statePath}. Launching headed ` +
          `Chromium — please log into mercadolivre.com.br manually, then ` +
          `close the window. The session will be saved on close.`,
      );
      const headedBrowser = await chromium.launch({ headless: false });
      const headedContext = await headedBrowser.newContext();
      const page = await headedContext.newPage();
      await page.goto(LINKBUILDER_URL);

      // Wait until the user closes the page/browser, then persist state.
      await new Promise<void>((resolveClose) => {
        const done = () => resolveClose();
        page.on('close', done);
        headedBrowser.on('disconnected', done);
      });

      try {
        await fs.mkdir(path.dirname(this.statePath), { recursive: true });
        await headedContext.storageState({ path: this.statePath });
        this.logger.log(`Saved Playwright storage state → ${this.statePath}`);
      } catch (err) {
        this.logger.error('Failed to persist Playwright storage state', err);
      }
      await headedBrowser.close().catch(() => undefined);
    }

    this.browser = await chromium.launch({ headless: true });
    this.context = await this.browser.newContext({
      storageState: this.statePath,
    });
    this.logger.log(
      'Playwright browser ready (headless, storage state loaded)',
    );
  }

  private async closeBrowser(): Promise<void> {
    try {
      await this.context?.close();
    } catch {
      // ignore
    }
    try {
      await this.browser?.close();
    } catch {
      // ignore
    }
    this.context = null;
    this.browser = null;
  }

  // -------------------------------------------------------------------------
  // Cache I/O
  // -------------------------------------------------------------------------

  private async loadCache(): Promise<void> {
    try {
      const raw = await fs.readFile(this.cachePath, 'utf8');
      const parsed = JSON.parse(raw);
      this.cache =
        parsed && typeof parsed === 'object'
          ? (parsed as Record<string, string>)
          : {};
      this.logger.log(
        `Loaded ${Object.keys(this.cache).length} playwright-resolved links from ${this.cachePath}`,
      );
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.cache = {};
      } else {
        this.logger.warn(`Failed to read ${this.cachePath}: ${String(err)}`);
        this.cache = {};
      }
    }
  }

  private async saveCache(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.cachePath), { recursive: true });
      await fs.writeFile(
        this.cachePath,
        JSON.stringify(this.cache, null, 2),
        'utf8',
      );
    } catch (err) {
      this.logger.warn(`Failed to persist playwright cache: ${String(err)}`);
    }
  }

  private async fileExists(p: string): Promise<boolean> {
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  }
}
