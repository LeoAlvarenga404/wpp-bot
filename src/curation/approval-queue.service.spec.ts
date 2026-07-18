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
  ): Promise<void> {
    const row = this.rows.find((r) => r.id === id)!;
    row.status = status;
    row.decidedAt = decidedAt;
  }
}

function makeDeps(opts?: {
  threshold?: string;
  enqueueResult?: EnqueueResult;
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
  return { repo, pipeline, opsConfig, config, decisions };
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

    expect(d.pipeline.enqueueScored).toHaveBeenCalledWith([
      JSON.parse(JSON.stringify(sd)),
    ]);
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
});
