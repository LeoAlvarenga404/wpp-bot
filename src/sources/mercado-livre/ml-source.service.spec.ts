// src/sources/mercado-livre/ml-source.service.spec.ts

import { MLSource } from './ml-source.service';
import type { MercadoLivreService } from '../../mercado-livre/ml.service';
import type { EnrichmentService } from '../../enrichment/enrichment.service';
import type { FeedRotatorService } from './feed-rotator.service';
import type { DealItem } from '../../mercado-livre/types';
import type { EnrichedDeal as MLEnriched } from '../../enrichment/types';

function makeMlDeal(id: string): DealItem {
  return {
    catalogId: id,
    itemId: 'I_' + id,
    title: 'T',
    thumbnail: '',
    price: 100,
    originalPrice: 200,
    sellerId: 7,
    freeShipping: true,
    permalink: 'p',
    discountPercent: 50,
  };
}

function makeDeps(opts: { feeds: { feedId: string; weight: number }[] }) {
  const ml = {
    getDealsFromHighlights: jest.fn(async ({ category }: { category: string }) => [
      makeMlDeal(`${category}_DEAL`),
    ]),
  } as unknown as MercadoLivreService;
  const enrichment = {
    enrichMany: jest.fn(async (deals: DealItem[]): Promise<MLEnriched[]> =>
      deals.map((d) => ({
        ...d,
        seller: {
          sellerId: d.sellerId,
          nickname: 's',
          powerSellerStatus: 'gold',
          reputationLevel: '5_green',
          isOfficialStore: false,
          officialStoreId: null,
          ratingAverage: 4.5,
          fetchedAt: '2026-05-14T00:00:00.000Z',
        },
        item: {
          itemId: d.itemId,
          soldQuantity: 50,
          condition: 'new',
          hasInstallmentsNoInterest: true,
        },
      })),
    ),
  } as unknown as EnrichmentService;
  const rotator = {
    getWeighted: jest.fn(() => opts.feeds),
    pick: jest.fn(() => opts.feeds[0]?.feedId ?? null),
  } as unknown as FeedRotatorService;
  return { ml, enrichment, rotator };
}

describe('MLSource', () => {
  it('id is "ml"', () => {
    const deps = makeDeps({ feeds: [] });
    const src = new MLSource(deps.ml, deps.enrichment, deps.rotator, {
      minDiscount: 25,
      maxPerFeed: 10,
    });
    expect(src.id).toBe('ml');
  });

  it('discover() fans out across all weighted feeds', async () => {
    const deps = makeDeps({
      feeds: [
        { feedId: 'MLB1648', weight: 1 },
        { feedId: 'MLB1000', weight: 1 },
      ],
    });
    const src = new MLSource(deps.ml, deps.enrichment, deps.rotator, {
      minDiscount: 25,
      maxPerFeed: 5,
    });
    const raws = await src.discover();
    expect(raws).toHaveLength(2);
    expect(raws.map((r) => r.feedId).sort()).toEqual(['MLB1000', 'MLB1648']);
    expect(raws.every((r) => r.key.source === 'ml')).toBe(true);
  });

  it('discoverOne() uses rotator pick and queries only that feed', async () => {
    const deps = makeDeps({
      feeds: [
        { feedId: 'MLB1648', weight: 1 },
        { feedId: 'MLB1000', weight: 1 },
      ],
    });
    const src = new MLSource(deps.ml, deps.enrichment, deps.rotator, {
      minDiscount: 25,
      maxPerFeed: 5,
    });
    const raws = await src.discoverOne();
    expect(raws).toHaveLength(1);
    expect(raws[0].feedId).toBe('MLB1648');
    expect(deps.ml.getDealsFromHighlights).toHaveBeenCalledTimes(1);
  });

  it('discover() isolates failures per feed', async () => {
    const deps = makeDeps({
      feeds: [
        { feedId: 'MLB1648', weight: 1 },
        { feedId: 'BROKEN', weight: 1 },
      ],
    });
    (deps.ml.getDealsFromHighlights as jest.Mock).mockImplementation(
      async ({ category }: { category: string }) => {
        if (category === 'BROKEN') throw new Error('boom');
        return [makeMlDeal(`${category}_DEAL`)];
      },
    );
    const src = new MLSource(deps.ml, deps.enrichment, deps.rotator, {
      minDiscount: 25,
      maxPerFeed: 5,
    });
    const raws = await src.discover();
    expect(raws).toHaveLength(1);
    expect(raws[0].feedId).toBe('MLB1648');
  });

  it('enrichMany() maps ML enriched into normalized EnrichedDeal', async () => {
    const deps = makeDeps({ feeds: [] });
    const src = new MLSource(deps.ml, deps.enrichment, deps.rotator, {
      minDiscount: 25,
      maxPerFeed: 5,
    });
    const raw = {
      key: { source: 'ml' as const, externalId: 'MLB1' },
      title: 'T',
      priceCents: 10000,
      originalPriceCents: 20000,
      discountPercent: 50,
      thumbnail: '',
      permalink: 'p',
      feedId: 'MLB1648',
    };
    const out = await src.enrichMany([raw]);
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe('ml');
    expect(out[0].seller?.sellerTrust).toBe('high');
    expect(out[0].condition).toBe('new');
    expect(out[0].signals.volumeTier).toBe('low'); // sold=50 → low
    expect(out[0].signals.installmentsNoInterest).toBe(true);
  });
});
