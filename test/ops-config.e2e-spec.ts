import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { PrismaService } from '../src/db/prisma.service';
import { OpsConfigModule } from '../src/ops-config/ops-config.module';

/**
 * Scoped e2e: boots only OpsConfigModule against the real Postgres from
 * DATABASE_URL. Deliberately NOT AppModule — booting the full app would start
 * a second Baileys connection and steal the single-holder WhatsApp session
 * from the running container.
 */
describe('OpsConfig (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), OpsConfigModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    prisma = app.get(PrismaService);
    await app.init();
  });

  afterAll(async () => {
    // Leave the shared database exactly as we found it.
    await (prisma as any).opsConfig.deleteMany({
      where: { key: 'AUTO_APPROVE_SCORE' },
    });
    await app.close();
  });

  it('GET /ops-config lists every known key with value and source', async () => {
    const res = await request(app.getHttpServer())
      .get('/ops-config')
      .set('x-api-key', process.env.API_KEY ?? '')
      .expect(200);

    const keys = res.body.values.map((v: { key: string }) => v.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        'AUTO_APPROVE_SCORE',
        'QUIET_HOURS_ENABLED',
        'DM_BATCH_INTERVAL_MIN',
      ]),
    );
    for (const v of res.body.values) {
      expect(['db', 'env', 'default']).toContain(v.source);
    }
  });

  it('PUT /ops-config/:key persists and the new value is effective immediately', async () => {
    const put = await request(app.getHttpServer())
      .put('/ops-config/AUTO_APPROVE_SCORE')
      .set('x-api-key', process.env.API_KEY ?? '')
      .send({ value: '85' })
      .expect(200);

    const updated = put.body.values.find(
      (v: { key: string }) => v.key === 'AUTO_APPROVE_SCORE',
    );
    expect(updated).toEqual({
      key: 'AUTO_APPROVE_SCORE',
      value: '85',
      source: 'db',
    });

    const get = await request(app.getHttpServer())
      .get('/ops-config')
      .set('x-api-key', process.env.API_KEY ?? '')
      .expect(200);
    const effective = get.body.values.find(
      (v: { key: string }) => v.key === 'AUTO_APPROVE_SCORE',
    );
    expect(effective.value).toBe('85');
    expect(effective.source).toBe('db');
  });

  it('PUT /ops-config/:key rejects an unknown key with 400', async () => {
    await request(app.getHttpServer())
      .put('/ops-config/NOT_A_KEY')
      .set('x-api-key', process.env.API_KEY ?? '')
      .send({ value: '1' })
      .expect(400);
  });

  it('PUT /ops-config/:key rejects a non-numeric value for a number key with 400', async () => {
    await request(app.getHttpServer())
      .put('/ops-config/AUTO_APPROVE_SCORE')
      .set('x-api-key', process.env.API_KEY ?? '')
      .send({ value: 'abc' })
      .expect(400);
  });
});
