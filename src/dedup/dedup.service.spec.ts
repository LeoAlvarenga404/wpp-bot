import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { DedupRepo } from './dedup.repo';
import { DedupService } from './dedup.service';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * In-memory DedupRepo used by these tests. Mirrors the contract of
 * PrismaDedupRepo without a real Postgres dependency.
 */
class InMemoryDedupRepo implements DedupRepo {
  private store = new Map<string, Date>();

  async markPosted(catalogId: string, postedAt: Date): Promise<void> {
    this.store.set(catalogId, postedAt);
  }
  async getPostedAt(catalogId: string): Promise<Date | null> {
    return this.store.get(catalogId) ?? null;
  }
  async pruneOlderThan(cutoff: Date): Promise<number> {
    let pruned = 0;
    for (const [k, v] of this.store) {
      if (v.getTime() < cutoff.getTime()) {
        this.store.delete(k);
        pruned++;
      }
    }
    return pruned;
  }
  async count(): Promise<number> {
    return this.store.size;
  }
  async importMany(
    entries: Array<{ catalogId: string; postedAt: Date }>,
  ): Promise<void> {
    for (const e of entries) {
      if (!this.store.has(e.catalogId)) this.store.set(e.catalogId, e.postedAt);
    }
  }
}

async function buildService(seed?: Record<string, string>): Promise<{
  service: DedupService;
  repo: InMemoryDedupRepo;
  tmpDir: string;
  jsonPath: string;
}> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wpp-dedup-'));
  const jsonPath = path.join(tmpDir, 'posted-log.json');
  if (seed) {
    await fs.writeFile(jsonPath, JSON.stringify(seed, null, 2), 'utf8');
  }
  const repo = new InMemoryDedupRepo();
  const service = new DedupService(repo);
  (service as any).jsonBackfillPath = jsonPath;
  await service.onModuleInit();
  return { service, repo, tmpDir, jsonPath };
}

describe('DedupService', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    while (cleanup.length) {
      const d = cleanup.pop()!;
      try {
        await fs.rm(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it('markPosted + wasRecentlyPosted within window returns true', async () => {
    const { service, tmpDir } = await buildService();
    cleanup.push(tmpDir);

    await service.markPosted('ml:MLB123');

    expect(await service.wasRecentlyPosted('ml:MLB123', 7)).toBe(true);
  });

  it('wasRecentlyPosted returns false when outside the window', async () => {
    const tenDaysAgo = new Date(Date.now() - 10 * DAY_MS).toISOString();
    const { service, tmpDir } = await buildService({ 'ml:MLB999': tenDaysAgo });
    cleanup.push(tmpDir);

    // 10 days exceeds windowDays=7
    expect(await service.wasRecentlyPosted('ml:MLB999', 7)).toBe(false);
  });

  it('wasRecentlyPosted returns false for unknown id', async () => {
    const { service, tmpDir } = await buildService();
    cleanup.push(tmpDir);

    expect(await service.wasRecentlyPosted('UNKNOWN', 7)).toBe(false);
  });

  it('persists entries through the repo', async () => {
    const { service, repo, tmpDir } = await buildService();
    cleanup.push(tmpDir);

    await service.markPosted('ml:MLB42');

    expect(await repo.getPostedAt('ml:MLB42')).toBeInstanceOf(Date);
  });

  it('GC removes entries older than 2 * windowDays (default 14d) on load', async () => {
    const twentyDaysAgo = new Date(Date.now() - 20 * DAY_MS).toISOString();
    const freshIso = new Date().toISOString();
    const { service, repo, tmpDir } = await buildService({
      'ml:OLD': twentyDaysAgo,
      'ml:FRESH': freshIso,
    });
    cleanup.push(tmpDir);

    expect(await service.wasRecentlyPosted('ml:OLD', 7)).toBe(false);
    expect(await service.wasRecentlyPosted('ml:FRESH', 7)).toBe(true);
    expect(await repo.getPostedAt('ml:OLD')).toBeNull();
  });

  it('handles corrupt JSON gracefully (error path)', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wpp-dedup-'));
    cleanup.push(tmpDir);
    const jsonPath = path.join(tmpDir, 'posted-log.json');
    await fs.writeFile(jsonPath, 'not-json', 'utf8');

    const repo = new InMemoryDedupRepo();
    const service = new DedupService(repo);
    (service as any).jsonBackfillPath = jsonPath;
    await service.onModuleInit();

    expect(await service.wasRecentlyPosted('ANY', 7)).toBe(false);
  });

  it('ignores empty catalogId on markPosted', async () => {
    const { service, repo, tmpDir } = await buildService();
    cleanup.push(tmpDir);

    await service.markPosted('');

    expect(await repo.count()).toBe(0);
  });

  it('prefixes unprefixed legacy keys with ml: during backfill', async () => {
    const now = new Date().toISOString();
    const { service, repo, tmpDir } = await buildService({
      MLB1: now,
      'ml:MLB2': now,
    });
    cleanup.push(tmpDir);

    expect(await service.wasRecentlyPosted('ml:MLB1', 7)).toBe(true);
    expect(await service.wasRecentlyPosted('ml:MLB2', 7)).toBe(true);
    expect(await service.wasRecentlyPosted('MLB1', 7)).toBe(false);
    expect(await repo.count()).toBe(2);
  });

  it('backfill is a no-op when repo already has entries', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wpp-dedup-'));
    cleanup.push(tmpDir);
    const jsonPath = path.join(tmpDir, 'posted-log.json');
    await fs.writeFile(
      jsonPath,
      JSON.stringify({ MLB1: new Date().toISOString() }),
      'utf8',
    );

    const repo = new InMemoryDedupRepo();
    await repo.markPosted('ml:PREEXISTING', new Date());
    const service = new DedupService(repo);
    (service as any).jsonBackfillPath = jsonPath;
    await service.onModuleInit();

    expect(await repo.count()).toBe(1);
    expect(await service.wasRecentlyPosted('ml:MLB1', 7)).toBe(false);
  });
});
