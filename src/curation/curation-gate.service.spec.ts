import type { ScoredDeal } from '../deal-score/types';
import type { RawDeal } from '../sources/source.port';
import { CurationGateService } from './curation-gate.service';
import type { DecisionUpsert } from './curation-decision.repo';

function makeRaw(id: string, priceCents = 10000): RawDeal {
  return {
    key: { source: 'ml', externalId: id },
    title: `Produto ${id}`,
    priceCents,
    originalPriceCents: priceCents * 2,
    discountPercent: 50,
    thumbnail: '',
    permalink: `https://ml/${id}`,
    feedId: 'f1',
  };
}

function makeScored(
  id: string,
  score: number,
  factors: Record<string, number> = {},
): ScoredDeal {
  const raw = makeRaw(id);
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
    d.judge as any,
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
    d.cache.get.mockReturnValue({ approve: true, confidence: 0.9, reason: 'ok' });
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
