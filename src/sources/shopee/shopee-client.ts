import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface ShopeeGraphQLRequest {
  query: string;
  variables?: Record<string, unknown>;
}

/**
 * Cliente da API GraphQL de afiliados da Shopee BR. Autenticação por
 * assinatura: SHA256(appId + timestamp + payload + secret) em hex, enviada
 * no header Authorization junto com Credential e Timestamp (segundos).
 */
@Injectable()
export class ShopeeClient {
  private readonly appId: string;
  private readonly secret: string;
  private readonly endpoint: string;
  private readonly timeoutMs: number;

  constructor(private readonly config: ConfigService) {
    this.appId = this.config.get<string>('SHOPEE_APP_ID') ?? '';
    this.secret = this.config.get<string>('SHOPEE_APP_SECRET') ?? '';
    this.endpoint =
      this.config.get<string>('SHOPEE_ENDPOINT') ??
      'https://open-api.affiliate.shopee.com.br/graphql';
    this.timeoutMs = Number(
      this.config.get<string>('SHOPEE_TIMEOUT_MS') ?? '8000',
    );
  }

  sign(timestamp: number, payload: string): string {
    return createHash('sha256')
      .update(`${this.appId}${timestamp}${payload}${this.secret}`)
      .digest('hex');
  }

  async query<T>(req: ShopeeGraphQLRequest): Promise<T> {
    const payload = JSON.stringify(req);
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = this.sign(timestamp, payload);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `SHA256 Credential=${this.appId}, Timestamp=${timestamp}, Signature=${signature}`,
        },
        body: payload,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`shopee status=${res.status} body=${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as {
      data?: T;
      errors?: Array<{ message?: string }>;
    };
    if (data.errors?.length) {
      throw new Error(`shopee graphql: ${data.errors[0]?.message ?? 'error'}`);
    }
    if (!data.data) throw new Error('shopee graphql: empty data');
    return data.data;
  }
}
