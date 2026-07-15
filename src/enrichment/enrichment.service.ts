import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';
import { MercadoLivreAuthService } from '../mercado-livre/ml-auth.service';
import { DealItem } from '../mercado-livre/types';
import { withRetry } from '../shared/retry';
import { SellerCacheService } from './seller-cache.service';
import { EnrichedDeal, ItemDetails, SellerInfo } from './types';

const BASE_URL = 'https://api.mercadolibre.com';
const PARALLEL_LIMIT = 6;

@Injectable()
export class EnrichmentService {
  private readonly logger = new Logger(EnrichmentService.name);

  constructor(
    private readonly http: HttpService,
    private readonly auth: MercadoLivreAuthService,
    private readonly cache: SellerCacheService,
  ) {}

  async enrich(deal: DealItem): Promise<EnrichedDeal> {
    // ML now answers 403 on /items/{id} for items the app does not own, and
    // 404 when a resource is gone. Both are terminal, per-resource conditions
    // that must degrade to null WITHOUT discarding the sibling call — a 403 on
    // the item must not throw away seller reputation that came back 200, or
    // every deal reads as "vendedor não identificado" and the judge rejects it.
    // 5xx/network errors still propagate so enrichMany can fall back and log.
    const nonFatal = (err: any): null => {
      const status = err?.response?.status;
      if (status === 403 || status === 404) return null;
      throw err;
    };
    const [seller, item] = await Promise.all([
      this.getSeller(deal.sellerId).catch(nonFatal),
      this.getItem(deal.itemId).catch(nonFatal),
    ]);
    return { ...deal, seller, item };
  }

  async enrichMany(deals: DealItem[]): Promise<EnrichedDeal[]> {
    const out: EnrichedDeal[] = [];
    for (let i = 0; i < deals.length; i += PARALLEL_LIMIT) {
      const batch = deals.slice(i, i + PARALLEL_LIMIT);
      const results = await Promise.all(
        batch.map((d) =>
          this.enrich(d).catch((err) => {
            this.logger.warn(`enrich ${d.catalogId} failed: ${err?.message}`);
            return { ...d, seller: null, item: null };
          }),
        ),
      );
      out.push(...results);
    }
    return out;
  }

  private async getSeller(sellerId: number): Promise<SellerInfo | null> {
    const cached = this.cache.get(sellerId);
    if (cached) return cached;
    const data = await this.get<any>(`/users/${sellerId}`);
    const info: SellerInfo = {
      sellerId,
      nickname: data?.nickname ?? null,
      powerSellerStatus: data?.seller_reputation?.power_seller_status ?? null,
      reputationLevel: data?.seller_reputation?.level_id ?? null,
      isOfficialStore: !!data?.eshop?.eshop_id,
      officialStoreId: data?.eshop?.eshop_id ?? null,
      ratingAverage: data?.seller_reputation?.metrics?.rating ?? null,
      fetchedAt: new Date().toISOString(),
    };
    await this.cache.set(info);
    return info;
  }

  private async getItem(itemId: string): Promise<ItemDetails | null> {
    const data = await this.get<any>(`/items/${itemId}`);
    const installments = data?.installments;
    const hasNoInterest =
      !!installments &&
      typeof installments.rate === 'number' &&
      installments.rate === 0;
    let condition: ItemDetails['condition'] = 'not_specified';
    const raw = (data?.condition ?? '').toString().toLowerCase();
    if (raw === 'new' || raw === 'used' || raw === 'refurbished')
      condition = raw;
    return {
      itemId,
      soldQuantity:
        typeof data?.sold_quantity === 'number' ? data.sold_quantity : null,
      condition,
      hasInstallmentsNoInterest: hasNoInterest,
    };
  }

  private async get<T>(pathAndQuery: string): Promise<T> {
    const token = await this.auth.getAccessToken();
    const url = `${BASE_URL}${pathAndQuery}`;
    return withRetry<T>(
      async () => {
        const { data } = await firstValueFrom(
          this.http.get<T>(url, {
            headers: {
              Accept: 'application/json',
              Authorization: `Bearer ${token}`,
              'User-Agent': 'wpp-bot/0.1 (+local-dev)',
            },
            timeout: 15000,
          }),
        );
        return data;
      },
      { maxAttempts: 3, baseMs: 800, maxMs: 20_000, jitterPct: 0.25 },
    );
  }
}
