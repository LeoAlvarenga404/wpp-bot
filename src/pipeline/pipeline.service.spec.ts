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

  it('screens each raw BEFORE recording it: same-tick observation cannot shift the median used by the screen', async () => {
    // Behavioral lock for the cold-start contamination bug: with an empty
    // history, recording the promo price first made median == promo price,
    // so isFakeDiscount rejected the very deal that created the observation.
    const d = makeDeps({ rawDeals: [rawFor('MLB1', 10000)] });
    const store: Record<string, number[]> = {};
    d.curation.record.mockImplementation(async (k: string, p: number) => {
      (store[k] ??= []).push(p);
    });
    d.curation.isFakeDiscount.mockImplementation(
      (k: string, priceCents: number) => {
        const prices = store[k] ?? [];
        if (prices.length === 0) return false; // no history -> pass
        const sorted = [...prices].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        return priceCents >= median * 0.85;
      },
    );
    d.gate.screenRaw.mockImplementation(
      async (raw: RawDeal) =>
        !d.curation.isFakeDiscount(
          `${raw.key.source}:${raw.key.externalId}`,
          raw.priceCents,
        ),
    );

    const out = await d.pipeline.collectScored('ml');

    // Would be [] if record() ran before the screen decision.
    expect(out).toHaveLength(1);
    // Observation still recorded (history keeps building), just after.
    expect(d.curation.record).toHaveBeenCalledWith('ml:MLB1', 10000);
    expect(d.gate.screenRaw.mock.invocationCallOrder[0]).toBeLessThan(
      d.curation.record.mock.invocationCallOrder[0],
    );
  });

  it('still records price history for deals rejected by the screen', async () => {
    const d = makeDeps({
      rawDeals: [rawFor('MLB1'), rawFor('MLB2')],
      failingId: 'MLB1',
    });
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

describe('PipelineService coupon-aware scoring', () => {
  function priceSensitiveScore(d: ReturnType<typeof makeDeps>) {
    // Score depends on the price the scorer sees: cheap = good deal.
    (d.dealScore.computeWithObservations as jest.Mock).mockImplementation(
      (e: EnrichedDeal): ScoredDeal => {
        const s = e.raw.priceCents <= 5000 ? 85 : 60;
        return {
          deal: e,
          score: s,
          rawScore: s,
          level: s >= 75 ? 'good' : 'rejected',
          reasons: [],
          penalties: [],
          factors: { discount_percent: s },
        };
      },
    );
  }

  function priceCoupon(finalCents: number) {
    return {
      code: 'CUPOM10',
      mode: 'PRICE' as const,
      finalCents,
      discountLabel: '-R$ 50',
      minCents: null,
      validUntil: '2026-12-31T00:00:00.000Z',
    };
  }

  it('scores against the effective price when a PRICE coupon applies, recording coupon_boost', async () => {
    const d = makeDeps({ rawDeals: [rawFor('MLB1', 10000)] });
    priceSensitiveScore(d);
    (d.pipeline as any).coupons = {
      resolveForDeal: jest.fn(async () => priceCoupon(5000)),
    };

    const out = await d.pipeline.collectScored('ml');

    // Base price scores 60 (< MIN 75) — only the coupon makes it pass.
    expect(out).toHaveLength(1);
    expect(out[0].score).toBe(85);
    expect(out[0].factors.coupon_boost).toBe(25);
    expect(out[0].reasons.some((r) => r.code === 'coupon_boost')).toBe(true);
    // The deal itself keeps the BASE price (history/audit/message use it).
    expect(out[0].deal.raw.priceCents).toBe(10000);
    // Coupon resolved with the deal's current (base) price.
    expect(
      ((d.pipeline as any).coupons.resolveForDeal as jest.Mock).mock
        .calls[0][1],
    ).toBe(10000);
    // Price history records the BASE price only — never the couponed price.
    expect(d.curation.record).toHaveBeenCalledWith('ml:MLB1', 10000);
    expect(d.curation.record).not.toHaveBeenCalledWith('ml:MLB1', 5000);
  });

  it('ignores CTA-mode coupons (no final price -> no boost)', async () => {
    const d = makeDeps({ rawDeals: [rawFor('MLB1', 10000)] });
    priceSensitiveScore(d);
    (d.pipeline as any).coupons = {
      resolveForDeal: jest.fn(async () => ({
        ...priceCoupon(5000),
        mode: 'CTA' as const,
        finalCents: null,
      })),
    };

    const out = await d.pipeline.collectScored('ml');

    expect(out).toHaveLength(0); // base score 60 < MIN
  });

  it('keeps the base score when coupon resolution throws', async () => {
    const d = makeDeps({ rawDeals: [rawFor('MLB1', 4000)] });
    priceSensitiveScore(d);
    (d.pipeline as any).coupons = {
      resolveForDeal: jest.fn(async () => {
        throw new Error('db down');
      }),
    };

    const out = await d.pipeline.collectScored('ml');

    expect(out).toHaveLength(1); // 4000 scores 85 on its own
    expect(out[0].score).toBe(85);
    expect(out[0].factors.coupon_boost).toBeUndefined();
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

  describe('urgent dispatch (issue #7)', () => {
    it('urgent: job carries urgent flag, jumps the queue (lifo) and gets a fresh jobId', async () => {
      const d = makeDeps({ rawDeals: [] });
      d.targets.getActiveTargets.mockResolvedValue([
        { jid: '123@g.us', name: 'g', active: true, channel: 'wa' },
      ]);

      await d.pipeline.enqueueScored([scoredFixture()], 3, {
        urgent: true,
        uniqueJobId: true,
      });

      const [name, data, opts] = (d.sendQueue.add as jest.Mock).mock.calls[0];
      expect(name).toBe('send-deal');
      expect(data.urgent).toBe(true);
      expect(opts.lifo).toBe(true);
      // Coalescing jobId is `<key>_<jid>`; a unique suffix defeats the
      // completed-job coalesce so a human-decided resend is never swallowed.
      expect(opts.jobId).toMatch(/^ml_MLB1_123@g\.us_/);
      expect(opts.jobId).not.toBe('ml_MLB1_123@g.us');
    });

    it('non-urgent enqueue keeps the coalescing jobId and no lifo', async () => {
      const d = makeDeps({ rawDeals: [] });
      d.targets.getActiveTargets.mockResolvedValue([
        { jid: '123@g.us', name: 'g', active: true, channel: 'wa' },
      ]);

      await d.pipeline.enqueueScored([scoredFixture()], 3);

      const [, data, opts] = (d.sendQueue.add as jest.Mock).mock.calls[0];
      expect(data.urgent).toBeUndefined();
      expect(opts.lifo).toBeUndefined();
      expect(opts.jobId).toBe('ml_MLB1_123@g.us');
    });
  });

  describe('parallel price scrape', () => {
    function scoredWithPermalink(id: string, score: number): ScoredDeal {
      const raw = rawFor(id);
      raw.permalink = `https://ml/${id}`;
      return {
        deal: enrichedFor(raw),
        score,
        rawScore: score,
        level: 'top',
        reasons: [],
        penalties: [],
        factors: {},
      };
    }

    function priceViewFor(priceCents: number) {
      return {
        priceCents,
        originalPriceCents: null,
        discountPercent: null,
        pixPriceCents: null,
        installments: null,
        scrapedAt: '2026-07-16T00:00:00.000Z',
      };
    }

    function setup(concurrency: string) {
      const d = makeDeps({ rawDeals: [] });
      d.targets.getActiveTargets.mockResolvedValue([
        { jid: '123@g.us', name: 'g', active: true, channel: 'wa' },
      ]);
      (d.pipeline as any).config = {
        get: (k: string, def?: string) => {
          if (k === 'MAX_DEALS_PER_RUN_WA') return '5';
          if (k === 'WA_DIGEST_SIZE') return '1';
          if (k === 'SCRAPE_CONCURRENCY') return concurrency;
          return def;
        },
      };
      return d;
    }

    it('runs at most SCRAPE_CONCURRENCY scrapes at once and keeps result-to-deal association + job order', async () => {
      const d = setup('2');
      let inFlight = 0;
      let maxInFlight = 0;
      const scraper = {
        scrapePriceView: jest.fn(async (permalink: string) => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((r) => setTimeout(r, 5));
          inFlight--;
          // Derive a distinct price from the permalink's id.
          const id = Number(permalink.slice('https://ml/MLB'.length));
          return priceViewFor(1000 * id);
        }),
      };
      (d.pipeline as any).priceScraper = scraper;
      const scored = [90, 85, 80, 78, 76].map((s, i) =>
        scoredWithPermalink(`MLB${i + 1}`, s),
      );

      await d.pipeline.enqueueScored(scored);

      expect(scraper.scrapePriceView).toHaveBeenCalledTimes(5);
      expect(maxInFlight).toBe(2);
      const calls = (d.sendQueue.add as jest.Mock).mock.calls;
      // Jobs enqueued in score order, each carrying ITS OWN scraped view.
      expect(calls.map(([, data]) => data.catalogKey)).toEqual([
        'ml:MLB1',
        'ml:MLB2',
        'ml:MLB3',
        'ml:MLB4',
        'ml:MLB5',
      ]);
      for (let i = 0; i < 5; i++) {
        expect(calls[i][1].priceView.priceCents).toBe(1000 * (i + 1));
        expect(calls[i][1].scored.deal.raw.priceCents).toBe(1000 * (i + 1));
      }
    });

    it('skips the scrape for a curator-edited price — the human-confirmed value wins', async () => {
      const d = setup('2');
      const scraper = {
        scrapePriceView: jest.fn(async (permalink: string) => {
          const id = Number(permalink.slice('https://ml/MLB'.length));
          return priceViewFor(1000 * id);
        }),
      };
      (d.pipeline as any).priceScraper = scraper;
      const edited = scoredWithPermalink('MLB1', 90);
      edited.deal.raw.priceCents = 8400; // applied by approve(id, edits)
      edited.curatorEdits = { priceCents: 8400 };
      const untouched = scoredWithPermalink('MLB2', 85);

      await d.pipeline.enqueueScored([edited, untouched]);

      // Only the untouched deal is scraped; the edited one keeps 8400.
      expect(scraper.scrapePriceView).toHaveBeenCalledTimes(1);
      expect(scraper.scrapePriceView).toHaveBeenCalledWith('https://ml/MLB2');
      const calls = (d.sendQueue.add as jest.Mock).mock.calls;
      const byKey = new Map(calls.map(([, data]) => [data.catalogKey, data]));
      expect(byKey.get('ml:MLB1').priceView).toBeUndefined();
      expect(byKey.get('ml:MLB1').scored.deal.raw.priceCents).toBe(8400);
      expect(byKey.get('ml:MLB2').priceView.priceCents).toBe(2000);
    });

    it('uses the curator-edited coupon instead of the resolver', async () => {
      const d = setup('2');
      const resolveForDeal = jest.fn(async () => ({
        code: 'AUTO5',
        mode: 'PRICE' as const,
        finalCents: 9500,
        discountLabel: '-R$ 5',
        minCents: null,
        validUntil: '2027-01-01T00:00:00.000Z',
      }));
      (d.pipeline as any).coupons = { resolveForDeal };
      const edited = scoredWithPermalink('MLB1', 90);
      edited.curatorEdits = { coupon: { code: 'SHOW10', finalCents: 8000 } };
      const untouched = scoredWithPermalink('MLB2', 85);

      await d.pipeline.enqueueScored([edited, untouched]);

      // Resolver only runs for the untouched deal.
      expect(resolveForDeal).toHaveBeenCalledTimes(1);
      const calls = (d.sendQueue.add as jest.Mock).mock.calls;
      const byKey = new Map(calls.map(([, data]) => [data.catalogKey, data]));
      expect(byKey.get('ml:MLB1').couponView).toMatchObject({
        code: 'SHOW10',
        mode: 'PRICE',
        finalCents: 8000,
      });
      expect(byKey.get('ml:MLB2').couponView.code).toBe('AUTO5');
    });

    it('an individual scrape failure keeps the API price for that deal only', async () => {
      const d = setup('2');
      const scraper = {
        scrapePriceView: jest.fn(async (permalink: string) => {
          if (permalink.endsWith('MLB2')) throw new Error('timeout');
          const id = Number(permalink.slice('https://ml/MLB'.length));
          return priceViewFor(1000 * id);
        }),
      };
      (d.pipeline as any).priceScraper = scraper;
      const scored = [90, 85, 80].map((s, i) =>
        scoredWithPermalink(`MLB${i + 1}`, s),
      );

      const result = await d.pipeline.enqueueScored(scored);

      expect(result.enqueued).toBe(3);
      const calls = (d.sendQueue.add as jest.Mock).mock.calls;
      const byKey = new Map(calls.map(([, data]) => [data.catalogKey, data]));
      expect(byKey.get('ml:MLB1').priceView.priceCents).toBe(1000);
      expect(byKey.get('ml:MLB2').priceView).toBeUndefined();
      expect(byKey.get('ml:MLB2').scored.deal.raw.priceCents).toBe(10000); // API price kept
      expect(byKey.get('ml:MLB3').priceView.priceCents).toBe(3000);
    });
  });
});
