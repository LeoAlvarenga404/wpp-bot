import type { ScoredDeal } from '../deal-score/types';
import type { RawDeal } from '../sources/source.port';
import { CurationGateService } from './curation-gate.service';
import type { DecisionUpsert } from './curation-decision.repo';

function makeRaw(id: string, priceCents = 10000, feedId = 'f1'): RawDeal {
  return {
    key: { source: 'ml', externalId: id },
    title: `Produto ${id}`,
    priceCents,
    originalPriceCents: priceCents * 2,
    discountPercent: 50,
    thumbnail: '',
    permalink: `https://ml/${id}`,
    feedId,
  };
}

function makeScored(
  id: string,
  score: number,
  factors: Record<string, number> = {},
  feedId = 'f1',
): ScoredDeal {
  const raw = makeRaw(id, 10000, feedId);
  return {
    deal: {
      key: raw.key,
      source: 'ml',
      raw,
      seller: null,
      condition: 'new',
      signals: {
        freeShipping: false,
        installmentsNoInterest: false,
        volumeTier: 'none',
        isVerifiedStore: false,
      },
      extras: {},
    },
    score,
    rawScore: score,
    level: score >= 90 ? 'top' : 'good',
    reasons: [],
    penalties: [],
    factors,
  };
}

const emptyAnalytics = {
  median7d: null,
  median14d: null,
  median30d: null,
  min7d: null,
  min14d: null,
  min30d: null,
  distinctDays: 0,
  lastObservedBefore: null,
  trend: 'unknown' as const,
};

function makeDeps(overrides: Record<string, string> = {}) {
  const values: Record<string, string> = {
    TZ: 'America/Sao_Paulo',
    ...overrides,
  };
  const config = {
    get: (key: string, def?: string) => values[key] ?? def,
  };
  const curation = {
    historyDays: jest.fn().mockReturnValue(30), // com histórico por default
    isFakeDiscount: jest.fn().mockReturnValue(false),
    getAnalytics: jest.fn().mockReturnValue(emptyAnalytics),
  };
  const dedup = { wasRecentlyPosted: jest.fn().mockResolvedValue(false) };
  const judge = {
    judge: jest
      .fn()
      .mockResolvedValue({ approve: true, confidence: 0.9, reason: 'ok' }),
  };
  const decisions: { upserts: DecisionUpsert[] } & Record<string, any> = {
    upserts: [],
    upsert: jest.fn().mockImplementation(async (d: DecisionUpsert) => {
      decisions.upserts.push(d);
    }),
    pruneOlderThan: jest.fn().mockResolvedValue(0),
  };
  const counters = {
    dedupSkip: { inc: jest.fn() },
    judgeApprove: { inc: jest.fn() },
    judgeReject: { inc: jest.fn() },
    judgeError: { inc: jest.fn() },
  };
  const cache = { get: jest.fn().mockReturnValue(null), set: jest.fn() };
  return { config, curation, dedup, judge, decisions, counters, cache };
}

function makeGate(d: ReturnType<typeof makeDeps>) {
  return new CurationGateService(
    d.config as any,
    d.curation as any,
    d.dedup as any,
    d.judge,
    d.decisions as any,
    d.cache as any,
    d.counters as any,
  );
}

describe('CurationGateService.screenRaw', () => {
  it('rejects dedup hits, bumps counter, records decision', async () => {
    const d = makeDeps();
    d.dedup.wasRecentlyPosted.mockResolvedValue(true);
    const gate = makeGate(d);

    const ok = await gate.screenRaw(makeRaw('MLB1'));

    expect(ok).toBe(false);
    expect(d.counters.dedupSkip.inc).toHaveBeenCalled();
    expect(d.decisions.upserts[0]).toMatchObject({
      catalogId: 'ml:MLB1',
      stage: 'dedup',
      outcome: 'rejected',
    });
  });

  it('rejects fake discounts and records decision', async () => {
    const d = makeDeps();
    d.curation.isFakeDiscount.mockReturnValue(true);
    const gate = makeGate(d);

    expect(await gate.screenRaw(makeRaw('MLB2'))).toBe(false);
    expect(d.decisions.upserts[0]).toMatchObject({
      catalogId: 'ml:MLB2',
      stage: 'fake_discount',
    });
  });

  it('passes clean deals without recording', async () => {
    const d = makeDeps();
    const gate = makeGate(d);

    expect(await gate.screenRaw(makeRaw('MLB3'))).toBe(true);
    expect(d.decisions.upserts).toHaveLength(0);
  });

  it('survives decision write failures', async () => {
    const d = makeDeps();
    d.dedup.wasRecentlyPosted.mockResolvedValue(true);
    d.decisions.upsert.mockRejectedValue(new Error('db down'));
    const gate = makeGate(d);

    await expect(gate.screenRaw(makeRaw('MLB4'))).resolves.toBe(false);
  });

  it('defaults DEDUP_WINDOW_DAYS to 14', async () => {
    const d = makeDeps();
    const gate = makeGate(d);

    await gate.screenRaw(makeRaw('MLB9'));

    expect(d.dedup.wasRecentlyPosted).toHaveBeenCalledWith('ml:MLB9', 14);
  });

  it('lets DEDUP_WINDOW_DAYS env override the default', async () => {
    const d = makeDeps({ DEDUP_WINDOW_DAYS: '3' });
    const gate = makeGate(d);

    await gate.screenRaw(makeRaw('MLB9'));

    expect(d.dedup.wasRecentlyPosted).toHaveBeenCalledWith('ml:MLB9', 3);
  });
});

describe('CurationGateService.selectForDispatch', () => {
  it('hard-blocks price-raise regardless of score', async () => {
    const d = makeDeps();
    const gate = makeGate(d);

    const out = await gate.selectForDispatch(
      [makeScored('MLB1', 95, { price_raise_before_discount: -30 })],
      3,
    );

    expect(out).toHaveLength(0);
    expect(d.decisions.upserts[0]).toMatchObject({
      stage: 'price_raise',
      outcome: 'rejected',
    });
    expect(d.judge.judge).not.toHaveBeenCalled();
  });

  it('auto-approves score >= TOP with history, no judge call', async () => {
    const d = makeDeps();
    const gate = makeGate(d);

    const out = await gate.selectForDispatch([makeScored('MLB1', 92)], 3);

    expect(out).toHaveLength(1);
    expect(out[0].variant).toMatch(/^[AB]$/);
    expect(d.judge.judge).not.toHaveBeenCalled();
  });

  it('sends gray zone (75-89) to the judge and honors approval', async () => {
    const d = makeDeps();
    const gate = makeGate(d);

    const out = await gate.selectForDispatch([makeScored('MLB1', 80)], 3);

    expect(d.judge.judge).toHaveBeenCalledTimes(1);
    expect(out).toHaveLength(1);
    expect(d.counters.judgeApprove.inc).toHaveBeenCalled();
    expect(d.decisions.upserts[0]).toMatchObject({
      stage: 'judge',
      outcome: 'approved',
    });
  });

  it('sends no-history deals to the judge even with score >= TOP', async () => {
    const d = makeDeps();
    d.curation.historyDays.mockReturnValue(2);
    const gate = makeGate(d);

    await gate.selectForDispatch([makeScored('MLB1', 95)], 3);

    expect(d.judge.judge).toHaveBeenCalledTimes(1);
  });

  it('rejects when judge rejects or confidence is low', async () => {
    const d = makeDeps();
    d.judge.judge.mockResolvedValue({
      approve: true,
      confidence: 0.3,
      reason: 'incerto',
    });
    const gate = makeGate(d);

    const out = await gate.selectForDispatch([makeScored('MLB1', 80)], 3);

    expect(out).toHaveLength(0);
    expect(d.counters.judgeReject.inc).toHaveBeenCalled();
    expect(d.decisions.upserts[0]).toMatchObject({
      stage: 'judge',
      outcome: 'rejected',
    });
  });

  it('trusted dispatch skips the judge for a no-history gray-zone deal', async () => {
    const d = makeDeps();
    d.curation.historyDays.mockReturnValue(0); // manual deal: zero history
    const gate = makeGate(d);

    const out = await gate.selectForDispatch([makeScored('MLB1', 80)], 3, {
      trusted: true,
    });

    expect(out).toHaveLength(1);
    expect(d.judge.judge).not.toHaveBeenCalled();
  });

  it('trusted dispatch still hard-blocks price-raise', async () => {
    const d = makeDeps();
    const gate = makeGate(d);

    const out = await gate.selectForDispatch(
      [makeScored('MLB1', 80, { price_raise_before_discount: -30 })],
      3,
      { trusted: true },
    );

    expect(out).toHaveLength(0);
    expect(d.decisions.upserts[0]).toMatchObject({ stage: 'price_raise' });
  });

  it('fail-closed on judge error', async () => {
    const d = makeDeps();
    d.judge.judge.mockRejectedValue(new Error('timeout'));
    const gate = makeGate(d);

    const out = await gate.selectForDispatch([makeScored('MLB1', 80)], 3);

    expect(out).toHaveLength(0);
    expect(d.counters.judgeError.inc).toHaveBeenCalled();
    expect(d.decisions.upserts[0]).toMatchObject({ stage: 'judge_error' });
  });

  it('caps judge calls per tick and records judge_budget', async () => {
    const d = makeDeps({ JUDGE_MAX_CALLS_PER_TICK: '1' });
    d.judge.judge.mockResolvedValue({
      approve: false,
      confidence: 1,
      reason: 'não',
    });
    const gate = makeGate(d);

    await gate.selectForDispatch(
      [makeScored('MLB1', 80), makeScored('MLB2', 79)],
      3,
    );

    expect(d.judge.judge).toHaveBeenCalledTimes(1);
    expect(
      d.decisions.upserts.find((u) => u.stage === 'judge_budget'),
    ).toMatchObject({ catalogId: 'ml:MLB2' });
  });

  it('uses cached verdicts without consuming judge budget', async () => {
    const d = makeDeps();
    d.cache.get.mockReturnValue({
      approve: true,
      confidence: 0.9,
      reason: 'ok',
    });
    const gate = makeGate(d);

    const out = await gate.selectForDispatch([makeScored('MLB1', 80)], 3);

    expect(out).toHaveLength(1);
    expect(d.judge.judge).not.toHaveBeenCalled();
  });

  it('stops at max approved deals', async () => {
    const d = makeDeps();
    const gate = makeGate(d);

    const out = await gate.selectForDispatch(
      [makeScored('MLB1', 95), makeScored('MLB2', 94), makeScored('MLB3', 93)],
      2,
    );

    expect(out).toHaveLength(2);
  });

  describe('category diversity', () => {
    const ids = (out: Array<{ scored: ScoredDeal }>) =>
      out.map((o) => o.scored.deal.key.externalId);

    it('never picks two consecutive deals of the same category when an alternative exists', async () => {
      const d = makeDeps();
      const gate = makeGate(d);

      const out = await gate.selectForDispatch(
        [
          makeScored('A', 95, {}, 'cat1'),
          makeScored('B', 94, {}, 'cat1'),
          makeScored('C', 93, {}, 'cat2'),
        ],
        3,
      );

      // A (top score) -> C (best of a different category) -> B
      expect(ids(out)).toEqual(['A', 'C', 'B']);
    });

    it('stays score-greedy: after switching category, picks the highest score again', async () => {
      const d = makeDeps();
      const gate = makeGate(d);

      const out = await gate.selectForDispatch(
        [
          makeScored('A', 95, {}, 'cat1'),
          makeScored('B', 94, {}, 'cat1'),
          makeScored('C', 93, {}, 'cat2'),
          makeScored('D', 92, {}, 'cat2'),
        ],
        4,
      );

      // A(cat1) -> C(cat2, best alt) -> B(cat1, best non-cat2) -> D
      expect(ids(out)).toEqual(['A', 'C', 'B', 'D']);
    });

    it('falls back to score order when all remaining share the previous category', async () => {
      const d = makeDeps();
      const gate = makeGate(d);

      const out = await gate.selectForDispatch(
        [
          makeScored('A', 95, {}, 'cat1'),
          makeScored('B', 94, {}, 'cat1'),
          makeScored('C', 93, {}, 'cat1'),
        ],
        3,
      );

      expect(ids(out)).toEqual(['A', 'B', 'C']);
    });

    it('rejected deals do not count as picks for the diversity rule', async () => {
      const d = makeDeps();
      const gate = makeGate(d);

      const out = await gate.selectForDispatch(
        [
          makeScored('A', 95, {}, 'cat1'),
          // best cat2 candidate is hard-blocked (price raise)
          makeScored('B', 94, { price_raise_before_discount: -30 }, 'cat2'),
          makeScored('C', 93, {}, 'cat1'),
          makeScored('D', 92, {}, 'cat2'),
        ],
        3,
      );

      // A(cat1) -> B rejected -> still avoiding cat1 -> D(cat2) -> C
      expect(ids(out)).toEqual(['A', 'D', 'C']);
    });

    it('respects max while diversifying', async () => {
      const d = makeDeps();
      const gate = makeGate(d);

      const out = await gate.selectForDispatch(
        [
          makeScored('A', 95, {}, 'cat1'),
          makeScored('B', 94, {}, 'cat1'),
          makeScored('C', 93, {}, 'cat2'),
        ],
        2,
      );

      expect(ids(out)).toEqual(['A', 'C']);
    });
  });

  it('forces variant A when COPY_AB_ENABLED=false', async () => {
    const d = makeDeps({ COPY_AB_ENABLED: 'false' });
    const gate = makeGate(d);

    const out = await gate.selectForDispatch(
      [makeScored('MLB1', 95), makeScored('MLB2', 94)],
      2,
    );

    expect(out.map((o) => o.variant)).toEqual(['A', 'A']);
  });
});

describe('CurationGateService.recordPosted / recordScoreReject', () => {
  it('records posted with variant and score', async () => {
    const d = makeDeps();
    const gate = makeGate(d);
    await gate.recordPosted(makeScored('MLB1', 92), 'B');
    expect(d.decisions.upserts[0]).toMatchObject({
      stage: 'posted',
      outcome: 'posted',
      variant: 'B',
      score: 92,
    });
  });

  it('records score_min rejections with reasons', async () => {
    const d = makeDeps();
    const gate = makeGate(d);
    const sd = makeScored('MLB1', 60);
    sd.penalties = [{ code: 'x', weight: -25, message: 'histórico limitado' }];
    await gate.recordScoreReject(sd);
    expect(d.decisions.upserts[0]).toMatchObject({
      stage: 'score_min',
      outcome: 'rejected',
      score: 60,
    });
  });
});

function makeShopeeScored(id: string, score: number): ScoredDeal {
  const sd = makeScored(id, score);
  const key = { source: 'shopee' as const, externalId: id };
  (sd.deal as any).key = key;
  (sd.deal.raw as any).key = key;
  return sd;
}

describe('CurationGateService source warmup (shopee)', () => {
  it('rejects shopee deals with stage=source_warmup while dispatch is off (default)', async () => {
    const d = makeDeps(); // sem SHOPEE_DISPATCH_ENABLED — default é false
    const gate = makeGate(d);
    // score 95 + histórico (historyDays=30 no fake) — prova que o warmup
    // bloqueia ANTES de qualquer outra regra do gate.
    const out = await gate.selectForDispatch([makeShopeeScored('77', 95)], 5);

    expect(out).toHaveLength(0);
    expect(d.decisions.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        catalogId: 'shopee:77',
        stage: 'source_warmup',
        outcome: 'rejected',
      }),
    );
    expect(d.judge.judge).not.toHaveBeenCalled();
  });

  it('lets shopee deals through when SHOPEE_DISPATCH_ENABLED=true', async () => {
    const d = makeDeps({ SHOPEE_DISPATCH_ENABLED: 'true' });
    const gate = makeGate(d);

    const out = await gate.selectForDispatch([makeShopeeScored('77', 95)], 5);

    expect(out).toHaveLength(1);
  });

  it('never touches ml deals', async () => {
    const d = makeDeps();
    const gate = makeGate(d);

    const out = await gate.selectForDispatch([makeScored('MLB1', 95)], 5);

    expect(out).toHaveLength(1);
    const stages = d.decisions.upserts.map((u: any) => u.stage);
    expect(stages).not.toContain('source_warmup');
  });
});
