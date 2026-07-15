import { Inject, Injectable, Logger } from '@nestjs/common';
import { DealSourcePort, EnrichedDeal, RawDeal } from '../source.port';
import { ShopeeClient } from './shopee-client';
import { ShopeeOfferNode, toEnrichedDeal, toRawDeal } from './mapping';

export const SHOPEE_SOURCE_OPTS = Symbol('SHOPEE_SOURCE_OPTS');

export interface ShopeeSourceOpts {
  keywords: string[];
  limitPerKeyword: number;
}

export const SHOPEE_DEFAULT_KEYWORDS =
  'teclado mecanico,mouse gamer,headset gamer,smartwatch,caixa de som bluetooth,carregador turbo,fone bluetooth,hub usb c';

/** sortType do productOfferV2: ordenar por maior desconto. */
const SORT_BY_DISCOUNT_DESC = 5;

const PRODUCT_OFFER_QUERY = `
query ProductOffers($keyword: String, $sortType: Int, $page: Int, $limit: Int) {
  productOfferV2(keyword: $keyword, sortType: $sortType, page: $page, limit: $limit) {
    nodes {
      itemId
      productName
      price
      priceDiscountRate
      imageUrl
      offerLink
      productLink
      sales
      ratingStar
      shopName
      shopType
    }
  }
}`;

@Injectable()
export class ShopeeSource implements DealSourcePort {
  readonly id = 'shopee' as const;
  private readonly logger = new Logger(ShopeeSource.name);
  private readonly nodeIndex = new Map<string, ShopeeOfferNode>();
  private keywordCursor = 0;

  constructor(
    private readonly client: ShopeeClient,
    @Inject(SHOPEE_SOURCE_OPTS) private readonly opts: ShopeeSourceOpts,
  ) {}

  async discover(): Promise<RawDeal[]> {
    this.nodeIndex.clear();
    const all: RawDeal[] = [];
    for (const kw of this.opts.keywords) {
      try {
        all.push(...(await this.fetchKeyword(kw)));
      } catch (err) {
        this.logger.warn(
          `ShopeeSource discover kw="${kw}" failed: ${(err as Error).message}`,
        );
      }
    }
    return all;
  }

  async discoverOne(): Promise<RawDeal[]> {
    if (this.opts.keywords.length === 0) return [];
    const kw =
      this.opts.keywords[this.keywordCursor % this.opts.keywords.length];
    this.keywordCursor++;
    this.nodeIndex.clear();
    try {
      return await this.fetchKeyword(kw);
    } catch (err) {
      this.logger.warn(
        `ShopeeSource discoverOne kw="${kw}" failed: ${(err as Error).message}`,
      );
      return [];
    }
  }

  async enrichMany(raws: RawDeal[]): Promise<EnrichedDeal[]> {
    // O feed já traz loja/rating/vendas — zero chamadas extras.
    return raws.map((r) => {
      const node = this.nodeIndex.get(r.key.externalId);
      return toEnrichedDeal(r, node ?? this.fallbackNode(r));
    });
  }

  async ping(): Promise<{ ok: boolean; message?: string }> {
    try {
      await this.client.query({
        query: PRODUCT_OFFER_QUERY,
        variables: {
          keyword: this.opts.keywords[0] ?? 'teclado',
          sortType: SORT_BY_DISCOUNT_DESC,
          page: 1,
          limit: 1,
        },
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  private async fetchKeyword(kw: string): Promise<RawDeal[]> {
    const data = await this.client.query<{
      productOfferV2: { nodes: ShopeeOfferNode[] };
    }>({
      query: PRODUCT_OFFER_QUERY,
      variables: {
        keyword: kw,
        sortType: SORT_BY_DISCOUNT_DESC,
        page: 1,
        limit: this.opts.limitPerKeyword,
      },
    });
    const raws: RawDeal[] = [];
    for (const node of data.productOfferV2?.nodes ?? []) {
      const raw = toRawDeal(node, `kw:${kw}`);
      this.nodeIndex.set(raw.key.externalId, node);
      raws.push(raw);
    }
    return raws;
  }

  private fallbackNode(r: RawDeal): ShopeeOfferNode {
    return {
      itemId: r.key.externalId,
      productName: r.title,
      price: (r.priceCents / 100).toFixed(2),
      priceDiscountRate: r.discountPercent,
      imageUrl: r.thumbnail,
      offerLink: r.permalink,
      productLink: r.permalink,
      sales: null,
      ratingStar: null,
      shopName: null,
      shopType: null,
    };
  }
}
