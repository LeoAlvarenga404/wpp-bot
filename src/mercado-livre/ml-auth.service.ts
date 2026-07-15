import { HttpService } from '@nestjs/axios';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as Sentry from '@sentry/node';
import * as fs from 'fs/promises';
import * as path from 'path';
import { firstValueFrom } from 'rxjs';
import { PrismaService } from '../db/prisma.service';

const TOKEN_URL = 'https://api.mercadolibre.com/oauth/token';
const RENEW_SAFETY_MS = 5 * 60 * 1000;
const PROACTIVE_SKEW_MS = 30 * 60 * 1000;

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
  user_id?: number;
  refresh_token?: string;
}

interface StoredToken {
  access_token: string;
  refresh_token: string | null;
  expires_at: number;
  user_id: number | null;
  scope: string;
  obtained_at: number;
}

@Injectable()
export class MercadoLivreAuthService implements OnModuleInit {
  private readonly logger = new Logger(MercadoLivreAuthService.name);
  private token: StoredToken | null = null;
  private inflight: Promise<string> | null = null;
  private tokenFile!: string;
  private readonly pendingStates = new Map<string, number>();
  private consecutiveRefreshFailures = 0;
  private lastRefreshAt: number | null = null;

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async onModuleInit() {
    const authDir = this.config.get<string>('WA_AUTH_DIR', './auth_info');
    this.tokenFile = path.join(authDir, 'ml-token.json');
    await this.loadFromDb();
    if (!this.token) {
      await this.backfillFromFile();
    }
  }

  buildAuthorizeUrl(state?: string): string {
    const clientId = this.requireEnv('ML_CLIENT_ID');
    const redirectUri = this.requireEnv('ML_REDIRECT_URI');
    const csrf = state ?? this.generateState();
    this.pendingStates.set(csrf, Date.now());
    this.cleanupOldStates();

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      state: csrf,
    });
    return `https://auth.mercadolivre.com.br/authorization?${params.toString()}`;
  }

  validateState(state: string): boolean {
    const ok = this.pendingStates.has(state);
    this.pendingStates.delete(state);
    return ok;
  }

  async exchangeCode(code: string): Promise<StoredToken> {
    const clientId = this.requireEnv('ML_CLIENT_ID');
    const clientSecret = this.requireEnv('ML_CLIENT_SECRET');
    const redirectUri = this.requireEnv('ML_REDIRECT_URI');

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    });

    this.logger.log('Exchanging authorization code for token...');
    const { data } = await firstValueFrom(
      this.http.post<TokenResponse>(TOKEN_URL, body.toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        timeout: 15000,
      }),
    );

    const stored = this.toStored(data);
    await this.persist(stored);
    this.token = stored;
    this.logger.log(
      `Token stored. user_id=${stored.user_id} expires_in=${data.expires_in}s`,
    );
    return stored;
  }

  async getAccessToken(): Promise<string> {
    if (!this.token) {
      throw new Error(
        'No ML token. Authorize via GET /oauth/authorize then complete callback.',
      );
    }
    if (Date.now() < this.token.expires_at - RENEW_SAFETY_MS) {
      return this.token.access_token;
    }
    if (this.inflight) return this.inflight;

    this.inflight = this.refresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async refresh(): Promise<string> {
    try {
      if (!this.token?.refresh_token) {
        throw new Error(
          'No refresh_token available. Re-authorize via /oauth/authorize.',
        );
      }
      const clientId = this.requireEnv('ML_CLIENT_ID');
      const clientSecret = this.requireEnv('ML_CLIENT_SECRET');

      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: this.token.refresh_token,
      });

      this.logger.log('Refreshing ML access token...');
      const { data } = await firstValueFrom(
        this.http.post<TokenResponse>(TOKEN_URL, body.toString(), {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
          timeout: 15000,
        }),
      );

      const stored = this.toStored(data);
      await this.persist(stored);
      this.token = stored;
      this.consecutiveRefreshFailures = 0;
      this.lastRefreshAt = Date.now();
      this.logger.log('Token refreshed.');
      return stored.access_token;
    } catch (err: any) {
      this.consecutiveRefreshFailures += 1;
      this.logger.warn(
        `ML token refresh failed (consecutive=${this.consecutiveRefreshFailures}): ${
          err?.response?.status ?? err?.message
        }`,
      );
      if (this.consecutiveRefreshFailures >= 3) {
        this.logger.error('ML reauth required — visit /oauth/authorize');
        try {
          Sentry.captureMessage('ML reauth required', 'error');
        } catch {
          // Sentry not initialized → no-op
        }
      }
      throw err;
    }
  }

  /**
   * P0-8: Public entry point for the scheduled token-refresher job.
   * Triggers a refresh when the access token is within 30 minutes of expiry.
   * Safe to call concurrently — coalesces via the same `inflight` promise as
   * `getAccessToken`.
   */
  async proactiveRefresh(): Promise<string | null> {
    if (!this.token) return null;
    if (Date.now() < this.token.expires_at - PROACTIVE_SKEW_MS) {
      return this.token.access_token;
    }
    if (this.inflight) return this.inflight;
    this.inflight = this.refresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  getStatus(): {
    hasToken: boolean;
    expiresAt: string | null;
    lastRefresh: string | null;
    consecutiveFailures: number;
  } {
    return {
      hasToken: !!this.token,
      expiresAt: this.token
        ? new Date(this.token.expires_at).toISOString()
        : null,
      lastRefresh: this.lastRefreshAt
        ? new Date(this.lastRefreshAt).toISOString()
        : null,
      consecutiveFailures: this.consecutiveRefreshFailures,
    };
  }

  getExpiresAt(): number | null {
    return this.token?.expires_at ?? null;
  }

  private toStored(data: TokenResponse): StoredToken {
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token ?? null,
      expires_at: Date.now() + data.expires_in * 1000,
      user_id: data.user_id ?? null,
      scope: data.scope,
      obtained_at: Date.now(),
    };
  }

  private async persist(token: StoredToken): Promise<void> {
    try {
      await (this.prisma as any).mlToken.upsert({
        where: { id: 1 },
        create: {
          id: 1,
          accessToken: token.access_token,
          refreshToken: token.refresh_token,
          expiresAt: new Date(token.expires_at),
          userId: token.user_id != null ? BigInt(token.user_id) : null,
          scope: token.scope,
        },
        update: {
          accessToken: token.access_token,
          refreshToken: token.refresh_token,
          expiresAt: new Date(token.expires_at),
          userId: token.user_id != null ? BigInt(token.user_id) : null,
          scope: token.scope,
        },
      });
    } catch (err) {
      this.logger.error('Failed to persist ML token to DB', err as Error);
      throw err;
    }
  }

  private async loadFromDb(): Promise<void> {
    try {
      const row = await (this.prisma as any).mlToken.findUnique({
        where: { id: 1 },
      });
      if (!row) return;
      this.token = {
        access_token: row.accessToken,
        refresh_token: row.refreshToken ?? null,
        expires_at: row.expiresAt.getTime(),
        user_id: row.userId != null ? Number(row.userId) : null,
        scope: row.scope,
        obtained_at: row.updatedAt ? row.updatedAt.getTime() : Date.now(),
      };
      this.logger.log(
        `Loaded ML token from DB. user_id=${this.token.user_id} expires_at=${new Date(
          this.token.expires_at,
        ).toISOString()}`,
      );
    } catch (err) {
      this.logger.error('Failed to load ML token from DB', err as Error);
    }
  }

  /**
   * One-shot import from auth_info/ml-token.json into the DB. Runs only when
   * the DB has no token yet — repeated boots are no-ops.
   */
  private async backfillFromFile(): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(this.tokenFile, 'utf8');
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        this.logger.warn(
          'No ML token in DB or file. Visit GET /oauth/authorize to authorize.',
        );
      } else {
        this.logger.error('Failed to read legacy ML token file', err);
      }
      return;
    }
    try {
      const parsed = JSON.parse(raw) as StoredToken;
      await this.persist(parsed);
      this.token = parsed;
      this.logger.log(
        `Backfilled ML token from ${this.tokenFile} into DB. user_id=${parsed.user_id}`,
      );
    } catch (err) {
      this.logger.error('Failed to backfill ML token from file', err as Error);
    }
  }

  private requireEnv(key: string): string {
    const v = this.config.get<string>(key);
    if (!v) throw new Error(`${key} not set in .env`);
    return v;
  }

  private generateState(): string {
    return (
      Math.random().toString(36).slice(2) +
      Date.now().toString(36) +
      Math.random().toString(36).slice(2)
    );
  }

  private cleanupOldStates() {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [k, t] of this.pendingStates) {
      if (t < cutoff) this.pendingStates.delete(k);
    }
  }

  hasToken(): boolean {
    return !!this.token;
  }
}
