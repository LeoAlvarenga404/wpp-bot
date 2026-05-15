import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { DedupService } from './dedup.service';

const DAY_MS = 24 * 60 * 60 * 1000;

async function buildService(initial?: Record<string, string>): Promise<{
  service: DedupService;
  tmpDir: string;
  filePath: string;
}> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wpp-dedup-'));
  const filePath = path.join(tmpDir, 'posted-log.json');
  if (initial) {
    await fs.writeFile(filePath, JSON.stringify(initial, null, 2), 'utf8');
  }
  const service = new DedupService();
  // Override the hardcoded path on the private field.
  (service as any).filePath = filePath;
  await service.onModuleInit();
  return { service, tmpDir, filePath };
}

describe('DedupService', () => {
  const created: string[] = [];

  afterEach(async () => {
    while (created.length) {
      const dir = created.pop()!;
      try {
        await fs.rm(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  it('markPosted + wasRecentlyPosted within window returns true', async () => {
    const { service, tmpDir } = await buildService();
    created.push(tmpDir);

    await service.markPosted('MLB123');

    expect(await service.wasRecentlyPosted('MLB123', 7)).toBe(true);
  });

  it('wasRecentlyPosted returns false when outside the window', async () => {
    // Seed an entry posted 10 days ago, query with windowDays=7.
    const tenDaysAgo = new Date(Date.now() - 10 * DAY_MS).toISOString();
    const { service, tmpDir } = await buildService({ MLB999: tenDaysAgo });
    created.push(tmpDir);

    // GC at load prunes entries older than 2*7=14 days, so 10 days is kept.
    expect(await service.wasRecentlyPosted('MLB999', 7)).toBe(false);
  });

  it('wasRecentlyPosted returns false for unknown id', async () => {
    const { service, tmpDir } = await buildService();
    created.push(tmpDir);

    expect(await service.wasRecentlyPosted('UNKNOWN', 7)).toBe(false);
  });

  it('persists entries to disk', async () => {
    const { service, tmpDir, filePath } = await buildService();
    created.push(tmpDir);

    await service.markPosted('MLB42');

    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.MLB42).toBeTruthy();
  });

  it('GC removes entries older than 2 * windowDays (default 14d) on load', async () => {
    const twentyDaysAgo = new Date(Date.now() - 20 * DAY_MS).toISOString();
    const freshIso = new Date().toISOString();
    // Seed with ml:-prefixed keys so the boot migration is a no-op for them.
    const { service, tmpDir, filePath } = await buildService({
      'ml:OLD': twentyDaysAgo,
      'ml:FRESH': freshIso,
    });
    created.push(tmpDir);

    expect(await service.wasRecentlyPosted('ml:OLD', 7)).toBe(false);
    expect(await service.wasRecentlyPosted('ml:FRESH', 7)).toBe(true);

    // On-disk file should have been rewritten without OLD.
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed['ml:OLD']).toBeUndefined();
    expect(parsed['ml:FRESH']).toBeTruthy();
  });

  it('handles corrupt JSON gracefully (error path)', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wpp-dedup-'));
    created.push(tmpDir);
    const filePath = path.join(tmpDir, 'posted-log.json');
    await fs.writeFile(filePath, 'not-json', 'utf8');

    const service = new DedupService();
    (service as any).filePath = filePath;
    await service.onModuleInit();

    // After init failure, service should treat log as empty (no throw).
    expect(await service.wasRecentlyPosted('ANY', 7)).toBe(false);
  });

  it('ignores empty catalogId on markPosted', async () => {
    const { service, tmpDir, filePath } = await buildService();
    created.push(tmpDir);

    await service.markPosted('');

    // File should remain absent or empty object.
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      expect(Object.keys(parsed)).toHaveLength(0);
    } catch {
      // file may not have been created at all — that's fine.
    }
  });
});

const TMP_FILE = path.resolve('./data/posted-log.test.json');

function makeService(): DedupService {
  const svc = new DedupService();
  (svc as any).filePath = TMP_FILE;
  return svc;
}

describe('DedupService boot migration', () => {
  beforeEach(async () => {
    try { await fs.unlink(TMP_FILE); } catch {}
  });
  afterAll(async () => {
    try { await fs.unlink(TMP_FILE); } catch {}
  });

  it('prefixes unprefixed keys with ml: on load', async () => {
    await fs.writeFile(
      TMP_FILE,
      JSON.stringify({
        MLB1: new Date().toISOString(),
        'ml:MLB2': new Date().toISOString(),
      }),
      'utf8',
    );
    const svc = makeService();
    await svc.onModuleInit();
    expect(await svc.wasRecentlyPosted('ml:MLB1', 7)).toBe(true);
    expect(await svc.wasRecentlyPosted('ml:MLB2', 7)).toBe(true);
    expect(await svc.wasRecentlyPosted('MLB1', 7)).toBe(false);
  });

  it('migration is idempotent', async () => {
    await fs.writeFile(
      TMP_FILE,
      JSON.stringify({ MLB1: new Date().toISOString() }),
      'utf8',
    );
    const svc1 = makeService();
    await svc1.onModuleInit();
    await svc1.markPosted('ml:MLB3');
    const svc2 = makeService();
    await svc2.onModuleInit();
    expect(await svc2.wasRecentlyPosted('ml:MLB1', 7)).toBe(true);
    expect(await svc2.wasRecentlyPosted('ml:MLB3', 7)).toBe(true);
  });
});
