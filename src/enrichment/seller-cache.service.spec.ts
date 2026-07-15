// src/enrichment/seller-cache.service.spec.ts

import { ConfigService } from '@nestjs/config';
import * as fs from 'fs/promises';
import * as path from 'path';
import { SellerCacheService } from './seller-cache.service';
import type { SellerInfo } from './types';

const TMP_FILE = path.resolve('./data/seller-cache.test.json');

function makeSvc(overrides: Record<string, string> = {}): SellerCacheService {
  const config = {
    get: (key: string, def?: string) => overrides[key] ?? def,
  } as unknown as ConfigService;
  const s = new SellerCacheService(config);
  (s as any).filePath = TMP_FILE;
  return s;
}

function sample(sellerId: number, fetchedAt: string): SellerInfo {
  return {
    sellerId,
    nickname: 'TEST',
    powerSellerStatus: 'platinum',
    reputationLevel: '5_green',
    isOfficialStore: false,
    officialStoreId: null,
    ratingAverage: 4.8,
    fetchedAt,
  };
}

describe('SellerCacheService', () => {
  beforeEach(async () => {
    try {
      await fs.unlink(TMP_FILE);
    } catch {
      /* ok */
    }
  });

  afterAll(async () => {
    try {
      await fs.unlink(TMP_FILE);
    } catch {
      /* ok */
    }
  });

  it('get() within TTL returns the cached value', async () => {
    const svc = makeSvc({ SELLER_CACHE_TTL_HOURS: '24' });
    await svc.onModuleInit();
    const now = new Date('2026-05-13T12:00:00Z');
    await svc.set(sample(1, now.toISOString()));
    const out = svc.get(1, now);
    expect(out?.sellerId).toBe(1);
  });

  it('get() after TTL returns null', async () => {
    const svc = makeSvc({ SELLER_CACHE_TTL_HOURS: '24' });
    await svc.onModuleInit();
    const old = new Date('2026-05-10T12:00:00Z');
    const now = new Date('2026-05-13T12:00:00Z'); // 72h later
    await svc.set(sample(1, old.toISOString()));
    expect(svc.get(1, now)).toBeNull();
  });

  it('persists via tmp+rename and survives restart', async () => {
    const now = new Date('2026-05-13T12:00:00Z');
    const a = makeSvc();
    await a.onModuleInit();
    await a.set(sample(42, now.toISOString()));

    const b = makeSvc();
    await b.onModuleInit();
    expect(b.get(42, now)?.sellerId).toBe(42);
  });

  it('starts empty when file is corrupted', async () => {
    await fs.mkdir(path.dirname(TMP_FILE), { recursive: true });
    await fs.writeFile(TMP_FILE, '{not valid json', 'utf8');
    const svc = makeSvc();
    await svc.onModuleInit();
    expect(svc.get(1, new Date())).toBeNull();
  });
});
