// src/sources/mercado-livre/ml-source.service.ts

import { Inject, Injectable, Logger } from '@nestjs/common';
import { EnrichmentService } from '../../enrichment/enrichment.service';
import { MercadoLivreService } from '../../mercado-livre/ml.service';
import type { DealItem } from '../../mercado-livre/types';
import { DealSourcePort, EnrichedDeal, RawDeal } from '../source.port';
import { FeedRotatorService } from './feed-rotator.service';
import { toEnrichedDeal, toRawDeal } from './mapping';

interface MLSourceOpts {
  minDiscount: number;
  maxPerFeed: number;
}

export const ML_SOURCE_OPTS = Symbol('ML_SOURCE_OPTS');

@Injectable()
export class MLSource implements DealSourcePort {
  readonly id = 'ml' as const;
  private readonly logger = new Logger(MLSource.name);
  private readonly rawIndex = new Map<string, DealItem>();

  constructor(
    private readonly ml: MercadoLivreService,
    private readonly enrichment: EnrichmentService,
    private readonly rotator: FeedRotatorService,
    @Inject(ML_SOURCE_OPTS) private readonly opts: MLSourceOpts,
  ) {}

  async discover(): Promise<RawDeal[]> {
    const feeds = this.rotator.getWeighted();
    const all: RawDeal[] = [];
    this.rawIndex.clear();
    for (const { feedId } of feeds) {
      try {
        const deals = await this.ml.getDealsFromHighlights({
          category: feedId,
          minDiscount: this.opts.minDiscount,
          max: this.opts.maxPerFeed,
        });
        for (const d of deals) {
          const raw = toRawDeal(d, feedId);
          this.rawIndex.set(raw.key.externalId, d);
          all.push(raw);
        }
      } catch (err) {
        this.logger.warn(
          `MLSource discover feed=${feedId} failed: ${(err as Error).message}`,
        );
      }
    }
    return all;
  }

  async discoverOne(): Promise<RawDeal[]> {
    const feedId = this.rotator.pick();
    if (!feedId) return [];
    this.rawIndex.clear();
    try {
      const deals = await this.ml.getDealsFromHighlights({
        category: feedId,
        minDiscount: this.opts.minDiscount,
        max: this.opts.maxPerFeed,
      });
      const raws: RawDeal[] = [];
      for (const d of deals) {
        const raw = toRawDeal(d, feedId);
        this.rawIndex.set(raw.key.externalId, d);
        raws.push(raw);
      }
      return raws;
    } catch (err) {
      this.logger.warn(
        `MLSource discoverOne feed=${feedId} failed: ${(err as Error).message}`,
      );
      return [];
    }
  }

  async enrichMany(raws: RawDeal[]): Promise<EnrichedDeal[]> {
    const dealItems: DealItem[] = raws.map((r) => {
      const cached = this.rawIndex.get(r.key.externalId);
      if (cached) return cached;
      return this.fallbackDealItem(r);
    });
    const enrichedML = await this.enrichment.enrichMany(dealItems);
    return enrichedML.map((e, i) =>
      toEnrichedDeal(
        raws[i],
        e.seller,
        e.item,
        dealItems[i].freeShipping,
        dealItems[i].isFull ?? false,
      ),
    );
  }

  private fallbackDealItem(r: RawDeal): DealItem {
    return {
      catalogId: r.key.externalId,
      itemId: '',
      title: r.title,
      thumbnail: r.thumbnail,
      price: r.priceCents / 100,
      originalPrice: (r.originalPriceCents ?? 0) / 100,
      sellerId: 0,
      freeShipping: false,
      permalink: r.permalink,
      discountPercent: r.discountPercent,
    };
  }
}
