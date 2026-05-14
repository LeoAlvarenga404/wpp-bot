// src/pipeline/pipeline.service.spec.ts

jest.mock('@whiskeysockets/baileys', () => ({}));
jest.mock('@hapi/boom', () => ({ Boom: class Boom {} }));
jest.mock('@sentry/node', () => ({ captureException: jest.fn(), init: jest.fn() }));
jest.mock('../whatsapp/wa.service');

import { ConfigService } from '@nestjs/config';
import { PipelineService } from './pipeline.service';
import type { DealSourcePort, RawDeal, EnrichedDeal } from '../sources/source.port';
import type { ScoredDeal } from '../deal-score/types';

function rawFor(id: string, priceCents = 10000): RawDeal {
  return {
    key: { source: 'ml', externalId: id },
    title: 'T',
    priceCents,
    originalPriceCents: priceCents * 2,
    discountPercent: 50,
    thumbnail: '',
    permalink: 'p',
    feedId: 'MLB1648',
  };
}

function enrichedFor(raw: RawDeal): EnrichedDeal {
  return {
    key: raw.key,
    source: 'ml',
    raw,
    seller: {
      externalSellerId: '1',
      displayName: 'S',
      sellerTrust: 'high',
      isVerifiedStore: false,
      ratingAverage: 0.9,
      fetchedAt: '2026-05-14T00:00:00.000Z',
    },
    condition: 'new',
    signals: {
      freeShipping: true,
      installmentsNoInterest: false,
      volumeTier: 'low',
      isVerifiedStore: false,
    },
    extras: {},
  };
}

function makeDeps(opts: { rawDeals: RawDeal[]; failingId?: string }) {
  const fakeSource: DealSourcePort = {
    id: 'ml',
    discover: jest.fn(async () => opts.rawDeals),
    discoverOne: jest.fn(async () => opts.rawDeals.slice(0, 1)),
    enrichMany: jest.fn(async (rs: RawDeal[]) => rs.map(enrichedFor)),
  };
  const registry = {
    getById: jest.fn((id: string) => {
      if (id === 'ml') return fakeSource;
      throw new Error('Unknown');
    }),
    getAll: jest.fn(() => [fakeSource]),
  } as any;

  const ml = { getDealsFromHighlights: jest.fn() } as any; // unused — kept for legacy DI
  const wa = { isReady: () => true, sendImage: jest.fn(), sendText: jest.fn() } as any;
  const formatter = {
    formatScored: jest.fn(async () => ({ caption: 'cap', imageUrl: '' })),
  } as any;
  const dedup = {
    wasRecentlyPosted: jest.fn(async (key: string) =>
      opts.failingId ? key.endsWith(opts.failingId) : false,
    ),
    markPosted: jest.fn(async () => undefined),
  } as any;
  const curation = {
    record: jest.fn(async () => undefined),
    isFakeDiscount: jest.fn(() => false),
    getAnalytics: jest.fn(() => ({
      median7d: null,
      median14d: null,
      median30d: null,
      min7d: null,
      min14d: null,
      min30d: null,
      distinctDays: 10,
    })),
    getObservations: jest.fn(() => []),
  } as any;
  const dealScore = {
    computeWithObservations: jest.fn(
      (e: EnrichedDeal): ScoredDeal => ({
        deal: e as any,
        score: 80,
        rawScore: 80,
        level: 'good',
        reasons: [],
        penalties: [],
        factors: {},
      }),
    ),
  } as any;
  const config = { get: (_k: string, def?: string) => def } as unknown as ConfigService;

  return {
    fakeSource,
    registry,
    pipeline: new PipelineService(
      ml,
      wa,
      formatter,
      config,
      dedup,
      curation,
      registry,
      dealScore,
    ),
    dedup,
    curation,
    dealScore,
    formatter,
    wa,
  };
}

describe('PipelineService.collectScored(sourceId)', () => {
  it('records each survivor under composite key "ml:..."', async () => {
    const d = makeDeps({ rawDeals: [rawFor('MLB1'), rawFor('MLB2')] });
    await d.pipeline.collectScored('ml');
    expect(d.curation.record).toHaveBeenCalledWith('ml:MLB1', 10000);
    expect(d.curation.record).toHaveBeenCalledWith('ml:MLB2', 10000);
  });

  it('skips deals already posted', async () => {
    const d = makeDeps({
      rawDeals: [rawFor('MLB1'), rawFor('MLB2')],
      failingId: 'MLB1',
    });
    const out = await d.pipeline.collectScored('ml');
    expect(out.map((s) => (s.deal as any).key.externalId)).toEqual(['MLB2']);
  });

  it('scores survivors and returns sorted desc', async () => {
    const d = makeDeps({ rawDeals: [rawFor('MLB1'), rawFor('MLB2')] });
    (d.dealScore.computeWithObservations as jest.Mock)
      .mockImplementationOnce((e: EnrichedDeal): ScoredDeal => ({
        deal: e as any, score: 70, rawScore: 70, level: 'good',
        reasons: [], penalties: [], factors: {},
      }))
      .mockImplementationOnce((e: EnrichedDeal): ScoredDeal => ({
        deal: e as any, score: 90, rawScore: 90, level: 'top',
        reasons: [], penalties: [], factors: {},
      }));
    const out = await d.pipeline.collectScored('ml');
    // After filtering (default MIN=75) only the 90 survives:
    expect(out.map((s) => s.score)).toEqual([90]);
  });
});

describe('PipelineService.collectScoredOne(sourceId)', () => {
  it('uses discoverOne and returns scored', async () => {
    const d = makeDeps({ rawDeals: [rawFor('MLB1')] });
    const out = await d.pipeline.collectScoredOne('ml');
    expect(d.fakeSource.discoverOne).toHaveBeenCalled();
    expect(out).toHaveLength(1);
  });
});

describe('PipelineService.collectAllScored', () => {
  it('iterates all registered sources', async () => {
    const d = makeDeps({ rawDeals: [rawFor('MLB1')] });
    const out = await d.pipeline.collectAllScored();
    expect(d.registry.getAll).toHaveBeenCalled();
    expect(out).toHaveLength(1);
  });
});
