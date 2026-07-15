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
import { PrismaService } from '../db/prisma.service';
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

  private cache: Map<string, string> = new Map();
  private cachePath = path.resolve('./data/playwright-cache.json');
  private statePath = path.resolve('./auth_info/playwright-state.json');

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

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
    await this.maybeBackfillFromJson();
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
    const cached = this.cache.get(originalUrl);
    if (cached) return cached;

    await this.ensureBrowser();
    if (!this.context) {
      throw new Error('PLAYWRIGHT_SESSION_EXPIRED');
    }

    const page = await this.context.newPage();
    try {
      const shortUrl = await this.runLinkbuilder(page, originalUrl);
      this.cache.set(originalUrl, shortUrl);
      await this.saveLink(originalUrl, shortUrl);
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

    await page
      .waitForLoadState('networkidle', { timeout: 15_000 })
      .catch(() => undefined);

    const textarea = page.locator('textarea').first();
    try {
      await textarea.waitFor({ state: 'visible', timeout: 30_000 });
    } catch (err) {
      await this.dumpDebug(page, 'textarea-missing').catch(() => undefined);
      throw err;
    }
    await textarea.fill(originalUrl);

    const generateButton = page
      .getByRole('button', { name: /gerar|generate/i })
      .first();
    await generateButton.click();

    const domShortUrl = await page
      .waitForFunction(
        () => {
          const re = /https?:\/\/meli\.la\/[A-Za-z0-9]+/;
          for (const el of Array.from(
            document.querySelectorAll('input, textarea'),
          )) {
            const v = (el as HTMLInputElement).value || '';
            const m = v.match(re);
            if (m) return m[0];
          }
          const body = document.body.textContent || '';
          const m = body.match(re);
          return m ? m[0] : null;
        },
        null,
        { timeout: 20_000 },
      )
      .then((handle) => handle.jsonValue())
      .catch(() => null);

    await responsePromise;

    const short = apiShortUrl ?? this.extractMeliLa(domShortUrl);
    if (!short) {
      await this.dumpDebug(page, 'no-meli-la').catch(() => undefined);
      this.logger.warn(
        `extract debug: apiShortUrl=${apiShortUrl} domShortUrl=${JSON.stringify(domShortUrl)}`,
      );
      throw new Error('Failed to extract meli.la short URL from linkbuilder');
    }
    return short;
  }

  private async dumpDebug(page: Page, label: string): Promise<void> {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = path.resolve('./data/playwright-debug');
    await fs.mkdir(dir, { recursive: true });
    const shotPath = path.join(dir, `${label}-${ts}.png`);
    const htmlPath = path.join(dir, `${label}-${ts}.html`);
    await page
      .screenshot({ path: shotPath, fullPage: true })
      .catch(() => undefined);
    const html = await page.content().catch(() => '');
    await fs.writeFile(htmlPath, html, 'utf8').catch(() => undefined);
    this.logger.warn(
      `Playwright debug dump → ${shotPath} (${html.length} bytes html)`,
    );
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
      const headedBrowser = await chromium.launch({
        headless: false,
        args: [
          '--disable-blink-features=AutomationControlled',
          '--disable-features=IsolateOrigins,site-per-process',
        ],
      });
      const headedContext = await headedBrowser.newContext();
      await headedContext.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
      });
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

    this.browser = await chromium.launch({
      headless: true,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
      ],
    });
    this.context = await this.browser.newContext({
      storageState: this.statePath,
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      locale: 'pt-BR',
      timezoneId: 'America/Sao_Paulo',
      viewport: { width: 1366, height: 768 },
      extraHTTPHeaders: {
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
      },
    });
    await this.context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
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
      const rows = await (this.prisma as any).affiliateLink.findMany({
        select: { longUrl: true, shortUrl: true },
      });
      this.cache = new Map(
        rows.map((r: any) => [r.longUrl as string, r.shortUrl as string]),
      );
      this.logger.log(
        `Loaded ${this.cache.size} affiliate links from AffiliateLink table`,
      );
    } catch (err) {
      this.logger.warn(
        `Failed to hydrate affiliate cache from DB: ${(err as Error).message}`,
      );
      this.cache = new Map();
    }
  }

  private async saveLink(longUrl: string, shortUrl: string): Promise<void> {
    try {
      await (this.prisma as any).affiliateLink.upsert({
        where: { longUrl },
        create: { longUrl, shortUrl },
        update: { shortUrl, generatedAt: new Date() },
      });
    } catch (err) {
      this.logger.warn(
        `Failed to persist affiliate link to DB: ${(err as Error).message}`,
      );
    }
  }

  /**
   * One-shot import of legacy ./data/playwright-cache.json into the
   * AffiliateLink table. Runs only when the table is empty, so repeated
   * boots are no-ops.
   */
  private async maybeBackfillFromJson(): Promise<void> {
    let existing: number;
    try {
      existing = await (this.prisma as any).affiliateLink.count();
    } catch (err) {
      this.logger.warn(`affiliate count() failed: ${(err as Error).message}`);
      return;
    }
    if (existing > 0) return;

    let raw: string;
    try {
      raw = await fs.readFile(this.cachePath, 'utf8');
    } catch (err: any) {
      if (err?.code === 'ENOENT') return;
      this.logger.warn(`Failed to read ${this.cachePath}: ${String(err)}`);
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.logger.warn(
        `Legacy ${this.cachePath} is not valid JSON — skipping backfill`,
      );
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;

    const rows: Array<{ longUrl: string; shortUrl: string }> = [];
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v !== 'string' || !k || !v) continue;
      rows.push({ longUrl: k, shortUrl: v });
    }
    if (rows.length === 0) return;

    try {
      await (this.prisma as any).affiliateLink.createMany({
        data: rows,
        skipDuplicates: true,
      });
      this.logger.log(
        `Backfilled ${rows.length} affiliate links from ${this.cachePath}`,
      );
      for (const r of rows) this.cache.set(r.longUrl, r.shortUrl);
    } catch (err) {
      this.logger.warn(`affiliate backfill failed: ${(err as Error).message}`);
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
