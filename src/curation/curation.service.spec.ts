// src/curation/curation.service.spec.ts

import { ConfigService } from '@nestjs/config';
import * as fs from 'fs/promises';
import * as path from 'path';
import { CurationService } from './curation.service';

const TMP_FILE = path.resolve('./data/price-history.test.json');

function makeService(overrides: Record<string, string> = {}): CurationService {
  const config = {
    get: (key: string, def?: string) => overrides[key] ?? def,
  } as unknown as ConfigService;
  const svc = new CurationService(config);
  // override file path via reflection — keeps tests isolated
  (svc as any).filePath = TMP_FILE;
  return svc;
}

describe('CurationService', () => {
  beforeEach(async () => {
    try { await fs.unlink(TMP_FILE); } catch { /* ok */ }
  });

  afterAll(async () => {
    try { await fs.unlink(TMP_FILE); } catch { /* ok */ }
  });

  it('record() then median() returns the recorded price', async () => {
    const svc = makeService();
    await svc.onModuleInit();
    await svc.record('MLB1', 10000);
    expect(svc.median('MLB1', 30)).toBe(10000);
  });

  it('getObservations() returns recorded list', async () => {
    const svc = makeService();
    await svc.onModuleInit();
    await svc.record('MLB1', 10000);
    await svc.record('MLB1', 12000);
    const obs = svc.getObservations('MLB1');
    expect(obs).toHaveLength(2);
    expect(obs[0].priceCents).toBe(10000);
  });

  it('getAnalytics() returns PriceAnalytics shape', async () => {
    const svc = makeService();
    await svc.onModuleInit();
    await svc.record('MLB1', 10000);
    const a = svc.getAnalytics('MLB1');
    expect(a.median7d).toBe(10000);
    expect(a.distinctDays).toBeGreaterThanOrEqual(1);
  });

  it('isFakeDiscount unchanged: blocks when sufficient history and price >= median*threshold', async () => {
    const svc = makeService({
      CURATION_MIN_HISTORY_DAYS: '0',
      CURATION_DISCOUNT_THRESHOLD: '0.85',
    });
    await svc.onModuleInit();
    await svc.record('MLB1', 10000);
    // current = 9000 → 90% of median, > 85% threshold → fake
    expect(svc.isFakeDiscount('MLB1', 9000)).toBe(true);
    // current = 8000 → 80% of median, < 85% → real
    expect(svc.isFakeDiscount('MLB1', 8000)).toBe(false);
  });

  it('getLowestPriceBadge unchanged: emits 30d badge when price <= min30d', async () => {
    const svc = makeService({ CURATION_MIN_HISTORY_DAYS: '0' });
    await svc.onModuleInit();
    await svc.record('MLB1', 10000);
    const badge = svc.getLowestPriceBadge('MLB1', 9000);
    expect(badge).toMatch(/Menor preço em 30 dias/);
  });
});
