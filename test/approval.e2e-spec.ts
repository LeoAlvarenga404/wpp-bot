// PipelineService is only imported for its DI token (the instance is a stub),
// but its module graph reaches wa.service → Baileys, which does not compile
// under Jest. Same mocks as scheduler.service.spec.
jest.mock('@whiskeysockets/baileys', () => ({}));
jest.mock('@hapi/boom', () => ({ Boom: class Boom {} }));
jest.mock('@sentry/node', () => ({
  captureException: jest.fn(),
  init: jest.fn(),
}));
jest.mock('../src/whatsapp/wa.service');

import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { CouponModule } from '../src/coupon/coupon.module';
import { PrismaService } from '../src/db/prisma.service';
import { DbModule } from '../src/db/db.module';
import { OpsConfigModule } from '../src/ops-config/ops-config.module';
import { ApprovalController } from '../src/curation/approval.controller';
import { ApprovalQueueService } from '../src/curation/approval-queue.service';
import {
  APPROVAL_QUEUE_REPO,
  PrismaApprovalQueueRepo,
} from '../src/curation/approval-queue.repo';
import {
  CURATION_DECISION_REPO,
  PrismaCurationDecisionRepo,
} from '../src/curation/curation-decision.repo';
import { PipelineService } from '../src/pipeline/pipeline.service';
import type { ScoredDeal } from '../src/deal-score/types';

const CATALOG_PREFIX = 'e2e-approval';

function makeScored(id: string, score: number): ScoredDeal {
  const key = { source: 'ml' as const, externalId: `${CATALOG_PREFIX}-${id}` };
  const raw = {
    key,
    title: `E2E Produto ${id}`,
    priceCents: 9990,
    originalPriceCents: 19990,
    discountPercent: 50,
    thumbnail: `https://img/${id}.jpg`,
    permalink: `https://ml/${id}`,
    feedId: 'e2e',
  };
  return {
    deal: {
      key,
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
    level: 'good',
    reasons: [{ code: 'discount', weight: score, message: 'bom desconto' }],
    penalties: [],
    factors: { discount: score },
  };
}

/**
 * Scoped e2e: boots only the approval slice against the real Postgres from
 * DATABASE_URL. Deliberately NOT AppModule — booting the full app would start
 * a second Baileys connection and steal the single-holder WhatsApp session
 * from the running container. PipelineService is a stub for the same reason:
 * the contract under test is REST + persistence + audit, and `approve` must
 * hand the re-hydrated snapshot to `enqueueScored` — the send path itself is
 * covered by pipeline/worker specs.
 */
describe('Approval queue (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let service: ApprovalQueueService;
  const enqueueScored = jest.fn(async () => ({
    enqueued: 1,
    targets: 1,
    topScore: 80,
  }));

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        DbModule,
        OpsConfigModule,
        CouponModule,
      ],
      controllers: [ApprovalController],
      providers: [
        PrismaApprovalQueueRepo,
        { provide: APPROVAL_QUEUE_REPO, useExisting: PrismaApprovalQueueRepo },
        {
          provide: CURATION_DECISION_REPO,
          useClass: PrismaCurationDecisionRepo,
        },
        { provide: PipelineService, useValue: { enqueueScored } },
        ApprovalQueueService,
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    prisma = app.get(PrismaService);
    service = app.get(ApprovalQueueService);
    await app.init();
  });

  afterAll(async () => {
    // Leave the shared database exactly as we found it.
    await (prisma as any).pendingDeal.deleteMany({
      where: { catalogId: { contains: CATALOG_PREFIX } },
    });
    await (prisma as any).curationDecision.deleteMany({
      where: { catalogId: { contains: CATALOG_PREFIX } },
    });
    await app.close();
  });

  beforeEach(() => enqueueScored.mockClear());

  it('dispatch below the default all-manual threshold persists PENDING rows', async () => {
    // AUTO_APPROVE_SCORE defaults to 999: even a 98 stays in the queue.
    const result = await service.dispatchScored([
      makeScored('hold-1', 98),
      makeScored('hold-2', 80),
    ]);

    expect(result.pending).toBe(2);
    expect(enqueueScored).not.toHaveBeenCalled();

    const res = await request(app.getHttpServer())
      .get('/approval/pending')
      .set('x-api-key', process.env.API_KEY ?? '')
      .expect(200);

    const mine = res.body.pending.filter((p: { catalogId: string }) =>
      p.catalogId.includes(CATALOG_PREFIX),
    );
    expect(mine).toHaveLength(2);
    const first = mine.find(
      (p: { catalogId: string }) =>
        p.catalogId === `ml:${CATALOG_PREFIX}-hold-1`,
    );
    expect(first).toMatchObject({
      score: 98,
      reasons: [{ code: 'discount', weight: 98, message: 'bom desconto' }],
      preview: {
        title: 'E2E Produto hold-1',
        priceCents: 9990,
        originalPriceCents: 19990,
        discountPercent: 50,
      },
    });
    expect(first.id).toBeDefined();
    expect(new Date(first.expiresAt).getTime()).toBeGreaterThan(Date.now());
    // Faithful WA preview: rendered by the same template the send path uses.
    expect(first.caption).toContain('➡️ E2E PRODUTO HOLD-1');
    expect(first.caption).toContain('✅ Por R$ 99 à vista  (-50%)');
    expect(first.imageUrl).toBe('https://img/hold-1.jpg');
  });

  it('POST /approval/:id/approve re-hydrates the snapshot into enqueueScored and audits', async () => {
    await service.dispatchScored([makeScored('appr', 82)]);
    const row = await (prisma as any).pendingDeal.findFirst({
      where: { catalogId: `ml:${CATALOG_PREFIX}-appr`, status: 'PENDING' },
    });

    const res = await request(app.getHttpServer())
      .post(`/approval/${row.id}/approve`)
      .set('x-api-key', process.env.API_KEY ?? '')
      .expect(201);

    expect(res.body).toMatchObject({
      catalogId: `ml:${CATALOG_PREFIX}-appr`,
      enqueued: 1,
    });
    expect(enqueueScored).toHaveBeenCalledTimes(1);
    const [deals] = enqueueScored.mock.calls[0] as unknown as [ScoredDeal[]];
    expect(deals).toHaveLength(1);
    expect(deals[0].deal.raw.title).toBe('E2E Produto appr');
    expect(deals[0].score).toBe(82);

    const updated = await (prisma as any).pendingDeal.findUnique({
      where: { id: row.id },
    });
    expect(updated.status).toBe('APPROVED');

    const decision = await (prisma as any).curationDecision.findFirst({
      where: { catalogId: `ml:${CATALOG_PREFIX}-appr`, stage: 'approval' },
    });
    expect(decision).toMatchObject({ outcome: 'approved', score: 82 });
  });

  it('POST /approval/:id/reject discards without enqueueing and audits', async () => {
    await service.dispatchScored([makeScored('rej', 77)]);
    const row = await (prisma as any).pendingDeal.findFirst({
      where: { catalogId: `ml:${CATALOG_PREFIX}-rej`, status: 'PENDING' },
    });

    await request(app.getHttpServer())
      .post(`/approval/${row.id}/reject`)
      .set('x-api-key', process.env.API_KEY ?? '')
      .expect(201);

    expect(enqueueScored).not.toHaveBeenCalled();
    const updated = await (prisma as any).pendingDeal.findUnique({
      where: { id: row.id },
    });
    expect(updated.status).toBe('REJECTED');

    const decision = await (prisma as any).curationDecision.findFirst({
      where: { catalogId: `ml:${CATALOG_PREFIX}-rej`, stage: 'approval' },
    });
    expect(decision).toMatchObject({ outcome: 'rejected', score: 77 });
  });

  it('an expired pending is hidden from the list and cannot be approved (409)', async () => {
    const expired = await (prisma as any).pendingDeal.create({
      data: {
        catalogId: `ml:${CATALOG_PREFIX}-old`,
        score: 70,
        snapshot: JSON.parse(JSON.stringify(makeScored('old', 70))),
        expiresAt: new Date(Date.now() - 60_000),
      },
    });

    const list = await request(app.getHttpServer())
      .get('/approval/pending')
      .set('x-api-key', process.env.API_KEY ?? '')
      .expect(200);
    const ids = list.body.pending.map((p: { id: string }) => p.id);
    expect(ids).not.toContain(expired.id);

    // Listing lazily expired it; approving must refuse and never enqueue.
    await request(app.getHttpServer())
      .post(`/approval/${expired.id}/approve`)
      .set('x-api-key', process.env.API_KEY ?? '')
      .expect(409);
    expect(enqueueScored).not.toHaveBeenCalled();

    const row = await (prisma as any).pendingDeal.findUnique({
      where: { id: expired.id },
    });
    expect(row.status).toBe('EXPIRED');
    const decision = await (prisma as any).curationDecision.findFirst({
      where: { catalogId: `ml:${CATALOG_PREFIX}-old`, stage: 'approval' },
    });
    expect(decision).toMatchObject({ outcome: 'expired', score: 70 });
  });

  it('unknown id returns 404', async () => {
    await request(app.getHttpServer())
      .post('/approval/does-not-exist/approve')
      .set('x-api-key', process.env.API_KEY ?? '')
      .expect(404);
  });
});
