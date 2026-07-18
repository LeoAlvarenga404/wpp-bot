import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DbModule } from '../src/db/db.module';
import { PrismaService } from '../src/db/prisma.service';
import { HistoryModule } from '../src/history/history.module';

describe('HistoryController (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), DbModule, HistoryModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    await app.init();
    prisma = moduleFixture.get(PrismaService);
    await (prisma as any).$executeRawUnsafe('TRUNCATE "SentMessage" CASCADE');
    await (prisma as any).$executeRawUnsafe('TRUNCATE "CurationDecision" CASCADE');
  });

  afterAll(async () => {
    if (prisma) {
      await (prisma as any).$executeRawUnsafe('TRUNCATE "SentMessage" CASCADE');
      await (prisma as any).$executeRawUnsafe('TRUNCATE "CurationDecision" CASCADE');
    }
    if (app) await app.close();
  });

  it('GET /history lists sent messages', async () => {
    await (prisma as any).sentMessage.create({
      data: {
        catalogId: 'mock-1',
        targetJid: '123@s.whatsapp.net',
        caption: 'Mock Caption 1',
        variant: 'A',
      },
    });

    // Make mock-2 slightly newer
    await new Promise((resolve) => setTimeout(resolve, 10));

    await (prisma as any).sentMessage.create({
      data: {
        catalogId: 'mock-2',
        targetJid: '456@s.whatsapp.net',
        caption: 'Mock Caption 2',
        variant: 'B',
      },
    });

    await (prisma as any).curationDecision.create({
      data: {
        catalogId: 'mock-1',
        stage: 'MANUAL',
        day: '2026-07-18',
        outcome: 'approved',
        score: 85,
      },
    });

    const reqApp = app.getHttpServer() as unknown as App;
    const res = await request(reqApp)
      .get('/history?limit=10')
      .set('x-api-key', process.env.API_KEY ?? '')
      .expect(200);

    expect(res.body.total).toBe(2);
    expect(res.body.items).toHaveLength(2);
    
    // Ordered by sentAt desc, so mock-2 is first
    expect(res.body.items[0].catalogId).toBe('mock-2');
    expect(res.body.items[0].score).toBeNull();
    
    expect(res.body.items[1].catalogId).toBe('mock-1');
    expect(res.body.items[1].score).toBe(85);
  });
});
