import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { MercadoLivreAuthService } from './ml-auth.service';
import {
  DealItem,
  HighlightsResponse,
  MLProduct,
  MLProductItem,
  MLProductItemsResponse,
} from './types';

const BASE_URL = 'https://api.mercadolibre.com';
const PARALLEL_LIMIT = 6;

@Injectable()
export class MercadoLivreService {
  private readonly logger = new Logger(MercadoLivreService.name);
  private readonly siteId: string;

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
    private readonly auth: MercadoLivreAuthService,
  ) {
    this.siteId = this.config.get<string>('ML_SITE_ID', 'MLB');
  }

  async getDealsFromHighlights(opts: {
    category: string;
    minDiscount: number;
    max: number;
  }): Promise<DealItem[]> {
    const { category, minDiscount, max } = opts;
    const highlights = await this.fetchHighlights(category);
    const catalogIds = highlights.content
      .filter((c) => c.type === 'PRODUCT')
      .map((c) => c.id);

    this.logger.log(`Highlights ${category}: ${catalogIds.length} catalog IDs`);

    const deals: DealItem[] = [];
    for (let i = 0; i < catalogIds.length; i += PARALLEL_LIMIT) {
      const batch = catalogIds.slice(i, i + PARALLEL_LIMIT);
      const results = await Promise.all(
        batch.map((id) => this.tryBuildDeal(id, minDiscount)),
      );
      for (const d of results) if (d) deals.push(d);
      if (deals.length >= max * 3) break;
    }

    deals.sort((a, b) => b.discountPercent - a.discountPercent);
    return deals.slice(0, max);
  }

  private async tryBuildDeal(
    catalogId: string,
    minDiscount: number,
  ): Promise<DealItem | null> {
    try {
      const [product, itemsResp] = await Promise.all([
        this.fetchProduct(catalogId),
        this.fetchProductItems(catalogId),
      ]);

      if (!product || product.status !== 'active') return null;

      const best = this.pickBestItem(itemsResp.results, minDiscount);
      if (!best) return null;

      const originalPrice = best.original_price!;
      const discountPercent = Math.round(
        ((originalPrice - best.price) / originalPrice) * 100,
      );

      return {
        catalogId,
        itemId: best.item_id,
        title: product.name,
        thumbnail: product.pictures?.[0]?.url ?? '',
        price: best.price,
        originalPrice,
        sellerId: best.seller_id,
        freeShipping: !!best.shipping?.free_shipping,
        permalink: `https://www.mercadolivre.com.br/p/${catalogId}`,
        discountPercent,
      };
    } catch (err: any) {
      this.logger.warn(
        `tryBuildDeal(${catalogId}) failed: ${err?.response?.status ?? err?.message}`,
      );
      return null;
    }
  }

  private pickBestItem(
    items: MLProductItem[],
    minDiscount: number,
  ): MLProductItem | null {
    const qualifying = items
      .filter((i) => i.original_price && i.original_price > i.price)
      .filter((i) => {
        const disc = ((i.original_price! - i.price) / i.original_price!) * 100;
        return disc >= minDiscount;
      })
      .sort((a, b) => {
        const da = (a.original_price! - a.price) / a.original_price!;
        const db = (b.original_price! - b.price) / b.original_price!;
        return db - da;
      });
    return qualifying[0] ?? null;
  }

  private async fetchHighlights(category: string): Promise<HighlightsResponse> {
    return this.get<HighlightsResponse>(
      `/highlights/${this.siteId}/category/${category}`,
    );
  }

  private async fetchProduct(catalogId: string): Promise<MLProduct> {
    return this.get<MLProduct>(`/products/${catalogId}`);
  }

  private async fetchProductItems(catalogId: string): Promise<MLProductItemsResponse> {
    return this.get<MLProductItemsResponse>(
      `/products/${catalogId}/items?limit=10`,
    );
  }

  private async get<T>(pathAndQuery: string): Promise<T> {
    const token = await this.auth.getAccessToken();
    const url = `${BASE_URL}${pathAndQuery}`;
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
  }
}
