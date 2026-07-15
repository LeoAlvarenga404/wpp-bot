// src/curation/curation.service.spec.ts

import { ConfigService } from '@nestjs/config';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { CurationRepo, PriceRow } from './curation.repo';
import { CurationService } from './curation.service';

class InMemoryCurationRepo implements CurationRepo {
  private rows: PriceRow[] = [];
  async loadAll(sinceDays: number): Promise<PriceRow[]> {
    const cutoff = Date.now() - sinceDays * 24 * 60 * 60 * 1000;
    return this.rows
      .filter((r) => r.capturedAt.getTime() >= cutoff)
      .sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime());
  }
  async insert(row: PriceRow): Promise<void> {
    this.rows.push(row);
  }
  async pruneOlderThan(cutoff: Date): Promise<number> {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => r.capturedAt.getTime() >= cutoff.getTime());
    return before - this.rows.length;
  }
  async count(): Promise<number> {
    return this.rows.length;
  }
  async importMany(rows: PriceRow[]): Promise<void> {
    this.rows.push(...rows);
  }
}

async function withTmpFile(): Promise<{ jsonPath: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wpp-curation-'));
  const jsonPath = path.join(dir, 'price-history.json');
  return {
    jsonPath,
    cleanup: () => fs.rm(dir, { recursive: true, force: true }),
  };
}

function makeService(
  repo: CurationRepo,
  overrides: Record<string, string> = {},
  jsonBackfillPath?: string,
): CurationService {
  const config = {
    get: (key: string, def?: string) => overrides[key] ?? def,
  } as unknown as ConfigService;
  const svc = new CurationService(config, repo);
  if (jsonBackfillPath) {
    (svc as any).jsonBackfillPath = jsonBackfillPath;
  } else {
    (svc as any).jsonBackfillPath = path.join(os.tmpdir(), `wpp-no-such-${Date.now()}.json`);
  }
  return svc;
}

describe('CurationService', () => {
  it('record() then median() returns the recorded price', async () => {
    const repo = new InMemoryCurationRepo();
    const svc = makeService(repo);
    await svc.onModuleInit();
    await svc.record('MLB1', 10000);
    expect(svc.median('MLB1', 30)).toBe(10000);
  });

  it('getObservations() returns recorded list', async () => {
    const svc = makeService(new InMemoryCurationRepo());
    await svc.onModuleInit();
    await svc.record('MLB1', 10000);
    await svc.record('MLB1', 12000);
    const obs = svc.getObservations('MLB1');
    expect(obs).toHaveLength(2);
    expect(obs[0].priceCents).toBe(10000);
  });

  it('getAnalytics() returns PriceAnalytics shape', async () => {
    const svc = makeService(new InMemoryCurationRepo());
    await svc.onModuleInit();
    await svc.record('MLB1', 10000);
    const a = svc.getAnalytics('MLB1');
    expect(a.median7d).toBe(10000);
    expect(a.distinctDays).toBeGreaterThanOrEqual(1);
  });

  it('isFakeDiscount: blocks when sufficient history and price >= median*threshold', async () => {
    const svc = makeService(new InMemoryCurationRepo(), {
      CURATION_MIN_HISTORY_DAYS: '0',
      CURATION_DISCOUNT_THRESHOLD: '0.85',
    });
    await svc.onModuleInit();
    await svc.record('MLB1', 10000);
    expect(svc.isFakeDiscount('MLB1', 9000)).toBe(true);
    expect(svc.isFakeDiscount('MLB1', 8000)).toBe(false);
  });

  it('getLowestPriceBadge: emits 30d badge when price <= min30d', async () => {
    const svc = makeService(new InMemoryCurationRepo(), { CURATION_MIN_HISTORY_DAYS: '0' });
    await svc.onModuleInit();
    await svc.record('MLB1', 10000);
    const badge = svc.getLowestPriceBadge('MLB1', 9000);
    expect(badge).toMatch(/Menor preço em 30 dias/);
  });

  it('hydrate() restores observations from the repo on boot', async () => {
    const repo = new InMemoryCurationRepo();
    // Relative date — absolute fixture dates rot past RETENTION_DAYS (60)
    // and get pruned by loadAll/gc, turning this into a time-bomb test.
    const at = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await repo.importMany([
      { catalogId: 'ml:X', priceCents: 9000, capturedAt: at },
      { catalogId: 'ml:X', priceCents: 9500, capturedAt: at },
    ]);
    const svc = makeService(repo);
    await svc.onModuleInit();
    expect(svc.getObservations('ml:X')).toHaveLength(2);
  });
});

describe('CurationService backfill', () => {
  // Relative date — see hydrate() test note about time-bomb fixtures.
  const recentIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  it('prefixes unprefixed catalog keys with ml: during backfill', async () => {
    const { jsonPath, cleanup } = await withTmpFile();
    try {
      await fs.writeFile(
        jsonPath,
        JSON.stringify({
          MLB1: [{ priceCents: 10000, at: recentIso }],
          'ml:MLB2': [{ priceCents: 20000, at: recentIso }],
        }),
        'utf8',
      );
      const repo = new InMemoryCurationRepo();
      const svc = makeService(repo, {}, jsonPath);
      await svc.onModuleInit();
      expect(svc.getObservations('ml:MLB1')).toHaveLength(1);
      expect(svc.getObservations('ml:MLB2')).toHaveLength(1);
      expect(svc.getObservations('MLB1')).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  it('backfill is a no-op when repo already has rows', async () => {
    const { jsonPath, cleanup } = await withTmpFile();
    try {
      await fs.writeFile(
        jsonPath,
        JSON.stringify({ MLB1: [{ priceCents: 10000, at: recentIso }] }),
        'utf8',
      );
      const repo = new InMemoryCurationRepo();
      await repo.insert({
        catalogId: 'ml:EXISTING',
        priceCents: 1,
        capturedAt: new Date(),
      });
      const svc = makeService(repo, {}, jsonPath);
      await svc.onModuleInit();
      // Only the pre-existing row should be present — JSON not imported.
      expect(svc.getObservations('ml:MLB1')).toHaveLength(0);
      expect(svc.getObservations('ml:EXISTING')).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });
});
