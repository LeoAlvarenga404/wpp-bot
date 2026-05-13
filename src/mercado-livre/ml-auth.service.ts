import { HttpService } from '@nestjs/axios';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs/promises';
import * as path from 'path';
import { firstValueFrom } from 'rxjs';

const TOKEN_URL = 'https://api.mercadolibre.com/oauth/token';
const RENEW_SAFETY_MS = 5 * 60 * 1000;

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

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit() {
    const authDir = this.config.get<string>('WA_AUTH_DIR', './auth_info');
    this.tokenFile = path.join(authDir, 'ml-token.json');
    await this.loadFromFile();
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
    await this.saveToFile(stored);
    this.token = stored;
    this.logger.log(`Token stored. user_id=${stored.user_id} expires_in=${data.expires_in}s`);
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
    if (!this.token?.refresh_token) {
      throw new Error('No refresh_token available. Re-authorize via /oauth/authorize.');
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
    await this.saveToFile(stored);
    this.token = stored;
    this.logger.log('Token refreshed.');
    return stored.access_token;
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

  private async saveToFile(token: StoredToken): Promise<void> {
    await fs.mkdir(path.dirname(this.tokenFile), { recursive: true });
    await fs.writeFile(this.tokenFile, JSON.stringify(token, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
  }

  private async loadFromFile(): Promise<void> {
    try {
      const raw = await fs.readFile(this.tokenFile, 'utf8');
      this.token = JSON.parse(raw) as StoredToken;
      this.logger.log(
        `Loaded ML token from file. user_id=${this.token.user_id} expires_at=${new Date(
          this.token.expires_at,
        ).toISOString()}`,
      );
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        this.logger.warn(
          'No ML token file found. Visit GET /oauth/authorize to authorize.',
        );
      } else {
        this.logger.error('Failed to load ML token file', err);
      }
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
