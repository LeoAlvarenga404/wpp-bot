// PipelineService (type-only here, but the service imports it for DI) pulls
// wa.service → Baileys, which does not load under Jest. Same mocks as
// scheduler.service.spec.
jest.mock('@whiskeysockets/baileys', () => ({}));
jest.mock('@hapi/boom', () => ({ Boom: class Boom {} }));
jest.mock('@sentry/node', () => ({
  captureException: jest.fn(),
  init: jest.fn(),
}));
jest.mock('../whatsapp/wa.service');

import { ConflictException, NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { CouponService } from '../coupon/coupon.service';
import type { CouponView } from '../coupon/coupon.types';
import type { ScoredDeal } from '../deal-score/types';
import type { PipelineService } from '../pipeline/pipeline.service';
import type { OpsConfigService } from '../ops-config/ops-config.service';
import type { RawDeal } from '../sources/source.port';
import type { DecisionUpsert } from './curation-decision.repo';
import type { EnqueueResult } from '../pipeline/pipeline.service';
import { ApprovalQueueService } from './approval-queue.service';
import type {
  ApprovalQueueRepo,
  PendingDealRow,
  PendingDealStatus,
  PendingUpsert,
} from './approval-queue.repo';

function makeRaw(id: string, priceCents = 10000): RawDeal {
  return {
    key: { source: 'ml', externalId: id },
    title: `Produto ${id}`,
    priceCents,
    originalPriceCents: priceCents * 2,
    discountPercent: 50,
    thumbnail: `https://img/${id}.jpg`,
    permalink: `https://ml/${id}`,
    feedId: 'f1',
  };
}

function makeScored(id: string, score: number): ScoredDeal {
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
    reasons: [{ code: 'discount', weight: score, message: 'bom desconto' }],
    penalties: [],
    factors: { discount: score },
  };
}

/** In-memory ApprovalQueueRepo playing the PendingDeal table. */
class FakeRepo implements ApprovalQueueRepo {
  rows: PendingDealRow[] = [];
  private seq = 0;

  async create(
    d: PendingUpsert & { catalogId: string },
  ): Promise<PendingDealRow> {
    const row: PendingDealRow = {
      id: `pd-${++this.seq}`,
      catalogId: d.catalogId,
      status: 'PENDING',
      score: d.score,
      snapshot: JSON.parse(JSON.stringify(d.snapshot)) as unknown,
      edits: null,
      expiresAt: d.expiresAt,
      createdAt: new Date('2026-07-18T12:00:00Z'),
      decidedAt: null,
    };
    this.rows.push(row);
    return row;
  }

  async refresh(id: string, d: PendingUpsert): Promise<void> {
    const row = this.rows.find((r) => r.id === id)!;
    row.score = d.score;
    row.snapshot = JSON.parse(JSON.stringify(d.snapshot)) as unknown;
    row.expiresAt = d.expiresAt;
  }

  async findById(id: string): Promise<PendingDealRow | null> {
    return this.rows.find((r) => r.id === id) ?? null;
  }

  async findPendingByCatalogId(
    catalogId: string,
  ): Promise<PendingDealRow | null> {
    return (
      this.rows.find(
        (r) => r.catalogId === catalogId && r.status === 'PENDING',
      ) ?? null
    );
  }

  async listPending(): Promise<PendingDealRow[]> {
    return this.rows.filter((r) => r.status === 'PENDING');
  }

  async findExpiredPending(now: Date): Promise<PendingDealRow[]> {
    return this.rows.filter(
      (r) => r.status === 'PENDING' && r.expiresAt.getTime() <= now.getTime(),
    );
  }

  async markDecided(
    id: string,
    status: PendingDealStatus,
    decidedAt: Date,
    edits?: unknown,
  ): Promise<void> {
    const row = this.rows.find((r) => r.id === id)!;
    row.status = status;
    row.decidedAt = decidedAt;
    if (edits !== undefined) row.edits = edits;
  }
}

function makeDeps(opts?: {
  threshold?: string;
  enqueueResult?: EnqueueResult;
  couponView?: CouponView;
}) {
  const repo = new FakeRepo();
  const pipeline = {
    enqueueScored: jest.fn(
      async (): Promise<EnqueueResult> =>
        opts?.enqueueResult ?? { enqueued: 1, targets: 1, topScore: 80 },
    ),
  } as unknown as PipelineService;
  const opsConfig = {
    autoApproveScore: jest.fn(async () => Number(opts?.threshold ?? '90')),
  } as unknown as OpsConfigService;
  const config = {
    get: (k: string, def?: string) => ({ TZ: 'America/Sao_Paulo' })[k] ?? def,
  } as unknown as ConfigService;
  const decisions: { upserts: DecisionUpsert[] } & Record<string, any> = {
    upserts: [],
    upsert: jest.fn(async (d: DecisionUpsert) => {
      decisions.upserts.push(d);
    }),
    pruneOlderThan: jest.fn(async () => 0),
  };
  const coupons = {
    resolveForDeal: jest.fn(async () => opts?.couponView ?? null),
  } as unknown as CouponService;
  const dedup = {
    lastPostedAt: jest.fn(async () => null as Date | null),
  };
  return { repo, pipeline, opsConfig, config, decisions, coupons, dedup };
}

class TestApprovalQueue extends ApprovalQueueService {
  nowValue = new Date('2026-07-18T12:00:00Z');
  protected now(): Date {
    return this.nowValue;
  }
}

function makeService(d: ReturnType<typeof makeDeps>) {
  return new TestApprovalQueue(
    d.repo,
    d.pipeline,
    d.opsConfig,
    d.config,
    d.decisions as any,
    d.coupons,
    d.dedup as any,
  );
}

const HOUR = 3_600_000;

describe('ApprovalQueueService.dispatchScored', () => {
  it('splits by threshold: >= threshold auto-enqueued, below persisted pending', async () => {
    const d = makeDeps({ threshold: '90' });
    const svc = makeService(d);
    const top = makeScored('MLB1', 95);
    const borderline = makeScored('MLB2', 80);

    const result = await svc.dispatchScored([top, borderline]);

    expect(d.pipeline.enqueueScored).toHaveBeenCalledWith([top]);
    expect(result.pending).toBe(1);
    expect(result.threshold).toBe(90);
    expect(d.repo.rows).toHaveLength(1);
    expect(d.repo.rows[0]).toMatchObject({
      catalogId: 'ml:MLB2',
      status: 'PENDING',
      score: 80,
    });
  });

  it('persists the full ScoredDeal snapshot with a 4h expiry', async () => {
    const d = makeDeps({ threshold: '90' });
    const svc = makeService(d);
    const sd = makeScored('MLB2', 80);

    await svc.dispatchScored([sd]);

    const row = d.repo.rows[0];
    expect(row.snapshot).toEqual(JSON.parse(JSON.stringify(sd)));
    expect(row.expiresAt.getTime()).toBe(svc.nowValue.getTime() + 4 * HOUR);
  });

  it('impossible threshold (999, all-manual) holds 100% of deals in the queue', async () => {
    const d = makeDeps({ threshold: '999' });
    const svc = makeService(d);

    const result = await svc.dispatchScored([
      makeScored('MLB1', 98),
      makeScored('MLB2', 80),
    ]);

    expect(d.pipeline.enqueueScored).not.toHaveBeenCalled();
    expect(result.enqueued).toBe(0);
    expect(result.pending).toBe(2);
    expect(d.repo.rows).toHaveLength(2);
  });

  it('re-dispatch of a deal already pending refreshes the row instead of duplicating', async () => {
    const d = makeDeps({ threshold: '90' });
    const svc = makeService(d);
    await svc.dispatchScored([makeScored('MLB2', 80)]);

    svc.nowValue = new Date('2026-07-18T13:00:00Z');
    await svc.dispatchScored([makeScored('MLB2', 85)]);

    expect(d.repo.rows).toHaveLength(1);
    expect(d.repo.rows[0].score).toBe(85);
    expect(d.repo.rows[0].expiresAt.getTime()).toBe(
      svc.nowValue.getTime() + 4 * HOUR,
    );
  });
});

describe('ApprovalQueueService.approve', () => {
  it('re-hydrates the snapshot and enqueues it through the existing send path', async () => {
    const d = makeDeps({ threshold: '90' });
    const svc = makeService(d);
    const sd = makeScored('MLB2', 80);
    await svc.dispatchScored([sd]);
    const id = d.repo.rows[0].id;

    const result = await svc.approve(id);

    expect(d.pipeline.enqueueScored).toHaveBeenCalledWith(
      [JSON.parse(JSON.stringify(sd))],
      undefined,
      { trusted: true },
    );
    expect(result.enqueued).toBe(1);
    expect(d.repo.rows[0].status).toBe('APPROVED');
    expect(d.repo.rows[0].decidedAt).toEqual(svc.nowValue);
  });

  it('audits the approval in CurationDecision with the score at decision time', async () => {
    const d = makeDeps({ threshold: '90' });
    const svc = makeService(d);
    await svc.dispatchScored([makeScored('MLB2', 80)]);

    await svc.approve(d.repo.rows[0].id);

    expect(d.decisions.upserts).toHaveLength(1);
    expect(d.decisions.upserts[0]).toMatchObject({
      catalogId: 'ml:MLB2',
      stage: 'approval',
      outcome: 'approved',
      score: 80,
      priceCents: 10000,
      day: '2026-07-18',
    });
  });

  it('throws NotFound for an unknown id', async () => {
    const svc = makeService(makeDeps());
    await expect(svc.approve('nope')).rejects.toThrow(NotFoundException);
  });

  it('throws Conflict for an already-decided row', async () => {
    const d = makeDeps({ threshold: '90' });
    const svc = makeService(d);
    await svc.dispatchScored([makeScored('MLB2', 80)]);
    const id = d.repo.rows[0].id;
    await svc.reject(id);

    await expect(svc.approve(id)).rejects.toThrow(ConflictException);
  });

  it('approve past expiry never enqueues: marks EXPIRED, audits, throws Conflict', async () => {
    const d = makeDeps({ threshold: '90' });
    const svc = makeService(d);
    await svc.dispatchScored([makeScored('MLB2', 80)]);
    const id = d.repo.rows[0].id;

    svc.nowValue = new Date('2026-07-18T16:00:01Z'); // 4h + 1s later

    await expect(svc.approve(id)).rejects.toThrow(ConflictException);
    expect(d.pipeline.enqueueScored).not.toHaveBeenCalled();
    expect(d.repo.rows[0].status).toBe('EXPIRED');
    expect(d.decisions.upserts[0]).toMatchObject({
      stage: 'approval',
      outcome: 'expired',
      score: 80,
    });
  });

  it('audit failure does not block the approval', async () => {
    const d = makeDeps({ threshold: '90' });
    d.decisions.upsert.mockRejectedValue(new Error('db down'));
    const svc = makeService(d);
    await svc.dispatchScored([makeScored('MLB2', 80)]);

    const result = await svc.approve(d.repo.rows[0].id);

    expect(result.enqueued).toBe(1);
    expect(d.repo.rows[0].status).toBe('APPROVED');
  });
});

describe('ApprovalQueueService.approve with edits', () => {
  it('applies the headline edit to the snapshot handed to enqueueScored', async () => {
    const d = makeDeps({ threshold: '90' });
    const svc = makeService(d);
    await svc.dispatchScored([makeScored('MLB2', 80)]);

    await svc.approve(d.repo.rows[0].id, {
      headline: 'Fone JBL melhor preço',
    });

    const [deals] = (d.pipeline.enqueueScored as jest.Mock).mock
      .calls[0] as unknown as [ScoredDeal[]];
    expect(deals[0].deal.raw.title).toBe('Fone JBL melhor preço');
    expect(deals[0].curatorEdits).toEqual({
      headline: 'Fone JBL melhor preço',
    });
  });

  it('applies the price edit and refreshes the discount percent', async () => {
    const d = makeDeps({ threshold: '90' });
    const svc = makeService(d);
    await svc.dispatchScored([makeScored('MLB2', 80)]); // 10000 de 20000

    await svc.approve(d.repo.rows[0].id, { priceCents: 8400 });

    const [deals] = (d.pipeline.enqueueScored as jest.Mock).mock
      .calls[0] as unknown as [ScoredDeal[]];
    expect(deals[0].deal.raw.priceCents).toBe(8400);
    expect(deals[0].deal.raw.discountPercent).toBe(58); // 1 - 8400/20000
    expect(deals[0].curatorEdits).toEqual({ priceCents: 8400 });
  });

  it('attaches the coupon edit so the send path can override the resolver', async () => {
    const d = makeDeps({ threshold: '90' });
    const svc = makeService(d);
    await svc.dispatchScored([makeScored('MLB2', 80)]);

    await svc.approve(d.repo.rows[0].id, {
      coupon: { code: 'SHOW10', finalCents: 9000 },
    });

    const [deals] = (d.pipeline.enqueueScored as jest.Mock).mock
      .calls[0] as unknown as [ScoredDeal[]];
    expect(deals[0].curatorEdits).toEqual({
      coupon: { code: 'SHOW10', finalCents: 9000 },
    });
    // Coupon edit alone touches neither price nor title.
    expect(deals[0].deal.raw.priceCents).toBe(10000);
    expect(deals[0].deal.raw.title).toBe('Produto MLB2');
  });

  it('empty edits object behaves exactly like an edit-free approve', async () => {
    const d = makeDeps({ threshold: '90' });
    const svc = makeService(d);
    const sd = makeScored('MLB2', 80);
    await svc.dispatchScored([sd]);

    await svc.approve(d.repo.rows[0].id, {});

    expect(d.pipeline.enqueueScored).toHaveBeenCalledWith(
      [JSON.parse(JSON.stringify(sd))],
      undefined,
      { trusted: true },
    );
  });

  it('records the edits in the decision audit and on the pending row', async () => {
    const d = makeDeps({ threshold: '90' });
    const svc = makeService(d);
    await svc.dispatchScored([makeScored('MLB2', 80)]);
    const edits = { headline: 'Novo título', priceCents: 9000 };

    await svc.approve(d.repo.rows[0].id, edits);

    expect(d.decisions.upserts[0]).toMatchObject({
      outcome: 'approved',
      edits,
    });
    expect(d.repo.rows[0].edits).toEqual(edits);
  });
});

describe('ApprovalQueueService.approve urgent + dedup override (issue #7)', () => {
  it('urgent approve enqueues with the urgent flag and audits approval_urgent', async () => {
    const d = makeDeps({ threshold: '90' });
    const svc = makeService(d);
    await svc.dispatchScored([makeScored('MLB2', 80)]);

    const result = await svc.approve(d.repo.rows[0].id, undefined, {
      urgent: true,
    });

    expect(result.enqueued).toBe(1);
    expect(d.pipeline.enqueueScored).toHaveBeenCalledWith(
      [expect.anything()],
      undefined,
      expect.objectContaining({ urgent: true }),
    );
    const stages = d.decisions.upserts.map((u) => u.stage);
    expect(stages).toContain('approval');
    expect(stages).toContain('approval_urgent');
    expect(
      d.decisions.upserts.find((u) => u.stage === 'approval_urgent'),
    ).toMatchObject({ outcome: 'approved', score: 80 });
  });

  it('recently posted without override: 409, nothing enqueued, still PENDING', async () => {
    const d = makeDeps({ threshold: '90' });
    d.dedup.lastPostedAt.mockResolvedValue(new Date('2026-07-15T11:00:00Z'));
    const svc = makeService(d);
    await svc.dispatchScored([makeScored('MLB2', 80)]);

    await expect(svc.approve(d.repo.rows[0].id)).rejects.toThrow(
      ConflictException,
    );
    expect(d.pipeline.enqueueScored).not.toHaveBeenCalled();
    expect(d.repo.rows[0].status).toBe('PENDING');
    expect(d.decisions.upserts).toHaveLength(0);
  });

  it('recently posted with dedupOverride: enqueues fresh and audits dedup_override', async () => {
    const d = makeDeps({ threshold: '90' });
    d.dedup.lastPostedAt.mockResolvedValue(new Date('2026-07-15T11:00:00Z'));
    const svc = makeService(d);
    await svc.dispatchScored([makeScored('MLB2', 80)]);

    const result = await svc.approve(d.repo.rows[0].id, undefined, {
      dedupOverride: true,
    });

    expect(result.enqueued).toBe(1);
    // Fresh jobId so the BullMQ completed-job coalesce can't swallow a
    // human-decided repost.
    expect(d.pipeline.enqueueScored).toHaveBeenCalledWith(
      [expect.anything()],
      undefined,
      expect.objectContaining({ uniqueJobId: true }),
    );
    expect(
      d.decisions.upserts.find((u) => u.stage === 'dedup_override'),
    ).toMatchObject({ outcome: 'approved', score: 80, catalogId: 'ml:MLB2' });
  });

  it('dedupOverride when NOT recently posted does not audit an override', async () => {
    const d = makeDeps({ threshold: '90' });
    const svc = makeService(d);
    await svc.dispatchScored([makeScored('MLB2', 80)]);

    await svc.approve(d.repo.rows[0].id, undefined, { dedupOverride: true });

    expect(
      d.decisions.upserts.find((u) => u.stage === 'dedup_override'),
    ).toBeUndefined();
  });

  it('plain approve enqueues trusted (no urgent/override, no extra audit rows)', async () => {
    const d = makeDeps({ threshold: '90' });
    const svc = makeService(d);
    const sd = makeScored('MLB2', 80);
    await svc.dispatchScored([sd]);

    await svc.approve(d.repo.rows[0].id);

    expect(d.pipeline.enqueueScored).toHaveBeenCalledWith(
      [JSON.parse(JSON.stringify(sd))],
      undefined,
      { trusted: true },
    );
    expect(d.decisions.upserts.map((u) => u.stage)).toEqual(['approval']);
  });
});

describe('ApprovalQueueService.preview', () => {
  it('renders the caption with the edits applied, without deciding the row', async () => {
    const d = makeDeps({ threshold: '90' });
    const svc = makeService(d);
    await svc.dispatchScored([makeScored('MLB2', 80)]);

    const out = await svc.preview(d.repo.rows[0].id, {
      headline: 'Fone JBL top',
      priceCents: 8400,
      coupon: { code: 'SHOW10', finalCents: 8000 },
    });

    expect(out.caption).toContain('➡️ FONE JBL TOP');
    expect(out.caption).toContain('✅ Por R$ 84 no PIX  (-58%)');
    expect(out.caption).toContain('🎟️ Com o cupom SHOW10: R$ 80  (-R$ 4)');
    expect(out.imageUrl).toBe('https://img/MLB2.jpg');
    // Pure preview: nothing decided, nothing enqueued, nothing audited.
    expect(d.repo.rows[0].status).toBe('PENDING');
    expect(d.pipeline.enqueueScored).not.toHaveBeenCalled();
    expect(d.decisions.upserts).toHaveLength(0);
    // The stored snapshot stays pristine — preview never mutates the row.
    const snapshot = d.repo.rows[0].snapshot as ScoredDeal;
    expect(snapshot.deal.raw.title).toBe('Produto MLB2');
    expect(snapshot.deal.raw.priceCents).toBe(10000);
  });

  it('edited coupon without a final price falls back to the code-only line', async () => {
    const d = makeDeps({ threshold: '90' });
    const svc = makeService(d);
    await svc.dispatchScored([makeScored('MLB2', 80)]);

    const out = await svc.preview(d.repo.rows[0].id, {
      coupon: { code: 'SHOW10' },
    });

    expect(out.caption).toContain('🎟️ Use o cupom: SHOW10');
  });

  it('edited coupon replaces the auto-resolved coupon line', async () => {
    const d = makeDeps({
      threshold: '90',
      couponView: {
        code: 'AUTO5',
        mode: 'PRICE',
        finalCents: 9500,
        discountLabel: '-R$ 5',
        minCents: null,
        validUntil: '2027-01-01T00:00:00.000Z',
        type: 'FINAL',
        value: 9500,
        capCents: null,
      },
    });
    const svc = makeService(d);
    await svc.dispatchScored([makeScored('MLB2', 80)]);

    const out = await svc.preview(d.repo.rows[0].id, {
      coupon: { code: 'SHOW10', finalCents: 9000 },
    });

    expect(out.caption).toContain('🎟️ Com o cupom SHOW10: R$ 90');
    expect(out.caption).not.toContain('AUTO5');
  });

  it('no edits: preview matches the listPending caption', async () => {
    const d = makeDeps({ threshold: '90' });
    const svc = makeService(d);
    await svc.dispatchScored([makeScored('MLB2', 80)]);
    const [listed] = await svc.listPending();

    const out = await svc.preview(d.repo.rows[0].id, {});

    expect(out.caption).toBe(listed.caption);
  });
});

describe('ApprovalQueueService.reject', () => {
  it('discards without enqueueing and audits with score', async () => {
    const d = makeDeps({ threshold: '90' });
    const svc = makeService(d);
    await svc.dispatchScored([makeScored('MLB2', 80)]);
    const id = d.repo.rows[0].id;

    await svc.reject(id);

    expect(d.pipeline.enqueueScored).not.toHaveBeenCalled();
    expect(d.repo.rows[0].status).toBe('REJECTED');
    expect(d.decisions.upserts[0]).toMatchObject({
      catalogId: 'ml:MLB2',
      stage: 'approval',
      outcome: 'rejected',
      score: 80,
    });
  });
});

describe('ApprovalQueueService.expireOverdue', () => {
  it('expires only overdue pendings, audits each with score, never enqueues', async () => {
    const d = makeDeps({ threshold: '90' });
    const svc = makeService(d);
    await svc.dispatchScored([makeScored('MLB1', 80)]);
    svc.nowValue = new Date('2026-07-18T14:00:00Z');
    await svc.dispatchScored([makeScored('MLB2', 85)]);

    svc.nowValue = new Date('2026-07-18T16:30:00Z'); // MLB1 overdue, MLB2 not
    const expired = await svc.expireOverdue();

    expect(expired).toBe(1);
    expect(d.pipeline.enqueueScored).not.toHaveBeenCalled();
    const mlb1 = d.repo.rows.find((r) => r.catalogId === 'ml:MLB1')!;
    const mlb2 = d.repo.rows.find((r) => r.catalogId === 'ml:MLB2')!;
    expect(mlb1.status).toBe('EXPIRED');
    expect(mlb2.status).toBe('PENDING');
    expect(d.decisions.upserts).toHaveLength(1);
    expect(d.decisions.upserts[0]).toMatchObject({
      catalogId: 'ml:MLB1',
      outcome: 'expired',
      score: 80,
    });
  });
});

describe('ApprovalQueueService.listPending', () => {
  it('expires overdue rows first, then returns summaries with score, reasons and preview', async () => {
    const d = makeDeps({ threshold: '90' });
    const svc = makeService(d);
    await svc.dispatchScored([makeScored('MLB1', 80)]);
    svc.nowValue = new Date('2026-07-18T14:00:00Z');
    await svc.dispatchScored([makeScored('MLB2', 85)]);

    svc.nowValue = new Date('2026-07-18T16:30:00Z');
    const pending = await svc.listPending();

    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      catalogId: 'ml:MLB2',
      score: 85,
      reasons: [{ code: 'discount', weight: 85, message: 'bom desconto' }],
      preview: {
        title: 'Produto MLB2',
        priceCents: 10000,
        originalPriceCents: 20000,
        discountPercent: 50,
        thumbnail: 'https://img/MLB2.jpg',
        permalink: 'https://ml/MLB2',
      },
    });
    expect(pending[0].expiresAt).toBeInstanceOf(Date);
  });

  it('renders the faithful WA caption from the snapshot (same template the group sees)', async () => {
    const d = makeDeps({ threshold: '90' });
    const svc = makeService(d);
    await svc.dispatchScored([makeScored('MLB2', 85)]);

    const [pending] = await svc.listPending();

    // Same lines ofertasTemplate produces at send time: CAPS title, struck
    // "De", green "Por ... no PIX" with % off, link on the raw permalink
    // (preview never mints affiliate/short links).
    expect(pending.caption).toContain('➡️ PRODUTO MLB2');
    expect(pending.caption).toContain('❌ De ~R$ 200~');
    expect(pending.caption).toContain('✅ Por R$ 100 no PIX  (-50%)');
    expect(pending.caption).toContain('🛒 Link: https://ml/MLB2');
    expect(pending.imageUrl).toBe('https://img/MLB2.jpg');
  });

  it('flags deals posted within the dedup window with postedDaysAgo', async () => {
    const d = makeDeps({ threshold: '90' });
    // Posted 3 days before the fixed test clock (2026-07-18T12:00Z).
    d.dedup.lastPostedAt.mockResolvedValue(new Date('2026-07-15T11:00:00Z'));
    const svc = makeService(d);
    await svc.dispatchScored([makeScored('MLB2', 85)]);

    const [pending] = await svc.listPending();

    expect(d.dedup.lastPostedAt).toHaveBeenCalledWith('ml:MLB2');
    expect(pending.postedDaysAgo).toBe(3);
  });

  it('postedDaysAgo is null when never posted or posted outside the window', async () => {
    const d = makeDeps({ threshold: '90' });
    d.dedup.lastPostedAt.mockResolvedValue(new Date('2026-07-01T12:00:00Z')); // 17d
    const svc = makeService(d);
    await svc.dispatchScored([makeScored('MLB2', 85)]);

    const [pending] = await svc.listPending();

    expect(pending.postedDaysAgo).toBeNull();
  });

  it('includes the coupon line when a coupon resolves for the snapshot deal', async () => {
    const d = makeDeps({
      threshold: '90',
      couponView: {
        code: 'SHOW10',
        mode: 'PRICE',
        finalCents: 9000,
        discountLabel: '-R$ 10',
        minCents: null,
        validUntil: '2027-01-01T00:00:00.000Z',
        type: 'FINAL',
        value: 9000,
        capCents: null,
      },
    });
    const svc = makeService(d);
    await svc.dispatchScored([makeScored('MLB2', 85)]);

    const [pending] = await svc.listPending();

    expect(pending.caption).toContain('🎟️ Com o cupom SHOW10: R$ 90');
  });

  it('coupon resolve failure never blocks the listing — caption renders without the line', async () => {
    const d = makeDeps({ threshold: '90' });
    (d.coupons.resolveForDeal as jest.Mock).mockRejectedValue(
      new Error('db down'),
    );
    const svc = makeService(d);
    await svc.dispatchScored([makeScored('MLB2', 85)]);

    const [pending] = await svc.listPending();

    expect(pending.caption).toContain('➡️ PRODUTO MLB2');
    expect(pending.caption).not.toContain('🎟️');
  });
});

describe('renderManualPreview', () => {
  it('renders the curator coupon from the snapshot', async () => {
    const svc = makeService(makeDeps());
    const sd = makeScored('MLB7', 100);
    sd.deal.raw.priceCents = 10000;
    sd.curatorEdits = { coupon: { code: 'JBL20', finalCents: 8000 } };

    const out = await svc.renderManualPreview(sd);

    expect(out.caption).toContain('JBL20');
  });
});
