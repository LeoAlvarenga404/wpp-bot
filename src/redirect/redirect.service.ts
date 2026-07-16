import { randomBytes } from 'node:crypto';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../db/prisma.service';
import { CountersService } from '../metrics/counters.service';

const CODE_ALPHABET =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const CODE_LENGTH = 7;
const MAX_CODE_ATTEMPTS = 3;

export interface ShortLinkRow {
  id: string;
  code: string;
  url: string;
  dealKey: string | null;
  channel: string | null;
  clicks: number;
  createdAt: Date;
}

export interface ShortenMeta {
  dealKey?: string;
  channel?: string;
}

/**
 * Click-tracking short links (CTR). `shorten()` maps an affiliate URL to
 * `${REDIRECT_BASE_URL}/r/<code>`; RedirectController serves the 302 back and
 * counts the click. Feature is OFF while REDIRECT_BASE_URL is empty (default):
 * `wrapIfEnabled()` returns the original url untouched, so captions don't
 * change until a public domain is deployed.
 */
@Injectable()
export class RedirectService {
  private readonly logger = new Logger(RedirectService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly counters?: CountersService,
  ) {}

  /** Empty string = feature disabled. Trailing slashes stripped. */
  private baseUrl(): string {
    return (process.env.REDIRECT_BASE_URL ?? '').trim().replace(/\/+$/, '');
  }

  isEnabled(): boolean {
    return this.baseUrl().length > 0;
  }

  /**
   * Wrap `url` in a tracked short link when the feature is on; otherwise (or
   * on any DB error) return `url` unchanged — a caption must never fail or
   * lose its link because the redirector is down.
   */
  async wrapIfEnabled(url: string, meta?: ShortenMeta): Promise<string> {
    if (!this.isEnabled()) return url;
    try {
      return await this.shorten(url, meta);
    } catch (err) {
      this.logger.warn(
        `shorten failed for ${url} — using raw link: ${String(err)}`,
      );
      return url;
    }
  }

  /**
   * Returns the full short URL for `url`, reusing an existing row for the
   * same url+dealKey+channel (findFirst-then-create; a rare duplicate row is
   * harmless — clicks would just split across codes).
   */
  async shorten(url: string, meta?: ShortenMeta): Promise<string> {
    const base = this.baseUrl();
    if (!base) throw new Error('REDIRECT_BASE_URL is not set');
    const dealKey = meta?.dealKey ?? null;
    const channel = meta?.channel ?? null;

    const existing = (await this.model().findFirst({
      where: { url, dealKey, channel },
    })) as ShortLinkRow | null;
    if (existing) return `${base}/r/${existing.code}`;

    for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
      const code = this.randomCode();
      try {
        const row = (await this.model().create({
          data: { code, url, dealKey, channel },
        })) as ShortLinkRow;
        return `${base}/r/${row.code}`;
      } catch (err) {
        // P2002 = unique violation on code — regenerate and retry.
        if ((err as { code?: string })?.code === 'P2002') continue;
        throw err;
      }
    }
    throw new Error(
      `could not allocate a unique short code after ${MAX_CODE_ATTEMPTS} attempts`,
    );
  }

  async resolve(code: string): Promise<ShortLinkRow | null> {
    return (await this.model().findUnique({
      where: { code },
    })) as ShortLinkRow | null;
  }

  /** Fire-and-forget click increment — never blocks or throws. */
  trackClick(code: string): void {
    this.counters?.redirectClick.inc();
    void this.model()
      .update({ where: { code }, data: { clicks: { increment: 1 } } })
      .catch((err: unknown) => {
        this.logger.warn(`click increment failed for ${code}: ${String(err)}`);
      });
  }

  private randomCode(): string {
    const bytes = randomBytes(CODE_LENGTH);
    let out = '';
    for (let i = 0; i < CODE_LENGTH; i++) {
      out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    }
    return out;
  }

  // Same pattern as CouponRepository: the generated client only has the model
  // after `prisma generate` runs against the updated schema.
  private model() {
    return (this.prisma as any).shortLink;
  }
}
