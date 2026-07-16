// src/pipeline/pipeline.service.spec.ts

jest.mock('@whiskeysockets/baileys', () => ({}));
jest.mock('@hapi/boom', () => ({ Boom: class Boom {} }));
jest.mock('@sentry/node', () => ({
  captureException: jest.fn(),
  init: jest.fn(),
}));
jest.mock('../whatsapp/wa.service');

import { ConfigService } from '@nestjs/config';
import { PipelineService } from './pipeline.service';
import type {
  DealSourcePort,
  RawDeal,
  EnrichedDeal,
} from '../sources/source.port';
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
  const wa = {
    isReady: () => true,
    sendImage: jest.fn(),
    sendText: jest.fn(),
  } as any;
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
    getLowestPriceBadge: jest.fn(() => null),
    historyDays: jest.fn(() => 0),
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
  // Gate fake mirrors real behavior: dedup screen + top-max pass-through with
  // variant 'A'. Judge/decision recording are exercised in the gate's own spec.
  const gate = {
    screenRaw: jest.fn(async (raw: RawDeal) => {
      const keyStr = `${raw.key.source}:${raw.key.externalId}`;
      return !(await dedup.wasRecentlyPosted(keyStr));
    }),
    recordPrescoreCut: jest.fn(async () => undefined),
    recordScoreReject: jest.fn(async () => undefined),
    selectForDispatch: jest.fn(async (scored: ScoredDeal[], max: number) =>
      [...scored]
        .sort((a, b) => b.score - a.score)
        .slice(0, max)
        .map((sd) => ({ scored: sd, variant: 'A' as const })),
    ),
    recordPosted: jest.fn(async () => undefined),
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
  const config = {
    get: (_k: string, def?: string) => def,
  } as unknown as ConfigService;

  const targets = {
    getActiveJids: jest.fn(async () => [] as string[]),
    getActiveTargets: jest.fn(async () => [] as unknown[]),
  } as any;
  const counters = {
    dedupSkip: { inc: jest.fn() },
    wppMessagesSent: { labels: jest.fn(() => ({ inc: jest.fn() })) },
    wppMessagesFailed: { labels: jest.fn(() => ({ inc: jest.fn() })) },
  } as any;
  const sendQueue = {
    add: jest.fn(async () => ({ id: 'job-id' })),
  } as any;
  const priceScraper = {
    scrapePriceView: jest.fn(async () => null),
  } as any;
  const coupons = {
    resolveForDeal: jest.fn(async () => null),
  } as any;

  return {
    fakeSource,
    registry,
    pipeline: new PipelineService(
      ml,
      wa,
      formatter,
      config,
      curation,
      gate,
      registry,
      dealScore,
      targets,
      sendQueue,
      priceScraper,
      coupons,
    ),
    dedup,
    gate,
    curation,
    dealScore,
    formatter,
    wa,
    targets,
    counters,
    sendQueue,
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
      .mockImplementationOnce(
        (e: EnrichedDeal): ScoredDeal => ({
          deal: e,
          score: 70,
          rawScore: 70,
          level: 'good',
          reasons: [],
          penalties: [],
          factors: {},
        }),
      )
      .mockImplementationOnce(
        (e: EnrichedDeal): ScoredDeal => ({
          deal: e,
          score: 90,
          rawScore: 90,
          level: 'top',
          reasons: [],
          penalties: [],
          factors: {},
        }),
      );
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

describe('PipelineService.enqueueScored', () => {
  function scoredFixture(): ScoredDeal {
    return {
      deal: enrichedFor(rawFor('MLB1')),
      score: 90,
      rawScore: 90,
      level: 'top',
      reasons: [],
      penalties: [],
      factors: {},
    };
  }

  it('enqueues one job per target with the target channel', async () => {
    const d = makeDeps({ rawDeals: [] });
    d.targets.getActiveTargets.mockResolvedValue([
      { jid: '123@g.us', name: 'g', active: true, channel: 'wa' },
      { jid: '-100555', name: 'tg', active: true, channel: 'telegram' },
    ]);

    const result = await d.pipeline.enqueueScored([scoredFixture()], 3);

    expect(result.enqueued).toBe(2);
    expect(result.targets).toBe(2);
    expect(d.sendQueue.add).toHaveBeenCalledWith(
      'send-deal',
      expect.objectContaining({
        targetJid: '123@g.us',
        channel: 'wa',
        variant: 'A',
      }),
      { jobId: expect.stringContaining('123@g.us') },
    );
    expect(d.gate.recordPosted).toHaveBeenCalledTimes(1);
    expect(d.sendQueue.add).toHaveBeenCalledWith(
      'send-deal',
      expect.objectContaining({ targetJid: '-100555', channel: 'telegram' }),
      { jobId: expect.stringContaining('-100555') },
    );
  });

  it('applies per-channel caps: telegram receives more deals than wa', async () => {
    const d = makeDeps({ rawDeals: [] });
    d.targets.getActiveTargets.mockResolvedValue([
      { jid: '123@g.us', name: 'g', active: true, channel: 'wa' },
      { jid: '-100555', name: 'tg', active: true, channel: 'telegram' },
    ]);
    (d.pipeline as any).config = {
      get: (k: string, def?: string) => {
        if (k === 'MAX_DEALS_PER_RUN_WA') return '1';
        if (k === 'MAX_DEALS_PER_RUN_TELEGRAM') return '3';
        if (k === 'WA_DIGEST_SIZE') return '1';
        return def;
      },
    };
    const scored = [90, 85, 80].map((s, i) => ({
      ...scoredFixture(),
      score: s,
      deal: enrichedFor(rawFor(`MLB${i + 1}`)),
    }));

    const result = await d.pipeline.enqueueScored(scored);

    const calls = (d.sendQueue.add as jest.Mock).mock.calls;
    const waJobs = calls.filter(([, data]) => data.channel === 'wa');
    const tgJobs = calls.filter(([, data]) => data.channel === 'telegram');
    expect(waJobs).toHaveLength(1);
    expect(tgJobs).toHaveLength(3);
    expect(result.enqueued).toBe(4);
    expect(d.gate.selectForDispatch).toHaveBeenCalledWith(
      expect.anything(),
      3, // max(waCap=1, tgCap=3)
    );
  });

  it('bundles wa deals into a send-digest job; telegram stays 1 job per deal', async () => {
    const d = makeDeps({ rawDeals: [] });
    d.targets.getActiveTargets.mockResolvedValue([
      { jid: '123@g.us', name: 'g', active: true, channel: 'wa' },
      { jid: '-100555', name: 'tg', active: true, channel: 'telegram' },
    ]);
    (d.pipeline as any).config = {
      get: (k: string, def?: string) => {
        if (k === 'MAX_DEALS_PER_RUN_WA') return '3';
        if (k === 'MAX_DEALS_PER_RUN_TELEGRAM') return '3';
        if (k === 'WA_DIGEST_SIZE') return '4';
        return def;
      },
    };
    const scored = [90, 85, 80].map((s, i) => ({
      ...scoredFixture(),
      score: s,
      deal: enrichedFor(rawFor(`MLB${i + 1}`)),
    }));

    const result = await d.pipeline.enqueueScored(scored);

    const calls = (d.sendQueue.add as jest.Mock).mock.calls;
    const digestCalls = calls.filter(([name]) => name === 'send-digest');
    const dealCalls = calls.filter(([name]) => name === 'send-deal');
    expect(digestCalls).toHaveLength(1); // 3 deals num digest só p/ wa
    expect(digestCalls[0][1].deals).toHaveLength(3);
    expect(digestCalls[0][1].digestId).toEqual(expect.any(String));
    expect(dealCalls).toHaveLength(3); // telegram individual
    expect(result.enqueued).toBe(4);
    expect(d.gate.recordPosted).toHaveBeenCalledTimes(3);
  });

  it('keeps single wa deal as a plain send-deal job (no digest of one)', async () => {
    const d = makeDeps({ rawDeals: [] });
    d.targets.getActiveTargets.mockResolvedValue([
      { jid: '123@g.us', name: 'g', active: true, channel: 'wa' },
    ]);
    (d.pipeline as any).config = {
      get: (k: string, def?: string) => (k === 'WA_DIGEST_SIZE' ? '4' : def),
    };

    await d.pipeline.enqueueScored([scoredFixture()]);

    const calls = (d.sendQueue.add as jest.Mock).mock.calls;
    expect(calls[0][0]).toBe('send-deal');
  });

  it('falls back to WA_TARGET_JID as a wa-channel target', async () => {
    const d = makeDeps({ rawDeals: [] });
    d.targets.getActiveTargets.mockResolvedValue([]);
    (d.pipeline as any).config = {
      get: (k: string, def?: string) =>
        k === 'WA_TARGET_JID' ? '999@g.us' : def,
    };

    const result = await d.pipeline.enqueueScored([scoredFixture()], 3);

    expect(result.enqueued).toBe(1);
    expect(d.sendQueue.add).toHaveBeenCalledWith(
      'send-deal',
      expect.objectContaining({ targetJid: '999@g.us', channel: 'wa' }),
      expect.anything(),
    );
  });

  it('throws when no targets and no fallback', async () => {
    const d = makeDeps({ rawDeals: [] });
    d.targets.getActiveTargets.mockResolvedValue([]);

    await expect(
      d.pipeline.enqueueScored([scoredFixture()], 3),
    ).rejects.toThrow(/No active targets/);
  });

  it('fills trustBadge when curation has a badge', async () => {
    const d = makeDeps({ rawDeals: [] });
    d.targets.getActiveTargets.mockResolvedValue([
      { jid: '123@g.us', name: 'g', active: true, channel: 'wa' },
    ]);
    d.curation.getLowestPriceBadge.mockReturnValue('📉 Menor preço em 30 dias');
    d.curation.historyDays.mockReturnValue(42);

    await d.pipeline.enqueueScored([scoredFixture()], 3);

    expect(d.curation.getLowestPriceBadge).toHaveBeenCalledWith(
      'ml:MLB1',
      10000,
    );
    expect(d.sendQueue.add).toHaveBeenCalledWith(
      'send-deal',
      expect.objectContaining({
        trustBadge: { label: '📉 Menor preço em 30 dias', monitoredDays: 42 },
      }),
      expect.anything(),
    );
  });

  it('omits trustBadge when curation returns no badge', async () => {
    const d = makeDeps({ rawDeals: [] });
    d.targets.getActiveTargets.mockResolvedValue([
      { jid: '123@g.us', name: 'g', active: true, channel: 'wa' },
    ]);

    await d.pipeline.enqueueScored([scoredFixture()], 3);

    const payload = d.sendQueue.add.mock.calls[0][1];
    expect(payload.trustBadge).toBeUndefined();
  });

  it('omits trustBadge when TRUST_BADGE_ENABLED=false', async () => {
    const d = makeDeps({ rawDeals: [] });
    d.targets.getActiveTargets.mockResolvedValue([
      { jid: '123@g.us', name: 'g', active: true, channel: 'wa' },
    ]);
    d.curation.getLowestPriceBadge.mockReturnValue('📉 Menor preço em 30 dias');
    d.curation.historyDays.mockReturnValue(42);
    (d.pipeline as any).config = {
      get: (k: string, def?: string) =>
        k === 'TRUST_BADGE_ENABLED' ? 'false' : def,
    };

    await d.pipeline.enqueueScored([scoredFixture()], 3);

    const payload = d.sendQueue.add.mock.calls[0][1];
    expect(payload.trustBadge).toBeUndefined();
    expect(d.curation.getLowestPriceBadge).not.toHaveBeenCalled();
  });
});
