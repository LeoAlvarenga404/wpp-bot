import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { CategoryRotatorService } from './category-rotator.service';

function makeConfig(weightsEnv?: string): ConfigService {
  return {
    get: jest.fn().mockImplementation((key: string, def?: any) => {
      if (key === 'CATEGORY_WEIGHTS') return weightsEnv ?? def;
      return def;
    }),
  } as unknown as ConfigService;
}

// STATE_FILE is captured at module load with the cwd at that point, so we
// reconstruct the same path here and back up / restore any pre-existing file.
const STATE_FILE = path.join(process.cwd(), 'data', 'last-category.json');

describe('CategoryRotatorService', () => {
  let backup: string | null = null;

  beforeEach(() => {
    // Back up any real state file so we don't trash dev state.
    if (fs.existsSync(STATE_FILE)) {
      backup = fs.readFileSync(STATE_FILE, 'utf8');
      fs.unlinkSync(STATE_FILE);
    } else {
      backup = null;
    }
  });

  afterEach(() => {
    // Remove anything the test wrote.
    if (fs.existsSync(STATE_FILE)) {
      try {
        fs.unlinkSync(STATE_FILE);
      } catch {
        // ignore
      }
    }
    // Restore backup if there was one.
    if (backup !== null) {
      const dir = path.dirname(STATE_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(STATE_FILE, backup, 'utf8');
    }
    jest.restoreAllMocks();
  });

  it('parses CATEGORY_WEIGHTS env correctly', () => {
    const svc = new CategoryRotatorService(makeConfig());
    const parsed = svc.parseWeights('MLB1648:3,MLB1000:2,MLB1051:1');
    expect(parsed).toEqual([
      { category: 'MLB1648', weight: 3 },
      { category: 'MLB1000', weight: 2 },
      { category: 'MLB1051', weight: 1 },
    ]);
  });

  it('skips invalid pairs in parseWeights', () => {
    const svc = new CategoryRotatorService(makeConfig());
    const parsed = svc.parseWeights(
      'MLB1648:3,bad,MLB1000:notanumber,:5,MLB1:0',
    );
    expect(parsed).toEqual([{ category: 'MLB1648', weight: 3 }]);
  });

  it('returns empty array on empty input', () => {
    const svc = new CategoryRotatorService(makeConfig());
    expect(svc.parseWeights('')).toEqual([]);
    expect(svc.parseWeights('   ')).toEqual([]);
  });

  it('never picks the same category as last when more than one is defined', () => {
    const svc = new CategoryRotatorService(makeConfig('MLB1:1,MLB2:1,MLB3:1'));
    svc.onModuleInit();

    const seen = new Set<string>();
    let prev: string | null = null;
    for (let i = 0; i < 30; i++) {
      const cat = svc.pick();
      expect(cat).not.toBeNull();
      expect(cat).not.toBe(prev);
      prev = cat;
      seen.add(cat!);
    }
    // Sanity: rotation should hit more than one category.
    expect(seen.size).toBeGreaterThan(1);
  });

  it('falls back to the single category when only one is configured', () => {
    const svc = new CategoryRotatorService(makeConfig('MLB42:1'));
    svc.onModuleInit();

    expect(svc.pick()).toBe('MLB42');
    expect(svc.pick()).toBe('MLB42'); // single-cat mode allows repeat
    expect(svc.getLast()).toBe('MLB42');
  });

  it('returns null when no categories are configured', () => {
    const svc = new CategoryRotatorService(makeConfig(''));
    svc.onModuleInit();
    (svc as any).weights = []; // simulate empty parse result regardless of default
    expect(svc.pick()).toBeNull();
  });

  it('persists chosen category to file under data/', () => {
    const svc = new CategoryRotatorService(makeConfig('MLB1:1,MLB2:1'));
    svc.onModuleInit();

    svc.pick();

    expect(fs.existsSync(STATE_FILE)).toBe(true);
    const stored = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    expect(typeof stored.lastCategory).toBe('string');
    expect(stored.lastCategory).toMatch(/^MLB[12]$/);
  });

  it('loads persisted state on init', () => {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      STATE_FILE,
      JSON.stringify({
        lastCategory: 'MLB1648',
        updatedAt: new Date().toISOString(),
      }),
      'utf8',
    );

    const svc = new CategoryRotatorService(makeConfig('MLB1648:1,MLB1000:1'));
    svc.onModuleInit();

    expect(svc.getLast()).toBe('MLB1648');
  });

  it('handles corrupt persisted state without throwing (error path)', () => {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, '{{ not json', 'utf8');

    const svc = new CategoryRotatorService(makeConfig('MLB1:1,MLB2:1'));
    expect(() => svc.onModuleInit()).not.toThrow();
    expect(svc.getLast()).toBeNull();
  });

  it('getWeighted returns the parsed entries', () => {
    const config = { get: () => 'A:2,B:3' } as any;
    const svc = new CategoryRotatorService(config);
    svc.onModuleInit();
    expect(svc.getWeighted()).toEqual([
      { category: 'A', weight: 2 },
      { category: 'B', weight: 3 },
    ]);
  });
});
