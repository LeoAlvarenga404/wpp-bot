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

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { CouponModule } from '../src/coupon/coupon.module';
import { PrismaService } from '../src/db/prisma.service';
import { DbModule } from '../src/db/db.module';
import { DedupModule } from '../src/dedup/dedup.module';
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
import { ManualDealService } from '../src/curation/manual/manual-deal.service';
import {
  MANUAL_RESOLVERS,
  ManualResolveError,
  type ManualDealResolver,
} from '../src/curation/manual/manual-resolver.port';
import type { ScoredDeal } from '../src/deal-score/types';

const CATALOG_PREFIX = 'e2e-approval';
// Manual-composer submits derive the ML catalog id from the pasted link, so
// their catalogIds don't carry CATALOG_PREFIX — track them for cleanup.
const SUBMIT_MLB = 'MLB90019001';
const SUBMIT_MLB2 = 'MLB90019002';

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

  // Stands in for MlManualResolver so the e2e never drives a real browser.
  // Claims mercadolivre URLs; a URL containing "fail" simulates a scrape miss.
  const fakeResolver: ManualDealResolver = {
    source: 'ml',
    canResolve: (u) => /mercadolivre/i.test(u),
    resolve: async (url) => {
      if (/fail/i.test(url)) {
        throw new ManualResolveError(
          'scrape_failed',
          'não consegui ler a página',
        );
      }
      return {
        key: { source: 'ml', externalId: `${CATALOG_PREFIX}-manual` },
        source: 'ml',
        title: 'Fone Manual XYZ',
        priceCents: 12990,
        originalPriceCents: 25990,
        discountPercent: 50,
        thumbnail: 'https://img/manual.jpg',
        permalink: url,
        installmentsNoInterest: true,
      };
    },
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        DbModule,
        OpsConfigModule,
        CouponModule,
        DedupModule,
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
        {
          provide: MANUAL_RESOLVERS,
          useValue: [fakeResolver],
        },
        ManualDealService,
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    // Same global pipe main.ts installs — the 400 contract depends on it.
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    prisma = app.get(PrismaService);
    service = app.get(ApprovalQueueService);
    await app.init();
  });

  afterAll(async () => {
    // Leave the shared database exactly as we found it.
    const submitIds = [`ml:${SUBMIT_MLB}`, `ml:${SUBMIT_MLB2}`];
    await (prisma as any).pendingDeal.deleteMany({
      where: {
        OR: [
          { catalogId: { contains: CATALOG_PREFIX } },
          { catalogId: { in: submitIds } },
        ],
      },
    });
    await (prisma as any).curationDecision.deleteMany({
      where: {
        OR: [
          { catalogId: { contains: CATALOG_PREFIX } },
          { catalogId: { in: submitIds } },
        ],
      },
    });
    await (prisma as any).dedupEntry.deleteMany({
      where: {
        OR: [
          { catalogId: { contains: CATALOG_PREFIX } },
          { catalogId: { in: submitIds } },
        ],
      },
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

  it('POST /approval/:id/approve with edits publishes the edited values and audits them', async () => {
    await service.dispatchScored([makeScored('edit', 82)]);
    const row = await (prisma as any).pendingDeal.findFirst({
      where: { catalogId: `ml:${CATALOG_PREFIX}-edit`, status: 'PENDING' },
    });
    const edits = {
      headline: 'Produto editado top',
      priceCents: 8400,
      coupon: { code: 'SHOW10', finalCents: 8000 },
    };

    await request(app.getHttpServer())
      .post(`/approval/${row.id}/approve`)
      .set('x-api-key', process.env.API_KEY ?? '')
      .send({ edits })
      .expect(201);

    // Contract: the snapshot handed to the send path carries the edits.
    const [deals] = enqueueScored.mock.calls[0] as unknown as [ScoredDeal[]];
    expect(deals[0].deal.raw.title).toBe('Produto editado top');
    expect(deals[0].deal.raw.priceCents).toBe(8400);
    expect(deals[0].curatorEdits).toEqual(edits);

    // Audit: edits recorded on the pending row and on the decision.
    const updated = await (prisma as any).pendingDeal.findUnique({
      where: { id: row.id },
    });
    expect(updated.status).toBe('APPROVED');
    expect(updated.edits).toEqual(edits);
    const decision = await (prisma as any).curationDecision.findFirst({
      where: { catalogId: `ml:${CATALOG_PREFIX}-edit`, stage: 'approval' },
    });
    expect(decision).toMatchObject({ outcome: 'approved', edits });
  });

  it('POST /approval/:id/approve rejects a malformed edits payload (400)', async () => {
    await service.dispatchScored([makeScored('edit-bad', 82)]);
    const row = await (prisma as any).pendingDeal.findFirst({
      where: { catalogId: `ml:${CATALOG_PREFIX}-edit-bad`, status: 'PENDING' },
    });

    await request(app.getHttpServer())
      .post(`/approval/${row.id}/approve`)
      .set('x-api-key', process.env.API_KEY ?? '')
      .send({ edits: { priceCents: 'dez reais' } })
      .expect(400);
    expect(enqueueScored).not.toHaveBeenCalled();
  });

  it('POST /approval/:id/preview re-renders the caption live without deciding the row', async () => {
    await service.dispatchScored([makeScored('prev', 82)]);
    const row = await (prisma as any).pendingDeal.findFirst({
      where: { catalogId: `ml:${CATALOG_PREFIX}-prev`, status: 'PENDING' },
    });

    const res = await request(app.getHttpServer())
      .post(`/approval/${row.id}/preview`)
      .set('x-api-key', process.env.API_KEY ?? '')
      .send({
        edits: {
          headline: 'Preview editado',
          priceCents: 8400,
          coupon: { code: 'SHOW10', finalCents: 8000 },
        },
      })
      .expect(201);

    expect(res.body.caption).toContain('➡️ PREVIEW EDITADO');
    expect(res.body.caption).toContain('✅ Por R$ 84 à vista');
    expect(res.body.caption).toContain('🎟️ Com o cupom SHOW10: R$ 80');
    expect(res.body.imageUrl).toBe('https://img/prev.jpg');

    // Pure preview: still PENDING, nothing enqueued, snapshot untouched.
    expect(enqueueScored).not.toHaveBeenCalled();
    const after = await (prisma as any).pendingDeal.findUnique({
      where: { id: row.id },
    });
    expect(after.status).toBe('PENDING');
    expect(after.snapshot.deal.raw.title).toBe('E2E Produto prev');
  });

  it('urgent approve passes the urgent flag to the send path and audits approval_urgent', async () => {
    await service.dispatchScored([makeScored('urg', 82)]);
    const row = await (prisma as any).pendingDeal.findFirst({
      where: { catalogId: `ml:${CATALOG_PREFIX}-urg`, status: 'PENDING' },
    });

    await request(app.getHttpServer())
      .post(`/approval/${row.id}/approve`)
      .set('x-api-key', process.env.API_KEY ?? '')
      .send({ urgent: true })
      .expect(201);

    expect(enqueueScored).toHaveBeenCalledTimes(1);
    const call = enqueueScored.mock.calls[0] as unknown as [
      ScoredDeal[],
      number | undefined,
      { urgent?: boolean; uniqueJobId?: boolean } | undefined,
    ];
    expect(call[2]).toMatchObject({ urgent: true, uniqueJobId: true });

    const urgentRow = await (prisma as any).curationDecision.findFirst({
      where: {
        catalogId: `ml:${CATALOG_PREFIX}-urg`,
        stage: 'approval_urgent',
      },
    });
    expect(urgentRow).toMatchObject({ outcome: 'approved', score: 82 });
  });

  it('recently posted: card warns, approve 409s without override, proceeds and audits with it', async () => {
    await service.dispatchScored([makeScored('dedup', 82)]);
    // Posted 2 days ago -> inside the 14d window.
    await (prisma as any).dedupEntry.create({
      data: {
        catalogId: `ml:${CATALOG_PREFIX}-dedup`,
        postedAt: new Date(Date.now() - 2 * 24 * 3_600_000),
      },
    });

    const list = await request(app.getHttpServer())
      .get('/approval/pending')
      .set('x-api-key', process.env.API_KEY ?? '')
      .expect(200);
    const card = list.body.pending.find(
      (p: { catalogId: string }) =>
        p.catalogId === `ml:${CATALOG_PREFIX}-dedup`,
    );
    expect(card.postedDaysAgo).toBe(2);

    const row = await (prisma as any).pendingDeal.findFirst({
      where: { catalogId: `ml:${CATALOG_PREFIX}-dedup`, status: 'PENDING' },
    });

    // Without the override: refused, nothing enqueued, still pending.
    const conflict = await request(app.getHttpServer())
      .post(`/approval/${row.id}/approve`)
      .set('x-api-key', process.env.API_KEY ?? '')
      .send({})
      .expect(409);
    expect(conflict.body.code).toBe('recently_posted');
    expect(conflict.body.days).toBe(2);
    expect(enqueueScored).not.toHaveBeenCalled();

    // With the human override: proceeds and audits the override.
    await request(app.getHttpServer())
      .post(`/approval/${row.id}/approve`)
      .set('x-api-key', process.env.API_KEY ?? '')
      .send({ dedupOverride: true })
      .expect(201);
    expect(enqueueScored).toHaveBeenCalledTimes(1);

    const override = await (prisma as any).curationDecision.findFirst({
      where: {
        catalogId: `ml:${CATALOG_PREFIX}-dedup`,
        stage: 'dedup_override',
      },
    });
    expect(override).toMatchObject({ outcome: 'approved', score: 82 });
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

  it('POST /approval/manual/resolve returns prefill fields and creates NO card', async () => {
    const res = await request(app.getHttpServer())
      .post('/approval/manual/resolve')
      .set('x-api-key', process.env.API_KEY ?? '')
      .send({ url: 'https://www.mercadolivre.com.br/fone/p/MLB123' })
      .expect(201);

    // Prefill for the composer form — no card, no key.
    expect(res.body).toMatchObject({
      source: 'ml',
      title: 'Fone Manual XYZ',
      priceCents: 12990,
      originalPriceCents: 25990,
      discountPercent: 50,
      permalink: 'https://www.mercadolivre.com.br/fone/p/MLB123',
      installmentsNoInterest: true,
    });
    expect(res.body.id).toBeUndefined();

    // Nothing landed in the queue.
    const count = await (prisma as any).pendingDeal.count({
      where: { catalogId: { contains: `${CATALOG_PREFIX}-manual` } },
    });
    expect(count).toBe(0);
  });

  it('POST /approval/manual/preview renders the caption with the coupon, creating no card', async () => {
    const res = await request(app.getHttpServer())
      .post('/approval/manual/preview')
      .set('x-api-key', process.env.API_KEY ?? '')
      .send({
        store: 'outro',
        title: `Produto ${CATALOG_PREFIX}-prevm`,
        priceCents: 10000,
        thumbnail: 'https://example.com/prevm.jpg',
        coupon: { code: 'SHOW10', finalCents: 8000 },
      })
      .expect(201);

    expect(res.body.caption).toContain('SHOW10');
    expect(res.body.imageUrl).toBe('https://example.com/prevm.jpg');

    const count = await (prisma as any).pendingDeal.count({
      where: { catalogId: { contains: `${CATALOG_PREFIX}-prevm` } },
    });
    expect(count).toBe(0);
  });

  it('POST /approval/manual (dispatch=false) creates a pending card, audited under approval_manual', async () => {
    const permalink = `https://www.mercadolivre.com.br/p/${SUBMIT_MLB}`;
    const res = await request(app.getHttpServer())
      .post('/approval/manual')
      .set('x-api-key', process.env.API_KEY ?? '')
      .send({
        store: 'ml',
        title: 'Fone Submit XYZ',
        priceCents: 12990,
        originalPriceCents: 25990,
        thumbnail: 'https://example.com/submit.jpg',
        permalink,
      })
      .expect(201);

    // ML deals derive the catalog id from the link so dedup aligns.
    expect(res.body.catalogId).toBe(`ml:${SUBMIT_MLB}`);
    expect(enqueueScored).not.toHaveBeenCalled();

    const row = await (prisma as any).pendingDeal.findFirst({
      where: { catalogId: `ml:${SUBMIT_MLB}`, status: 'PENDING' },
    });
    expect(row).toBeTruthy();
    expect(row.snapshot.deal.raw.feedId).toBe('manual');

    // Approving it audits under approval_manual, keeping calibration clean.
    await request(app.getHttpServer())
      .post(`/approval/${row.id}/approve`)
      .set('x-api-key', process.env.API_KEY ?? '')
      .expect(201);
    const manualDecision = await (prisma as any).curationDecision.findFirst({
      where: { catalogId: `ml:${SUBMIT_MLB}`, stage: 'approval_manual' },
    });
    expect(manualDecision).toMatchObject({ outcome: 'approved' });
    const plain = await (prisma as any).curationDecision.findFirst({
      where: { catalogId: `ml:${SUBMIT_MLB}`, stage: 'approval' },
    });
    expect(plain).toBeNull();
  });

  it('POST /approval/manual (dispatch=true) creates the card and sends now (urgent)', async () => {
    const permalink = `https://www.mercadolivre.com.br/p/${SUBMIT_MLB2}`;
    const res = await request(app.getHttpServer())
      .post('/approval/manual')
      .set('x-api-key', process.env.API_KEY ?? '')
      .send({
        store: 'ml',
        title: 'Fone Dispara XYZ',
        priceCents: 9990,
        thumbnail: 'https://example.com/dispatch.jpg',
        permalink,
        dispatch: true,
      })
      .expect(201);

    expect(res.body).toMatchObject({
      catalogId: `ml:${SUBMIT_MLB2}`,
      enqueued: 1,
    });
    expect(enqueueScored).toHaveBeenCalledTimes(1);
    const call = enqueueScored.mock.calls[0] as unknown as [
      ScoredDeal[],
      number | undefined,
      { urgent?: boolean; uniqueJobId?: boolean } | undefined,
    ];
    expect(call[2]).toMatchObject({ urgent: true, uniqueJobId: true });
  });

  it('POST /approval/manual/resolve returns 422 on scrape failure and creates no card', async () => {
    const res = await request(app.getHttpServer())
      .post('/approval/manual/resolve')
      .set('x-api-key', process.env.API_KEY ?? '')
      .send({ url: 'https://www.mercadolivre.com.br/fail/p/MLB999' })
      .expect(422);
    expect(res.body.code).toBe('scrape_failed');

    const count = await (prisma as any).pendingDeal.count({
      where: { catalogId: { contains: `${CATALOG_PREFIX}-fail` } },
    });
    expect(count).toBe(0);
  });

  it('POST /approval/manual/resolve rejects an unsupported store URL (400)', async () => {
    const res = await request(app.getHttpServer())
      .post('/approval/manual/resolve')
      .set('x-api-key', process.env.API_KEY ?? '')
      .send({ url: 'https://loja-desconhecida.com/produto/1' })
      .expect(400);
    expect(res.body.code).toBe('unsupported_url');
  });

  it('POST /approval/manual/resolve rejects a malformed body (400)', async () => {
    await request(app.getHttpServer())
      .post('/approval/manual/resolve')
      .set('x-api-key', process.env.API_KEY ?? '')
      .send({ url: 'not a url' })
      .expect(400);
  });

  it('unknown id returns 404', async () => {
    await request(app.getHttpServer())
      .post('/approval/does-not-exist/approve')
      .set('x-api-key', process.env.API_KEY ?? '')
      .expect(404);
  });
});
