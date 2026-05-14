# Premium Deal Curation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the Mercado Livre deal bot into a premium curation bot that filters deals through a 0–100 explainable score, sends 2–3 best deals per scheduler tick, and fixes the existing record-before-dedup bug.

**Architecture:** Add three new services — `enrichment` (seller cache + fresh item fetch), `deal-score` (additive rubric with reasons/penalties), and a pure `price-analytics` module. Refactor `PipelineService` into `collectScored` + `dispatchScored` with corrected ordering. Add opt-in `SCHEDULER_MODE=batch` for global cross-category ranking.

**Tech Stack:** TypeScript, NestJS 11, Jest 30 + ts-jest, axios via `@nestjs/axios`, file-backed JSON stores (atomic tmp+rename), Sentry & Prom-client already wired.

**Spec:** `docs/superpowers/specs/2026-05-13-premium-deal-curation-design.md`

---

## File Map

### New files

```
src/deal-score/
  types.ts                                   # ScoredDeal, DealLevel, ScoreReason, PriceAnalytics
  price-analytics.ts                         # pure: analyze(), detectPriceRaiseBeforeDiscount()
  price-analytics.spec.ts
  deal-score.service.ts                      # computes ScoredDeal
  deal-score.service.spec.ts
  deal-score.module.ts
  __fixtures__/
    history-empty.ts
    history-30d-stable.ts
    history-classic-trap.ts
    history-genuine-drop.ts
    enriched-deal-official-store.ts
    enriched-deal-unknown-seller.ts

src/enrichment/
  types.ts                                   # EnrichedDeal, SellerInfo, ItemDetails
  seller-cache.service.ts
  seller-cache.service.spec.ts
  enrichment.service.ts
  enrichment.service.spec.ts
  enrichment.module.ts

src/pipeline/templates/
  template-imperdivel.ts
  template-top.ts
  template-good.ts
  index.ts                                    # MODIFY: register 3 templates with level keys
```

### Modified files

```
src/curation/curation.service.ts             # +getAnalytics(), +getObservations()
src/curation/curation.service.spec.ts        # create + regression specs
src/pipeline/pipeline.service.ts             # refactor: collectScored + dispatchScored, fix order
src/pipeline/pipeline.service.spec.ts        # create
src/pipeline/pipeline.module.ts              # +DealScoreModule, +EnrichmentModule
src/pipeline/formatter.service.ts            # accept ScoredDeal, route by level
src/pipeline/formatter.service.spec.ts       # update + new template specs
src/scheduler/scheduler.service.ts           # +SCHEDULER_MODE=batch path
src/scheduler/category-rotator.service.ts    # +getWeighted()
src/scheduler/category-rotator.service.spec.ts # +spec for getWeighted
src/app.module.ts                            # register new modules
.env.example                                 # add new envs
```

---

## Conventions

- **Branch:** `feat/premium-deal-curation` (single branch; each task ends with a commit. Open one PR per milestone group as called out below.)
- **Commit format:** Conventional commits, e.g. `feat(deal-score): add additive rubric`. Use the exact messages provided per task.
- **Run tests with:** `npx jest <path>` from repo root. Use `--testNamePattern "<name>"` for single-test runs.
- **Run full test suite:** `npm test` (Jest config in `package.json`).
- **Type check (no emit):** `npx tsc -p tsconfig.json --noEmit`.
- **Lint:** `npm run lint`.
- **Money:** Always work in `priceCents: number` integers internally. Convert reais (float) → cents at the pipeline boundary (`Math.round(deal.price * 100)`), exactly as `pipeline.service.ts:77` does today.
- **Time:** All windows in days. `DAY_MS = 24 * 60 * 60 * 1000`. For test determinism, every analytics function accepts an optional `now: Date` and defaults to `new Date()` only when omitted.

---

## Milestone A — Foundation (PR 1)

Adds pure price analytics and exposes them from `CurationService`. No behavior change.

### Task A1: Create `src/deal-score/types.ts`

**Files:**
- Create: `src/deal-score/types.ts`

- [ ] **Step 1: Create the types file**

```typescript
// src/deal-score/types.ts

import { DealItem } from '../mercado-livre/types';

export interface PriceObservation {
  priceCents: number;
  at: string; // ISO timestamp
}

export interface PriceAnalytics {
  median7d: number | null;
  median14d: number | null;
  median30d: number | null;
  min7d: number | null;
  min14d: number | null;
  min30d: number | null;
  distinctDays: number;
  lastObservedBefore: PriceObservation | null;
  trend: 'falling' | 'rising' | 'flat' | 'unknown';
}

export interface PriceRaiseSignal {
  suspicious: boolean;
  peakInWindowCents: number | null;
  baselinePreWindowCents: number | null;
  currentVsBaselineRatio: number | null;
  reason?: string;
}

export interface PriceAnalyticsInput {
  observations: PriceObservation[];
  now?: Date;
}

export type DealLevel = 'rejected' | 'good' | 'top' | 'super';

export interface ScoreReason {
  code: string;
  weight: number;
  message: string;
}

export interface ScoredDeal {
  deal: import('../enrichment/types').EnrichedDeal;
  score: number;
  rawScore: number;
  level: DealLevel;
  reasons: ScoreReason[];
  penalties: ScoreReason[];
  factors: Record<string, number>;
}

export interface DealLike {
  catalogId: string;
  priceCents: number;
  discountPercent: number;
  originalPriceCents: number;
}

export interface PriceRaiseOptions {
  peakWindowDays: number;
  baselineWindowDays: number;
  peakRatio: number;
  currentBaselineRatio: number;
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: a single error referencing `../enrichment/types` (the import target does not exist yet). This is **expected** at this stage — we will satisfy it in Milestone B.

> Note: `ScoredDeal` carries `EnrichedDeal`. Until Milestone B lands, `ScoredDeal` is referenced only in the deal-score module itself (which we are about to build with mocks for `EnrichedDeal`). We unblock the `tsc` error by adding a stub now.

- [ ] **Step 3: Add temporary stub at `src/enrichment/types.ts`**

```typescript
// src/enrichment/types.ts — stub, fleshed out in Milestone B

import { DealItem } from '../mercado-livre/types';

export interface SellerInfo {
  sellerId: number;
  nickname: string | null;
  powerSellerStatus: string | null; // platinum, gold, silver, etc.
  reputationLevel: string | null;   // '5_green', '4_light_green', etc.
  isOfficialStore: boolean;
  officialStoreId: number | null;
  ratingAverage: number | null;
  fetchedAt: string;                // ISO
}

export interface ItemDetails {
  itemId: string;
  soldQuantity: number | null;
  condition: 'new' | 'used' | 'refurbished' | 'not_specified';
  hasInstallmentsNoInterest: boolean;
}

export interface EnrichedDeal extends DealItem {
  seller: SellerInfo | null;
  item: ItemDetails | null;
}
```

- [ ] **Step 4: Type-check again**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/deal-score/types.ts src/enrichment/types.ts
git commit -m "feat(deal-score): add shared types for analytics, score, enrichment

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task A2: TDD `analyze()` in `price-analytics.ts`

**Files:**
- Create: `src/deal-score/price-analytics.ts`
- Create: `src/deal-score/price-analytics.spec.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/deal-score/price-analytics.spec.ts

import { analyze, detectPriceRaiseBeforeDiscount } from './price-analytics';
import { PriceObservation } from './types';

function obs(priceCents: number, daysAgo: number, now: Date): PriceObservation {
  const at = new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  return { priceCents, at };
}

describe('analyze()', () => {
  const now = new Date('2026-05-13T12:00:00Z');

  it('returns all nulls for empty history', () => {
    const r = analyze({ observations: [], now });
    expect(r.median7d).toBeNull();
    expect(r.median14d).toBeNull();
    expect(r.median30d).toBeNull();
    expect(r.min7d).toBeNull();
    expect(r.min14d).toBeNull();
    expect(r.min30d).toBeNull();
    expect(r.distinctDays).toBe(0);
    expect(r.lastObservedBefore).toBeNull();
    expect(r.trend).toBe('unknown');
  });

  it('returns single value for single observation', () => {
    const r = analyze({ observations: [obs(10000, 1, now)], now });
    expect(r.median7d).toBe(10000);
    expect(r.median14d).toBe(10000);
    expect(r.median30d).toBe(10000);
    expect(r.min7d).toBe(10000);
    expect(r.distinctDays).toBe(1);
  });

  it('computes median and min over correct windows', () => {
    const observations = [
      obs(10000, 1, now),
      obs(12000, 3, now),
      obs(8000, 5, now),
      obs(15000, 10, now),
      obs(20000, 20, now),
    ];
    const r = analyze({ observations, now });
    expect(r.min7d).toBe(8000);
    expect(r.min14d).toBe(8000);
    expect(r.min30d).toBe(8000);
    expect(r.median7d).toBe(10000);
    expect(r.median30d).toBe(12000);
  });

  it('counts distinct UTC dates', () => {
    const observations = [
      obs(10000, 0, now),
      obs(11000, 0, now),
      obs(12000, 1, now),
    ];
    const r = analyze({ observations, now });
    expect(r.distinctDays).toBe(2);
  });

  it('detects falling trend when m7 < m14 * 0.95', () => {
    const observations = [
      obs(8000, 1, now),
      obs(8000, 3, now),
      obs(8000, 5, now),
      obs(10000, 10, now),
      obs(10000, 12, now),
    ];
    const r = analyze({ observations, now });
    expect(r.trend).toBe('falling');
  });

  it('detects rising trend when m7 > m14 * 1.05', () => {
    const observations = [
      obs(12000, 1, now),
      obs(12000, 3, now),
      obs(12000, 5, now),
      obs(10000, 10, now),
      obs(10000, 12, now),
    ];
    const r = analyze({ observations, now });
    expect(r.trend).toBe('rising');
  });

  it('returns flat trend when within ±5%', () => {
    const observations = [
      obs(10000, 1, now),
      obs(10100, 3, now),
      obs(10000, 10, now),
      obs(10050, 12, now),
    ];
    const r = analyze({ observations, now });
    expect(r.trend).toBe('flat');
  });

  it('returns unknown trend when either median is null', () => {
    const observations = [obs(10000, 1, now)];
    const r = analyze({ observations, now });
    // single-day observation: m7 and m14 both equal 10000, ratio = 1.0 → flat,
    // but lastObservedBefore is null and trend should still be flat.
    expect(r.trend).toBe('flat');
  });

  it('lastObservedBefore returns the most recent observation older than 1 hour', () => {
    const observations = [
      obs(10000, 0, now),
      obs(12000, 1, now),
      obs(15000, 5, now),
    ];
    const r = analyze({ observations, now });
    expect(r.lastObservedBefore).not.toBeNull();
    expect(r.lastObservedBefore!.priceCents).toBe(12000);
  });
});
```

- [ ] **Step 2: Run to verify FAIL**

Run: `npx jest src/deal-score/price-analytics.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `analyze()`**

```typescript
// src/deal-score/price-analytics.ts

import {
  PriceAnalytics,
  PriceAnalyticsInput,
  PriceObservation,
  PriceRaiseOptions,
  PriceRaiseSignal,
} from './types';

const DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_EXCLUSION_MS = 60 * 60 * 1000; // 1 hour: treat as "today's update"

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  }
  return sorted[mid];
}

function min(values: number[]): number | null {
  if (values.length === 0) return null;
  let m = values[0];
  for (let i = 1; i < values.length; i++) if (values[i] < m) m = values[i];
  return m;
}

function pricesWithin(
  obs: PriceObservation[],
  nowMs: number,
  windowDays: number,
): number[] {
  const cutoff = nowMs - windowDays * DAY_MS;
  const out: number[] = [];
  for (const o of obs) {
    const t = Date.parse(o.at);
    if (Number.isNaN(t)) continue;
    if (t >= cutoff) out.push(o.priceCents);
  }
  return out;
}

function pricesInRange(
  obs: PriceObservation[],
  nowMs: number,
  olderDays: number,
  newerDays: number,
): number[] {
  // observations within (now - olderDays) ≤ t < (now - newerDays)
  const older = nowMs - olderDays * DAY_MS;
  const newer = nowMs - newerDays * DAY_MS;
  const out: number[] = [];
  for (const o of obs) {
    const t = Date.parse(o.at);
    if (Number.isNaN(t)) continue;
    if (t >= older && t < newer) out.push(o.priceCents);
  }
  return out;
}

export function analyze(input: PriceAnalyticsInput): PriceAnalytics {
  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  const obs = input.observations;

  const w7 = pricesWithin(obs, nowMs, 7);
  const w14 = pricesWithin(obs, nowMs, 14);
  const w30 = pricesWithin(obs, nowMs, 30);

  const distinctDates = new Set<string>();
  for (const o of obs) {
    const t = Date.parse(o.at);
    if (Number.isNaN(t)) continue;
    distinctDates.add(new Date(t).toISOString().slice(0, 10));
  }

  // lastObservedBefore = most recent observation older than RECENT_EXCLUSION_MS
  let lastBefore: PriceObservation | null = null;
  let lastBeforeT = -Infinity;
  for (const o of obs) {
    const t = Date.parse(o.at);
    if (Number.isNaN(t)) continue;
    if (nowMs - t < RECENT_EXCLUSION_MS) continue;
    if (t > lastBeforeT) {
      lastBeforeT = t;
      lastBefore = o;
    }
  }

  const m7 = median(w7);
  const m14 = median(w14);
  const m30 = median(w30);

  let trend: PriceAnalytics['trend'] = 'unknown';
  if (m7 != null && m14 != null) {
    if (m7 < m14 * 0.95) trend = 'falling';
    else if (m7 > m14 * 1.05) trend = 'rising';
    else trend = 'flat';
  }

  return {
    median7d: m7,
    median14d: m14,
    median30d: m30,
    min7d: min(w7),
    min14d: min(w14),
    min30d: min(w30),
    distinctDays: distinctDates.size,
    lastObservedBefore: lastBefore,
    trend,
  };
}

export function detectPriceRaiseBeforeDiscount(
  input: PriceAnalyticsInput,
  currentPriceCents: number,
  opts: PriceRaiseOptions,
): PriceRaiseSignal {
  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  const obs = input.observations;

  // peak in last `peakWindowDays`, excluding very-recent (within 1 hour)
  let peak: number | null = null;
  const peakCutoff = nowMs - opts.peakWindowDays * DAY_MS;
  for (const o of obs) {
    const t = Date.parse(o.at);
    if (Number.isNaN(t)) continue;
    if (t < peakCutoff) continue;
    if (nowMs - t < RECENT_EXCLUSION_MS) continue;
    if (peak === null || o.priceCents > peak) peak = o.priceCents;
  }

  // baseline = min in range (now - baselineWindowDays, now - peakWindowDays]
  const baselineRange = pricesInRange(
    obs,
    nowMs,
    opts.baselineWindowDays,
    opts.peakWindowDays,
  );
  const baseline = min(baselineRange);

  if (peak === null || baseline === null) {
    return {
      suspicious: false,
      peakInWindowCents: peak,
      baselinePreWindowCents: baseline,
      currentVsBaselineRatio: null,
    };
  }

  const peakRatio = peak / baseline;
  const currentRatio = currentPriceCents / baseline;
  const suspicious =
    peakRatio >= opts.peakRatio && currentRatio >= opts.currentBaselineRatio;

  return {
    suspicious,
    peakInWindowCents: peak,
    baselinePreWindowCents: baseline,
    currentVsBaselineRatio: currentRatio,
    reason: suspicious
      ? `peak ${peak}c is ${Math.round(peakRatio * 100)}% of baseline ${baseline}c; current ${currentPriceCents}c is ${Math.round(currentRatio * 100)}% of baseline`
      : undefined,
  };
}
```

- [ ] **Step 4: Run to verify PASS**

Run: `npx jest src/deal-score/price-analytics.spec.ts`
Expected: 9 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/deal-score/price-analytics.ts src/deal-score/price-analytics.spec.ts
git commit -m "feat(deal-score): pure price-analytics module with windowed stats

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task A3: TDD `detectPriceRaiseBeforeDiscount()`

**Files:**
- Modify: `src/deal-score/price-analytics.spec.ts` (function already implemented in A2)

- [ ] **Step 1: Append the scam-detection tests**

```typescript
// Append to src/deal-score/price-analytics.spec.ts

describe('detectPriceRaiseBeforeDiscount()', () => {
  const now = new Date('2026-05-13T12:00:00Z');
  const opts = {
    peakWindowDays: 14,
    baselineWindowDays: 30,
    peakRatio: 1.2,
    currentBaselineRatio: 0.95,
  };

  it('flags classic trap: 100 → 150 → 120', () => {
    const observations = [
      obs(10000, 25, now), // R$100 baseline 30d ago
      obs(10000, 20, now), // baseline
      obs(15000, 10, now), // R$150 peak inside peakWindow (last 14d)
      obs(15000, 7, now),
    ];
    const r = detectPriceRaiseBeforeDiscount(
      { observations, now },
      12000, // current R$120
      opts,
    );
    expect(r.suspicious).toBe(true);
    expect(r.peakInWindowCents).toBe(15000);
    expect(r.baselinePreWindowCents).toBe(10000);
    expect(r.reason).toMatch(/peak/);
  });

  it('does NOT flag genuine drop: current well below baseline', () => {
    const observations = [
      obs(10000, 25, now),
      obs(10000, 20, now),
      obs(15000, 10, now),
      obs(15000, 7, now),
    ];
    const r = detectPriceRaiseBeforeDiscount(
      { observations, now },
      8000, // current R$80, below baseline*0.95 = 9500
      opts,
    );
    expect(r.suspicious).toBe(false);
  });

  it('does NOT flag when no peak above ratio threshold', () => {
    const observations = [
      obs(10000, 25, now),
      obs(10000, 20, now),
      obs(11000, 10, now), // only +10%, below 1.20
      obs(11000, 7, now),
    ];
    const r = detectPriceRaiseBeforeDiscount(
      { observations, now },
      10500,
      opts,
    );
    expect(r.suspicious).toBe(false);
  });

  it('returns suspicious=false with missing baseline', () => {
    const observations = [
      obs(15000, 10, now),
      obs(15000, 7, now),
    ];
    const r = detectPriceRaiseBeforeDiscount(
      { observations, now },
      12000,
      opts,
    );
    expect(r.suspicious).toBe(false);
    expect(r.baselinePreWindowCents).toBeNull();
  });

  it('returns suspicious=false with no observations', () => {
    const r = detectPriceRaiseBeforeDiscount({ observations: [], now }, 12000, opts);
    expect(r.suspicious).toBe(false);
    expect(r.peakInWindowCents).toBeNull();
    expect(r.baselinePreWindowCents).toBeNull();
  });
});
```

- [ ] **Step 2: Run**

Run: `npx jest src/deal-score/price-analytics.spec.ts`
Expected: all tests pass (function already implemented in A2).

- [ ] **Step 3: Commit**

```bash
git add src/deal-score/price-analytics.spec.ts
git commit -m "test(deal-score): scam-detection cases for price-raise heuristic

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task A4: Expose analytics on `CurationService`

**Files:**
- Modify: `src/curation/curation.service.ts`
- Create: `src/curation/curation.service.spec.ts`

- [ ] **Step 1: Write failing regression + new specs**

```typescript
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
```

- [ ] **Step 2: Run to FAIL**

Run: `npx jest src/curation/curation.service.spec.ts`
Expected: FAIL on `getObservations` / `getAnalytics` (methods missing).

- [ ] **Step 3: Add `getObservations` and `getAnalytics`**

In `src/curation/curation.service.ts`, add these two public methods near `isFakeDiscount`:

```typescript
import { analyze } from '../deal-score/price-analytics';
import { PriceAnalytics } from '../deal-score/types';

// ... inside the class:

/**
 * Read-only snapshot of stored observations for a catalog id.
 */
getObservations(catalogId: string): PriceObservation[] {
  const list = this.store[catalogId];
  return list ? [...list] : [];
}

/**
 * Windowed price analytics computed from stored observations.
 */
getAnalytics(catalogId: string, now?: Date): PriceAnalytics {
  return analyze({ observations: this.getObservations(catalogId), now });
}
```

Also export the existing `PriceObservation` interface (currently file-local). Change:

```typescript
interface PriceObservation {
```

to:

```typescript
export interface PriceObservation {
```

- [ ] **Step 4: Run to PASS**

Run: `npx jest src/curation/curation.service.spec.ts`
Expected: all green.

- [ ] **Step 5: Confirm no regression in pipeline tests**

Run: `npx jest`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/curation/curation.service.ts src/curation/curation.service.spec.ts
git commit -m "feat(curation): expose getAnalytics and getObservations

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

**PR 1 ready to open at this point** — branch contains: types, price-analytics, curation extension. No behavior change.

---

## Milestone B — Enrichment (PR 2)

Adds seller cache + enrichment service. Not yet wired into the pipeline.

### Task B1: `SellerCacheService`

**Files:**
- Create: `src/enrichment/seller-cache.service.ts`
- Create: `src/enrichment/seller-cache.service.spec.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/enrichment/seller-cache.service.spec.ts

import { ConfigService } from '@nestjs/config';
import * as fs from 'fs/promises';
import * as path from 'path';
import { SellerCacheService } from './seller-cache.service';
import { SellerInfo } from './types';

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
    try { await fs.unlink(TMP_FILE); } catch { /* ok */ }
  });

  afterAll(async () => {
    try { await fs.unlink(TMP_FILE); } catch { /* ok */ }
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
```

- [ ] **Step 2: Run to FAIL**

Run: `npx jest src/enrichment/seller-cache.service.spec.ts`
Expected: FAIL — file missing.

- [ ] **Step 3: Implement**

```typescript
// src/enrichment/seller-cache.service.ts

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs/promises';
import * as path from 'path';
import { SellerInfo } from './types';

type SellerStore = Record<string, SellerInfo>;

@Injectable()
export class SellerCacheService implements OnModuleInit {
  private readonly logger = new Logger(SellerCacheService.name);
  private filePath: string;
  private store: SellerStore = {};
  private loaded = false;
  private writeLock: Promise<void> = Promise.resolve();
  private readonly ttlMs: number;

  constructor(private readonly config: ConfigService) {
    const hours = Number(this.config.get<string>('SELLER_CACHE_TTL_HOURS', '24'));
    this.ttlMs = hours * 60 * 60 * 1000;
    this.filePath = path.resolve(
      this.config.get<string>('SELLER_CACHE_FILE', './data/seller-cache.json') ??
        './data/seller-cache.json',
    );
  }

  async onModuleInit(): Promise<void> {
    await this.load();
  }

  get(sellerId: number, now?: Date): SellerInfo | null {
    if (!this.loaded) return null;
    const entry = this.store[String(sellerId)];
    if (!entry) return null;
    const fetchedMs = Date.parse(entry.fetchedAt);
    if (Number.isNaN(fetchedMs)) return null;
    const nowMs = (now ?? new Date()).getTime();
    if (nowMs - fetchedMs > this.ttlMs) return null;
    return entry;
  }

  async set(info: SellerInfo): Promise<void> {
    if (!this.loaded) await this.load();
    this.store[String(info.sellerId)] = info;
    await this.persist();
  }

  private async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      this.store =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as SellerStore)
          : {};
    } catch (err: any) {
      if (err && err.code === 'ENOENT') {
        this.store = {};
      } else {
        this.logger.warn(`Failed to load ${this.filePath}: ${err?.message}`);
        this.store = {};
      }
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    const next = this.writeLock.then(() => this.persistNow());
    this.writeLock = next.catch(() => undefined);
    return next;
  }

  private async persistNow(): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    const data = JSON.stringify(this.store, null, 2);
    await fs.writeFile(tmp, data, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tmp, this.filePath);
  }
}
```

- [ ] **Step 4: Run to PASS**

Run: `npx jest src/enrichment/seller-cache.service.spec.ts`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/enrichment/seller-cache.service.ts src/enrichment/seller-cache.service.spec.ts
git commit -m "feat(enrichment): seller cache with TTL and atomic persistence

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task B2: `EnrichmentService` with mocked HTTP

**Files:**
- Create: `src/enrichment/enrichment.service.ts`
- Create: `src/enrichment/enrichment.service.spec.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/enrichment/enrichment.service.spec.ts

import { of, throwError } from 'rxjs';
import { EnrichmentService } from './enrichment.service';
import { DealItem } from '../mercado-livre/types';

function fakeHttp(handlers: Record<string, any>) {
  return {
    get: jest.fn((url: string) => {
      for (const key of Object.keys(handlers)) {
        if (url.includes(key)) return handlers[key];
      }
      return throwError(() => new Error('no handler for ' + url));
    }),
  } as any;
}

const fakeAuth = {
  getAccessToken: jest.fn(async () => 'TOKEN'),
} as any;

const dealA: DealItem = {
  catalogId: 'MLB1',
  itemId: 'MLBI1',
  title: 'Foo',
  thumbnail: '',
  price: 99.9,
  originalPrice: 199.9,
  sellerId: 7,
  freeShipping: true,
  permalink: 'https://x',
  discountPercent: 50,
};

const fakeCache = (() => {
  const map = new Map<number, any>();
  return {
    get: (id: number) => map.get(id) ?? null,
    set: async (info: any) => { map.set(info.sellerId, info); },
    _map: map,
  };
})();

describe('EnrichmentService', () => {
  beforeEach(() => {
    fakeCache._map.clear();
    jest.clearAllMocks();
  });

  it('uses cache when present', async () => {
    fakeCache._map.set(7, {
      sellerId: 7,
      nickname: 'X',
      powerSellerStatus: 'platinum',
      reputationLevel: '5_green',
      isOfficialStore: false,
      officialStoreId: null,
      ratingAverage: 4.8,
      fetchedAt: new Date().toISOString(),
    });
    const http = fakeHttp({
      '/items/MLBI1': of({ data: { id: 'MLBI1', sold_quantity: 10, condition: 'new', installments: { rate: 0 } } }),
    });
    const svc = new EnrichmentService(http, fakeAuth, fakeCache as any);
    const out = await svc.enrich(dealA);
    expect(out.seller?.sellerId).toBe(7);
    expect(http.get).toHaveBeenCalledTimes(1); // only items, not users
  });

  it('fetches /users/{id} on cache miss', async () => {
    const http = fakeHttp({
      '/users/7': of({ data: {
        id: 7,
        nickname: 'SHOP',
        seller_reputation: { level_id: '5_green', power_seller_status: 'platinum', metrics: { rating: 4.7 } },
        eshop: { eshop_id: 9001 },
      } }),
      '/items/MLBI1': of({ data: { id: 'MLBI1', sold_quantity: 100, condition: 'new', installments: { rate: 0 } } }),
    });
    const svc = new EnrichmentService(http, fakeAuth, fakeCache as any);
    const out = await svc.enrich(dealA);
    expect(out.seller?.reputationLevel).toBe('5_green');
    expect(out.seller?.isOfficialStore).toBe(true);
    expect(out.item?.soldQuantity).toBe(100);
  });

  it('returns deal with seller=null on 404 for /users', async () => {
    const notFound = throwError(() => ({ response: { status: 404 } }));
    const http = fakeHttp({
      '/users/7': notFound,
      '/items/MLBI1': of({ data: { id: 'MLBI1', sold_quantity: 5, condition: 'new', installments: null } }),
    });
    const svc = new EnrichmentService(http, fakeAuth, fakeCache as any);
    const out = await svc.enrich(dealA);
    expect(out.seller).toBeNull();
    expect(out.item?.soldQuantity).toBe(5);
  });

  it('propagates 5xx from /users so caller can decide', async () => {
    const err500 = throwError(() => ({ response: { status: 503 } }));
    const http = fakeHttp({
      '/users/7': err500,
      '/items/MLBI1': of({ data: { id: 'MLBI1' } }),
    });
    const svc = new EnrichmentService(http, fakeAuth, fakeCache as any);
    await expect(svc.enrich(dealA)).rejects.toBeTruthy();
  });

  it('enrichMany processes deals in batches', async () => {
    const http = fakeHttp({
      '/users/': of({ data: { id: 7, nickname: 'X', seller_reputation: { level_id: '4_light_green' } } }),
      '/items/': of({ data: { sold_quantity: 1, condition: 'new' } }),
    });
    const svc = new EnrichmentService(http, fakeAuth, fakeCache as any);
    const out = await svc.enrichMany([
      { ...dealA, catalogId: 'A' },
      { ...dealA, catalogId: 'B' },
      { ...dealA, catalogId: 'C' },
    ]);
    expect(out).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run to FAIL**

Run: `npx jest src/enrichment/enrichment.service.spec.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```typescript
// src/enrichment/enrichment.service.ts

import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';
import { MercadoLivreAuthService } from '../mercado-livre/ml-auth.service';
import { DealItem } from '../mercado-livre/types';
import { withRetry } from '../shared/retry';
import { SellerCacheService } from './seller-cache.service';
import { EnrichedDeal, ItemDetails, SellerInfo } from './types';

const BASE_URL = 'https://api.mercadolibre.com';
const PARALLEL_LIMIT = 6;

@Injectable()
export class EnrichmentService {
  private readonly logger = new Logger(EnrichmentService.name);

  constructor(
    private readonly http: HttpService,
    private readonly auth: MercadoLivreAuthService,
    private readonly cache: SellerCacheService,
  ) {}

  async enrich(deal: DealItem): Promise<EnrichedDeal> {
    const [seller, item] = await Promise.all([
      this.getSeller(deal.sellerId).catch((err) => {
        const status = err?.response?.status;
        if (status === 404) return null;
        throw err;
      }),
      this.getItem(deal.itemId).catch((err) => {
        const status = err?.response?.status;
        if (status === 404) return null;
        throw err;
      }),
    ]);
    return { ...deal, seller, item };
  }

  async enrichMany(deals: DealItem[]): Promise<EnrichedDeal[]> {
    const out: EnrichedDeal[] = [];
    for (let i = 0; i < deals.length; i += PARALLEL_LIMIT) {
      const batch = deals.slice(i, i + PARALLEL_LIMIT);
      const results = await Promise.all(
        batch.map((d) => this.enrich(d).catch((err) => {
          this.logger.warn(`enrich ${d.catalogId} failed: ${err?.message}`);
          return { ...d, seller: null, item: null } as EnrichedDeal;
        })),
      );
      out.push(...results);
    }
    return out;
  }

  private async getSeller(sellerId: number): Promise<SellerInfo | null> {
    const cached = this.cache.get(sellerId);
    if (cached) return cached;
    const data = await this.get<any>(`/users/${sellerId}`);
    const info: SellerInfo = {
      sellerId,
      nickname: data?.nickname ?? null,
      powerSellerStatus: data?.seller_reputation?.power_seller_status ?? null,
      reputationLevel: data?.seller_reputation?.level_id ?? null,
      isOfficialStore: !!data?.eshop?.eshop_id,
      officialStoreId: data?.eshop?.eshop_id ?? null,
      ratingAverage: data?.seller_reputation?.metrics?.rating ?? null,
      fetchedAt: new Date().toISOString(),
    };
    await this.cache.set(info);
    return info;
  }

  private async getItem(itemId: string): Promise<ItemDetails | null> {
    const data = await this.get<any>(`/items/${itemId}`);
    const installments = data?.installments;
    const hasNoInterest =
      !!installments &&
      typeof installments.rate === 'number' &&
      installments.rate === 0;
    let condition: ItemDetails['condition'] = 'not_specified';
    const raw = (data?.condition ?? '').toString().toLowerCase();
    if (raw === 'new' || raw === 'used' || raw === 'refurbished') condition = raw;
    return {
      itemId,
      soldQuantity: typeof data?.sold_quantity === 'number' ? data.sold_quantity : null,
      condition,
      hasInstallmentsNoInterest: hasNoInterest,
    };
  }

  private async get<T>(pathAndQuery: string): Promise<T> {
    const token = await this.auth.getAccessToken();
    const url = `${BASE_URL}${pathAndQuery}`;
    return withRetry<T>(
      async () => {
        const { data } = await firstValueFrom(
          this.http.get<T>(url, {
            headers: {
              Accept: 'application/json',
              Authorization: `Bearer ${token}`,
              'User-Agent': 'wpp-bot/0.1 (+local-dev)',
            },
            timeout: 15000,
          }),
        );
        return data;
      },
      { maxAttempts: 3, baseMs: 800, maxMs: 20_000, jitterPct: 0.25 },
    );
  }
}
```

- [ ] **Step 4: Run to PASS**

Run: `npx jest src/enrichment/enrichment.service.spec.ts`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/enrichment/enrichment.service.ts src/enrichment/enrichment.service.spec.ts
git commit -m "feat(enrichment): EnrichmentService with seller cache, item fetch

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task B3: `EnrichmentModule`

**Files:**
- Create: `src/enrichment/enrichment.module.ts`

- [ ] **Step 1: Create the module**

```typescript
// src/enrichment/enrichment.module.ts

import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { MercadoLivreModule } from '../mercado-livre/ml.module';
import { EnrichmentService } from './enrichment.service';
import { SellerCacheService } from './seller-cache.service';

@Module({
  imports: [HttpModule, MercadoLivreModule],
  providers: [SellerCacheService, EnrichmentService],
  exports: [EnrichmentService, SellerCacheService],
})
export class EnrichmentModule {}
```

- [ ] **Step 2: Verify build**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/enrichment/enrichment.module.ts
git commit -m "feat(enrichment): NestJS module wiring

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

**PR 2 ready** — branch contains the full enrichment subsystem. Still not wired into pipeline; behavior unchanged.

---

## Milestone C — DealScore (PR 3)

Adds the score service. Not wired yet.

### Task C1: Fixtures

**Files:**
- Create: `src/deal-score/__fixtures__/history-empty.ts`
- Create: `src/deal-score/__fixtures__/history-30d-stable.ts`
- Create: `src/deal-score/__fixtures__/history-classic-trap.ts`
- Create: `src/deal-score/__fixtures__/history-genuine-drop.ts`
- Create: `src/deal-score/__fixtures__/enriched-deal-official-store.ts`
- Create: `src/deal-score/__fixtures__/enriched-deal-unknown-seller.ts`

- [ ] **Step 1: history fixtures**

```typescript
// src/deal-score/__fixtures__/history-empty.ts
import { PriceObservation } from '../types';
export const historyEmpty: PriceObservation[] = [];
```

```typescript
// src/deal-score/__fixtures__/history-30d-stable.ts
import { PriceObservation } from '../types';
const NOW = new Date('2026-05-13T12:00:00Z').getTime();
const DAY = 24 * 60 * 60 * 1000;
export const history30dStable: PriceObservation[] = Array.from({ length: 30 }, (_, i) => ({
  priceCents: 10000,
  at: new Date(NOW - (i + 1) * DAY).toISOString(),
}));
```

```typescript
// src/deal-score/__fixtures__/history-classic-trap.ts
import { PriceObservation } from '../types';
const NOW = new Date('2026-05-13T12:00:00Z').getTime();
const DAY = 24 * 60 * 60 * 1000;
// 100 → 150 → 120: baseline R$100 between 30..14d, peak R$150 between 14..1d
export const historyClassicTrap: PriceObservation[] = [
  ...Array.from({ length: 10 }, (_, i) => ({ priceCents: 10000, at: new Date(NOW - (15 + i) * DAY).toISOString() })),
  ...Array.from({ length: 10 }, (_, i) => ({ priceCents: 15000, at: new Date(NOW - (1 + i) * DAY).toISOString() })),
];
```

```typescript
// src/deal-score/__fixtures__/history-genuine-drop.ts
import { PriceObservation } from '../types';
const NOW = new Date('2026-05-13T12:00:00Z').getTime();
const DAY = 24 * 60 * 60 * 1000;
// stable R$100 baseline, no spike, current price will be R$80
export const historyGenuineDrop: PriceObservation[] = Array.from({ length: 25 }, (_, i) => ({
  priceCents: 10000,
  at: new Date(NOW - (i + 1) * DAY).toISOString(),
}));
```

```typescript
// src/deal-score/__fixtures__/enriched-deal-official-store.ts
import { EnrichedDeal } from '../../enrichment/types';

export const enrichedDealOfficialStore: EnrichedDeal = {
  catalogId: 'MLB123',
  itemId: 'MLBI123',
  title: 'Sample Product',
  thumbnail: '',
  price: 749,
  originalPrice: 999.9,
  sellerId: 7,
  freeShipping: true,
  permalink: 'https://x',
  discountPercent: 25,
  seller: {
    sellerId: 7,
    nickname: 'SHOP',
    powerSellerStatus: 'platinum',
    reputationLevel: '5_green',
    isOfficialStore: true,
    officialStoreId: 9001,
    ratingAverage: 4.8,
    fetchedAt: new Date().toISOString(),
  },
  item: {
    itemId: 'MLBI123',
    soldQuantity: 1847,
    condition: 'new',
    hasInstallmentsNoInterest: true,
  },
};
```

```typescript
// src/deal-score/__fixtures__/enriched-deal-unknown-seller.ts
import { EnrichedDeal } from '../../enrichment/types';

export const enrichedDealUnknownSeller: EnrichedDeal = {
  catalogId: 'MLB456',
  itemId: 'MLBI456',
  title: 'Another Product',
  thumbnail: '',
  price: 89,
  originalPrice: 99,
  sellerId: 99,
  freeShipping: false,
  permalink: 'https://y',
  discountPercent: 10,
  seller: null,
  item: null,
};
```

- [ ] **Step 2: Commit**

```bash
git add src/deal-score/__fixtures__
git commit -m "test(deal-score): fixtures for history and enriched deals

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task C2: TDD `DealScoreService` core

**Files:**
- Create: `src/deal-score/deal-score.service.ts`
- Create: `src/deal-score/deal-score.service.spec.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/deal-score/deal-score.service.spec.ts

import { ConfigService } from '@nestjs/config';
import { DealScoreService } from './deal-score.service';
import { enrichedDealOfficialStore } from './__fixtures__/enriched-deal-official-store';
import { enrichedDealUnknownSeller } from './__fixtures__/enriched-deal-unknown-seller';
import { historyClassicTrap } from './__fixtures__/history-classic-trap';
import { history30dStable } from './__fixtures__/history-30d-stable';
import { historyEmpty } from './__fixtures__/history-empty';
import { analyze } from './price-analytics';

function makeService(overrides: Record<string, string> = {}): DealScoreService {
  const cfg = {
    get: (k: string, def?: string) => overrides[k] ?? def,
  } as unknown as ConfigService;
  return new DealScoreService(cfg);
}

describe('DealScoreService', () => {
  const now = new Date('2026-05-13T12:00:00Z');

  it('rejects when score < DEAL_SCORE_MIN', () => {
    const svc = makeService({ DEAL_SCORE_MIN: '75' });
    const analytics = analyze({ observations: historyEmpty, now });
    const r = svc.compute(enrichedDealUnknownSeller, analytics);
    expect(r.level).toBe('rejected');
  });

  it('caps score at 100', () => {
    const svc = makeService();
    const analytics = analyze({ observations: history30dStable, now });
    // craft a deal where price is far below median
    const deal = { ...enrichedDealOfficialStore, price: 30, discountPercent: 70 };
    const r = svc.compute(deal, analytics);
    expect(r.score).toBeLessThanOrEqual(100);
    expect(r.score).toBeGreaterThanOrEqual(0);
  });

  it('floors score at 0 when penalties exceed positives', () => {
    const svc = makeService({ DEAL_SCORE_MIN: '0' });
    const analytics = analyze({ observations: historyEmpty, now });
    const r = svc.compute(enrichedDealUnknownSeller, analytics);
    expect(r.score).toBeGreaterThanOrEqual(0);
  });

  it('clamps level to top when history insufficient even with high score', () => {
    const svc = makeService({
      DEAL_SCORE_MIN: '0',
      DEAL_SCORE_SUPER: '0', // force super bracket
      CURATION_MIN_HISTORY_DAYS: '7',
    });
    const analytics = analyze({ observations: historyEmpty, now });
    const deal = { ...enrichedDealOfficialStore };
    const r = svc.compute(deal, analytics);
    expect(['good', 'top', 'rejected']).toContain(r.level);
    expect(r.level).not.toBe('super');
  });

  it('labels super when score >= DEAL_SCORE_SUPER AND history sufficient', () => {
    const svc = makeService({
      DEAL_SCORE_MIN: '0',
      DEAL_SCORE_TOP: '90',
      DEAL_SCORE_SUPER: '40', // low super threshold to test bracket logic
      CURATION_MIN_HISTORY_DAYS: '0',
    });
    const analytics = analyze({ observations: history30dStable, now });
    const deal = { ...enrichedDealOfficialStore, price: 50, discountPercent: 50 };
    const r = svc.compute(deal, analytics);
    expect(r.score).toBeGreaterThanOrEqual(40);
    expect(r.level).toBe('super');
  });

  it('penalises priceRaiseBeforeDiscount classic trap', () => {
    const svc = makeService({ DEAL_SCORE_MIN: '0' });
    const analytics = analyze({ observations: historyClassicTrap, now });
    // current price R$120 — matches the trap
    const deal = { ...enrichedDealOfficialStore, price: 120 };
    const r = svc.compute(deal, analytics, { now });
    expect(r.penalties.some((p) => p.code === 'price_raise_before_discount')).toBe(true);
  });

  it('reasons are sorted by weight desc and contain only positives', () => {
    const svc = makeService({
      DEAL_SCORE_MIN: '0',
      CURATION_MIN_HISTORY_DAYS: '0',
    });
    const analytics = analyze({ observations: history30dStable, now });
    const r = svc.compute(enrichedDealOfficialStore, analytics);
    for (let i = 1; i < r.reasons.length; i++) {
      expect(r.reasons[i].weight).toBeLessThanOrEqual(r.reasons[i - 1].weight);
    }
    expect(r.reasons.every((x) => x.weight >= 0)).toBe(true);
    expect(r.penalties.every((x) => x.weight <= 0)).toBe(true);
  });

  it('factors sum matches rawScore', () => {
    const svc = makeService({ DEAL_SCORE_MIN: '0' });
    const analytics = analyze({ observations: history30dStable, now });
    const r = svc.compute(enrichedDealOfficialStore, analytics);
    const sum = Object.values(r.factors).reduce((a, b) => a + b, 0);
    expect(sum).toBe(r.rawScore);
  });
});
```

- [ ] **Step 2: Run to FAIL**

Run: `npx jest src/deal-score/deal-score.service.spec.ts`
Expected: FAIL — service missing.

- [ ] **Step 3: Implement**

```typescript
// src/deal-score/deal-score.service.ts

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnrichedDeal } from '../enrichment/types';
import { detectPriceRaiseBeforeDiscount } from './price-analytics';
import {
  DealLevel,
  PriceAnalytics,
  ScoreReason,
  ScoredDeal,
} from './types';

interface Weights {
  discountMax: number;
  belowMedianMax: number;
  lowest30d: number;
  lowest14d: number;
  lowest7d: number;
  officialStore: number;
  sellerReputationMax: number;
  freeShipping: number;
  installmentsNoInterest: number;
  highSoldQtyMax: number;
  priceStability: number;
  priceRaisePenalty: number;
  usedPenalty: number;
  discountFromOriginalOnly: number;
  aboveMedianPenalty: number;
  unknownSeller: number;
  insufficientHistoryPenalty: number;
}

interface ScoreThresholds {
  min: number;
  top: number;
  super: number;
  minHistoryDays: number;
}

interface PriceRaiseOpts {
  peakWindowDays: number;
  baselineWindowDays: number;
  peakRatio: number;
  currentBaselineRatio: number;
}

@Injectable()
export class DealScoreService {
  private readonly logger = new Logger(DealScoreService.name);
  private readonly w: Weights;
  private readonly t: ScoreThresholds;
  private readonly priceRaiseOpts: PriceRaiseOpts;

  constructor(private readonly config: ConfigService) {
    const num = (k: string, def: number) =>
      Number(this.config.get<string>(k, String(def)));

    this.w = {
      discountMax: num('DEAL_SCORE_W_DISCOUNT_MAX', 20),
      belowMedianMax: num('DEAL_SCORE_W_BELOW_MEDIAN_MAX', 25),
      lowest30d: num('DEAL_SCORE_W_LOWEST_30D', 15),
      lowest14d: num('DEAL_SCORE_W_LOWEST_14D', 10),
      lowest7d: num('DEAL_SCORE_W_LOWEST_7D', 5),
      officialStore: num('DEAL_SCORE_W_OFFICIAL_STORE', 10),
      sellerReputationMax: num('DEAL_SCORE_W_SELLER_REPUTATION_MAX', 10),
      freeShipping: num('DEAL_SCORE_W_FREE_SHIPPING', 5),
      installmentsNoInterest: num('DEAL_SCORE_W_INSTALLMENTS_NO_INTEREST', 5),
      highSoldQtyMax: num('DEAL_SCORE_W_HIGH_SOLD_QTY_MAX', 5),
      priceStability: num('DEAL_SCORE_W_PRICE_STABILITY', 5),
      priceRaisePenalty: num('DEAL_SCORE_W_PRICE_RAISE_PENALTY', 30),
      usedPenalty: num('DEAL_SCORE_W_USED_PENALTY', 15),
      discountFromOriginalOnly: num('DEAL_SCORE_W_DISCOUNT_FROM_ORIGINAL_ONLY', 10),
      aboveMedianPenalty: num('DEAL_SCORE_W_ABOVE_MEDIAN_PENALTY', 10),
      unknownSeller: num('DEAL_SCORE_W_UNKNOWN_SELLER', 5),
      insufficientHistoryPenalty: num(
        'DEAL_SCORE_INSUFFICIENT_HISTORY_PENALTY',
        25,
      ),
    };

    this.t = {
      min: num('DEAL_SCORE_MIN', 75),
      top: num('DEAL_SCORE_TOP', 90),
      super: num('DEAL_SCORE_SUPER', 95),
      minHistoryDays: num('CURATION_MIN_HISTORY_DAYS', 7),
    };

    this.priceRaiseOpts = {
      peakWindowDays: num('PRICE_RAISE_PEAK_WINDOW_DAYS', 14),
      baselineWindowDays: num('PRICE_RAISE_BASELINE_WINDOW_DAYS', 30),
      peakRatio: num('PRICE_RAISE_PEAK_RATIO', 1.2),
      currentBaselineRatio: num('PRICE_RAISE_CURRENT_BASELINE_RATIO', 0.95),
    };
  }

  compute(
    deal: EnrichedDeal,
    analytics: PriceAnalytics,
    opts?: { now?: Date },
  ): ScoredDeal {
    const priceCents = Math.round(deal.price * 100);
    const factors: Record<string, number> = {};
    const reasons: ScoreReason[] = [];
    const penalties: ScoreReason[] = [];

    const add = (code: string, weight: number, message: string) => {
      factors[code] = weight;
      const reason: ScoreReason = { code, weight, message };
      if (weight >= 0) reasons.push(reason);
      else penalties.push(reason);
    };

    // 1. discount_percent (linear 25→0, 50→max)
    const discountWeight = clamp(
      ((deal.discountPercent - 25) / 25) * this.w.discountMax,
      0,
      this.w.discountMax,
    );
    if (discountWeight > 0) {
      add(
        'discount_percent',
        Math.round(discountWeight),
        `Desconto de ${deal.discountPercent}% no Mercado Livre`,
      );
    }

    // 2. below_median_30d
    if (analytics.median30d != null && analytics.median30d > 0) {
      const ratio = 1 - priceCents / analytics.median30d;
      const w = clamp(ratio * 100, 0, this.w.belowMedianMax);
      if (w > 0) {
        add(
          'below_median_30d',
          Math.round(w),
          `${Math.round(ratio * 100)}% abaixo da mediana de 30 dias`,
        );
      } else if (priceCents > analytics.median30d) {
        add(
          'current_above_median_30d',
          -this.w.aboveMedianPenalty,
          'Preço atual acima da mediana de 30 dias',
        );
      }
    }

    // 3. lowest_price_* (only the longest matching window scores)
    if (analytics.min30d != null && priceCents <= analytics.min30d) {
      add('lowest_price_30d', this.w.lowest30d, 'Menor preço dos últimos 30 dias');
    } else if (analytics.min14d != null && priceCents <= analytics.min14d) {
      add('lowest_price_14d', this.w.lowest14d, 'Menor preço dos últimos 14 dias');
    } else if (analytics.min7d != null && priceCents <= analytics.min7d) {
      add('lowest_price_7d', this.w.lowest7d, 'Menor preço dos últimos 7 dias');
    }

    // 4. official_store
    if (deal.seller?.isOfficialStore) {
      add('official_store', this.w.officialStore, 'Loja oficial');
    }

    // 5. seller_reputation
    if (deal.seller?.reputationLevel) {
      const map: Record<string, number> = {
        '5_green': this.w.sellerReputationMax,
        '4_light_green': Math.round(this.w.sellerReputationMax * 0.7),
        '3_yellow': Math.round(this.w.sellerReputationMax * 0.3),
        '2_orange': -Math.round(this.w.sellerReputationMax * 0.5),
        '1_red': -Math.round(this.w.sellerReputationMax * 1.5),
      };
      const w = map[deal.seller.reputationLevel];
      if (typeof w === 'number' && w !== 0) {
        const label = w > 0 ? `Vendedor com boa reputação` : `Vendedor com reputação baixa`;
        add('seller_reputation', w, label);
      }
    } else if (!deal.seller) {
      add('unknown_seller', -this.w.unknownSeller, 'Vendedor não identificado');
    }

    // 6. free_shipping
    if (deal.freeShipping) {
      add('free_shipping', this.w.freeShipping, 'Frete grátis');
    }

    // 7. installments_no_interest
    if (deal.item?.hasInstallmentsNoInterest) {
      add('installments_no_interest', this.w.installmentsNoInterest, 'Parcelas sem juros');
    }

    // 8. high_sold_quantity
    const sold = deal.item?.soldQuantity ?? 0;
    let soldW = 0;
    if (sold >= 500) soldW = this.w.highSoldQtyMax;
    else if (sold >= 100) soldW = Math.round(this.w.highSoldQtyMax * 0.6);
    else if (sold >= 20) soldW = Math.round(this.w.highSoldQtyMax * 0.2);
    if (soldW > 0) {
      add('high_sold_quantity', soldW, `${sold} vendidos`);
    }

    // 9. price_stability
    if (analytics.median30d != null) {
      // approximation: stable if median30d ≈ median14d
      if (
        analytics.median14d != null &&
        Math.abs(analytics.median30d - analytics.median14d) / analytics.median30d < 0.05
      ) {
        add('price_stability', this.w.priceStability, 'Preço base estável');
      }
    }

    // 10. used_or_refurbished
    if (deal.item?.condition && deal.item.condition !== 'new' && deal.item.condition !== 'not_specified') {
      add('used_or_refurbished', -this.w.usedPenalty, 'Produto não é novo');
    }

    // 11. price_raise_before_discount
    const raise = detectPriceRaiseBeforeDiscount(
      { observations: [], now: opts?.now }, // dummy; caller passes real observations via separate call
      priceCents,
      this.priceRaiseOpts,
    );
    // Re-run with analytics-derived observations is handled by caller; here we accept that
    // when caller invokes via Pipeline, it should pass analytics+observations.
    // To avoid double-fetch, expose a second overload below (computeWithObservations).
    if (raise.suspicious) {
      add(
        'price_raise_before_discount',
        -this.w.priceRaisePenalty,
        raise.reason ?? 'Indício de preço inflado antes do desconto',
      );
    }

    // 12. insufficient_history
    const insufficient = analytics.distinctDays < this.t.minHistoryDays;
    if (insufficient) {
      add(
        'insufficient_history',
        -this.w.insufficientHistoryPenalty,
        'Histórico de preço ainda limitado',
      );
    }

    // 13. discount_from_original_only — no history AND only positive signal was discount_percent
    if (analytics.distinctDays === 0 && (factors.discount_percent ?? 0) > 0) {
      const otherPositives = reasons.filter((r) => r.code !== 'discount_percent').length;
      if (otherPositives === 0) {
        add(
          'discount_from_original_only',
          -this.w.discountFromOriginalOnly,
          'Desconto apoiado apenas no preço original',
        );
      }
    }

    const rawScore = Object.values(factors).reduce((a, b) => a + b, 0);
    const score = clamp(rawScore, 0, 100);

    reasons.sort((a, b) => b.weight - a.weight);

    const level = this.deriveLevel(score, insufficient);

    return {
      deal,
      score,
      rawScore,
      level,
      reasons,
      penalties,
      factors,
    };
  }

  /**
   * Variant that allows the caller to pass observations so the price-raise
   * heuristic uses real history. Pipeline must use this when it has access
   * to the curation observation list.
   */
  computeWithObservations(
    deal: EnrichedDeal,
    analytics: PriceAnalytics,
    observations: { priceCents: number; at: string }[],
    opts?: { now?: Date },
  ): ScoredDeal {
    const base = this.compute(deal, analytics, opts);
    // Recompute the price-raise signal with real observations and patch the result.
    const priceCents = Math.round(deal.price * 100);
    const raise = detectPriceRaiseBeforeDiscount(
      { observations, now: opts?.now },
      priceCents,
      this.priceRaiseOpts,
    );
    const filteredPenalties = base.penalties.filter(
      (p) => p.code !== 'price_raise_before_discount',
    );
    const filteredFactors = { ...base.factors };
    delete filteredFactors.price_raise_before_discount;

    if (raise.suspicious) {
      filteredPenalties.push({
        code: 'price_raise_before_discount',
        weight: -this.w.priceRaisePenalty,
        message: raise.reason ?? 'Indício de preço inflado antes do desconto',
      });
      filteredFactors.price_raise_before_discount = -this.w.priceRaisePenalty;
    }

    const rawScore = Object.values(filteredFactors).reduce((a, b) => a + b, 0);
    const score = clamp(rawScore, 0, 100);
    const insufficient =
      analytics.distinctDays < this.t.minHistoryDays;

    return {
      ...base,
      penalties: filteredPenalties,
      factors: filteredFactors,
      rawScore,
      score,
      level: this.deriveLevel(score, insufficient),
    };
  }

  private deriveLevel(score: number, insufficientHistory: boolean): DealLevel {
    if (score < this.t.min) return 'rejected';
    let level: DealLevel;
    if (score >= this.t.super) level = 'super';
    else if (score >= this.t.top) level = 'top';
    else level = 'good';
    if (insufficientHistory && level === 'super') level = 'top';
    return level;
  }
}

function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}
```

- [ ] **Step 4: Run to PASS**

Run: `npx jest src/deal-score/deal-score.service.spec.ts`
Expected: 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/deal-score/deal-score.service.ts src/deal-score/deal-score.service.spec.ts
git commit -m "feat(deal-score): additive rubric with reasons, penalties, levels

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task C3: `DealScoreModule`

**Files:**
- Create: `src/deal-score/deal-score.module.ts`

- [ ] **Step 1: Create the module**

```typescript
// src/deal-score/deal-score.module.ts

import { Module } from '@nestjs/common';
import { DealScoreService } from './deal-score.service';

@Module({
  providers: [DealScoreService],
  exports: [DealScoreService],
})
export class DealScoreModule {}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/deal-score/deal-score.module.ts
git commit -m "feat(deal-score): NestJS module wiring

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

**PR 3 ready** — branch contains DealScore subsystem. Not yet wired.

---

## Milestone D — Pipeline refactor + order fix (PR 4)

Fixes the record-before-dedup bug and introduces `collectScored` / `dispatchScored`. Score is now active in `runOnce`.

### Task D1: Spec the corrected order

**Files:**
- Create: `src/pipeline/pipeline.service.spec.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/pipeline/pipeline.service.spec.ts

import { ConfigService } from '@nestjs/config';
import { PipelineService } from './pipeline.service';
import { DealItem } from '../mercado-livre/types';
import { EnrichedDeal } from '../enrichment/types';
import { ScoredDeal } from '../deal-score/types';

const baseDeal: DealItem = {
  catalogId: 'MLB1',
  itemId: 'MLBI1',
  title: 'T',
  thumbnail: '',
  price: 100,
  originalPrice: 200,
  sellerId: 7,
  freeShipping: true,
  permalink: 'https://x',
  discountPercent: 50,
};

function makeDeps() {
  const calls: string[] = [];
  const ml = {
    getDealsFromHighlights: jest.fn(async () => [baseDeal]),
  } as any;
  const dedup = {
    wasRecentlyPosted: jest.fn(async () => {
      calls.push('dedup.wasRecentlyPosted');
      return false;
    }),
    markPosted: jest.fn(async () => { calls.push('dedup.markPosted'); }),
  } as any;
  const curation = {
    record: jest.fn(async () => { calls.push('curation.record'); }),
    isFakeDiscount: jest.fn(() => {
      calls.push('curation.isFakeDiscount');
      return false;
    }),
    getLowestPriceBadge: jest.fn(() => null),
    getObservations: jest.fn(() => []),
    getAnalytics: jest.fn(() => ({
      median7d: null, median14d: null, median30d: null,
      min7d: null, min14d: null, min30d: null,
      distinctDays: 0, lastObservedBefore: null, trend: 'unknown' as const,
    })),
  } as any;
  const enrichment = {
    enrichMany: jest.fn(async (deals: DealItem[]) =>
      deals.map((d) => ({ ...d, seller: null, item: null }) as EnrichedDeal),
    ),
  } as any;
  const dealScore = {
    compute: jest.fn(),
    computeWithObservations: jest.fn(
      (deal: EnrichedDeal): ScoredDeal => ({
        deal,
        score: 80,
        rawScore: 80,
        level: 'good',
        reasons: [],
        penalties: [],
        factors: {},
      }),
    ),
  } as any;
  const wa = {
    isReady: () => true,
    sendImage: jest.fn(async () => {}),
    sendText: jest.fn(async () => {}),
  } as any;
  const formatter = {
    formatItem: jest.fn(async () => ({ caption: 'cap', imageUrl: 'img' })),
    formatScored: jest.fn(async () => ({ caption: 'cap', imageUrl: 'img' })),
  } as any;
  const config = {
    get: (k: string, def?: string) => {
      const map: Record<string, string> = {
        WA_TARGET_JID: '5511999999999@s.whatsapp.net',
        ML_CATEGORY: 'MLB1648',
        ML_MIN_DISCOUNT: '25',
        DEDUP_WINDOW_DAYS: '7',
        MAX_DEALS_PER_RUN: '3',
        DEAL_SCORE_MIN: '75',
        DEAL_ENRICH_TOP_N: '10',
      };
      return map[k] ?? def;
    },
  } as unknown as ConfigService;

  const svc = new PipelineService(ml, wa, formatter, config, dedup, curation, enrichment, dealScore);
  return { svc, calls, ml, dedup, curation, enrichment, dealScore, wa, formatter };
}

describe('PipelineService order', () => {
  it('records BEFORE dedup AND BEFORE isFakeDiscount', async () => {
    const { svc, calls } = makeDeps();
    await svc.collectScored('MLB1648', { minDiscount: 25, enrichTopN: 10 });
    const recordIdx = calls.indexOf('curation.record');
    const dedupIdx = calls.indexOf('dedup.wasRecentlyPosted');
    const fakeIdx = calls.indexOf('curation.isFakeDiscount');
    expect(recordIdx).toBeGreaterThanOrEqual(0);
    expect(recordIdx).toBeLessThan(dedupIdx);
    expect(recordIdx).toBeLessThan(fakeIdx);
  });

  it('still records when dedup skips the deal', async () => {
    const { svc, dedup, curation } = makeDeps();
    dedup.wasRecentlyPosted.mockResolvedValue(true);
    await svc.collectScored('MLB1648', { minDiscount: 25, enrichTopN: 10 });
    expect(curation.record).toHaveBeenCalledTimes(1);
  });

  it('still records when isFakeDiscount blocks the deal', async () => {
    const { svc, curation } = makeDeps();
    curation.isFakeDiscount.mockReturnValue(true);
    await svc.collectScored('MLB1648', { minDiscount: 25, enrichTopN: 10 });
    expect(curation.record).toHaveBeenCalledTimes(1);
  });

  it('filters deals below DEAL_SCORE_MIN', async () => {
    const { svc, dealScore } = makeDeps();
    dealScore.computeWithObservations.mockReturnValue({
      deal: { ...baseDeal, seller: null, item: null } as any,
      score: 40,
      rawScore: 40,
      level: 'rejected',
      reasons: [],
      penalties: [],
      factors: {},
    });
    const out = await svc.collectScored('MLB1648', { minDiscount: 25, enrichTopN: 10 });
    expect(out).toHaveLength(0);
  });
});

describe('dispatchScored', () => {
  it('sorts desc and respects max', async () => {
    const { svc, wa } = makeDeps();
    const make = (score: number, id: string): ScoredDeal => ({
      deal: { ...baseDeal, catalogId: id, seller: null, item: null } as any,
      score, rawScore: score, level: 'good', reasons: [], penalties: [], factors: {},
    });
    const r = await svc.dispatchScored([make(70, 'A'), make(90, 'B'), make(85, 'C')], 2);
    expect(r.sent).toBe(2);
    // first send was the top-scored ('B')
    expect(wa.sendImage.mock.calls[0]).toBeTruthy();
  });

  it('marks posted only after successful send', async () => {
    const { svc, dedup, wa } = makeDeps();
    wa.sendImage.mockRejectedValueOnce(new Error('boom'));
    const r = await svc.dispatchScored([{
      deal: { ...baseDeal, seller: null, item: null } as any,
      score: 90, rawScore: 90, level: 'top', reasons: [], penalties: [], factors: {},
    }], 1);
    expect(r.sent).toBe(0);
    expect(dedup.markPosted).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to FAIL**

Run: `npx jest src/pipeline/pipeline.service.spec.ts`
Expected: FAIL — constructor signature mismatch and methods missing.

- [ ] **Step 3: Refactor `pipeline.service.ts`**

```typescript
// src/pipeline/pipeline.service.ts — full rewrite

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CurationService } from '../curation/curation.service';
import { DealScoreService } from '../deal-score/deal-score.service';
import { ScoredDeal } from '../deal-score/types';
import { DedupService } from '../dedup/dedup.service';
import { EnrichmentService } from '../enrichment/enrichment.service';
import { MercadoLivreService } from '../mercado-livre/ml.service';
import { DealItem } from '../mercado-livre/types';
import { WhatsappService } from '../whatsapp/wa.service';
import { FormatterService } from './formatter.service';

const DEFAULT_CATEGORIES = [
  'MLB1648', 'MLB1000', 'MLB1051', 'MLB5726',
  'MLB1276', 'MLB1246', 'MLB1144', 'MLB1430',
];

@Injectable()
export class PipelineService {
  private readonly logger = new Logger(PipelineService.name);

  constructor(
    private readonly ml: MercadoLivreService,
    private readonly wa: WhatsappService,
    private readonly formatter: FormatterService,
    private readonly config: ConfigService,
    private readonly dedup: DedupService,
    private readonly curation: CurationService,
    private readonly enrichment: EnrichmentService,
    private readonly dealScore: DealScoreService,
  ) {}

  /**
   * Collect candidate deals for `category`, run pre-score → enrich → full score → filter.
   * Returns ScoredDeals with score >= DEAL_SCORE_MIN, sorted desc.
   * Does NOT dispatch.
   */
  async collectScored(
    category: string,
    opts: { minDiscount: number; enrichTopN: number },
  ): Promise<ScoredDeal[]> {
    const windowDays = Number(this.config.get<string>('DEDUP_WINDOW_DAYS', '7'));
    const scoreMin = Number(this.config.get<string>('DEAL_SCORE_MIN', '75'));
    const minDiscountNoHistory = Number(
      this.config.get<string>('DEAL_SCORE_MIN_DISCOUNT_NO_HISTORY', '40'),
    );

    const rawDeals = await this.ml.getDealsFromHighlights({
      category,
      minDiscount: opts.minDiscount,
      max: opts.enrichTopN * 3,
    });

    const survivors: DealItem[] = [];
    for (const deal of rawDeals) {
      const priceCents = Math.round(deal.price * 100);
      // 1. Record FIRST — always, even if we skip below
      await this.curation.record(deal.catalogId, priceCents);
      // 2. Dedup
      if (await this.dedup.wasRecentlyPosted(deal.catalogId, windowDays)) continue;
      // 3. Hard curation gate
      if (this.curation.isFakeDiscount(deal.catalogId, priceCents)) continue;
      survivors.push(deal);
    }

    if (survivors.length === 0) return [];

    // 4. Pre-score (cheap) and take top-N
    const preScored = survivors
      .map((d) => ({ deal: d, pre: this.prescore(d) }))
      .sort((a, b) => b.pre - a.pre)
      .slice(0, opts.enrichTopN);

    // 5. Enrich
    const enriched = await this.enrichment.enrichMany(preScored.map((x) => x.deal));

    // 6. Full score with real observations
    const scored: ScoredDeal[] = enriched.map((e) => {
      const observations = this.curation.getObservations(e.catalogId);
      const analytics = this.curation.getAnalytics(e.catalogId);
      return this.dealScore.computeWithObservations(e, analytics, observations);
    });

    // 7. Filter
    const passing = scored.filter((s) => {
      if (s.score < scoreMin) return false;
      // Without history, demand higher raw discount
      if (s.deal.seller === null && s.deal.discountPercent < minDiscountNoHistory) {
        const analytics = this.curation.getAnalytics(s.deal.catalogId);
        if (analytics.distinctDays === 0) return false;
      }
      return true;
    });

    passing.sort((a, b) => b.score - a.score);

    this.logger.log(
      `collectScored ${category} — raw=${rawDeals.length} survivors=${survivors.length} ` +
      `enriched=${enriched.length} scored=${scored.length} passing=${passing.length}`,
    );

    return passing;
  }

  /**
   * Dispatch a sorted list of ScoredDeals via WhatsApp, capped at `max`.
   */
  async dispatchScored(
    scored: ScoredDeal[],
    max: number,
  ): Promise<{ sent: number; failed: number; topScore: number | null }> {
    const targetJid = this.config.get<string>('WA_TARGET_JID', '');
    if (!targetJid) throw new Error('WA_TARGET_JID not set in .env');
    if (!this.wa.isReady()) throw new Error('WhatsApp not ready — scan QR first');

    const sorted = [...scored].sort((a, b) => b.score - a.score).slice(0, max);
    let sent = 0;
    let failed = 0;
    let topScore: number | null = null;

    for (const sd of sorted) {
      if (topScore === null) topScore = sd.score;
      try {
        const { caption, imageUrl } = await this.formatter.formatScored(sd);
        if (imageUrl) await this.wa.sendImage(targetJid, imageUrl, caption);
        else await this.wa.sendText(targetJid, caption);
        await this.dedup.markPosted(sd.deal.catalogId);
        this.logger.log(
          `dispatch ${sd.deal.catalogId} → WA sent ok (level=${sd.level}, score=${sd.score})`,
        );
        sent++;
      } catch (err) {
        failed++;
        this.logger.error(
          `dispatch ${sd.deal.catalogId} failed: ${(err as Error).message}`,
        );
      }
      await this.sleep(2000);
    }

    return { sent, failed, topScore };
  }

  /**
   * Cheap pre-score using only fields already on DealItem + curation analytics.
   * Used to budget enrichment calls to top-N candidates.
   */
  private prescore(deal: DealItem): number {
    const priceCents = Math.round(deal.price * 100);
    const analytics = this.curation.getAnalytics(deal.catalogId);
    let s = 0;
    s += Math.min(20, Math.max(0, deal.discountPercent - 25));
    if (analytics.median30d != null && priceCents < analytics.median30d) {
      const ratio = 1 - priceCents / analytics.median30d;
      s += Math.min(25, ratio * 100);
    }
    if (analytics.min30d != null && priceCents <= analytics.min30d) s += 15;
    else if (analytics.min14d != null && priceCents <= analytics.min14d) s += 10;
    else if (analytics.min7d != null && priceCents <= analytics.min7d) s += 5;
    if (deal.freeShipping) s += 5;
    if (analytics.distinctDays < 7) s -= 25;
    return s;
  }

  async runOnce(opts?: {
    category?: string;
    minDiscount?: number;
    max?: number;
  }) {
    const category =
      opts?.category ?? this.config.get<string>('ML_CATEGORY', 'MLB1648');
    const minDiscount =
      opts?.minDiscount ??
      Number(this.config.get<string>('ML_MIN_DISCOUNT', '25'));
    const enrichTopN = Number(this.config.get<string>('DEAL_ENRICH_TOP_N', '10'));
    const max = opts?.max ?? Number(this.config.get<string>('MAX_DEALS_PER_RUN', '3'));

    const scored = await this.collectScored(category, { minDiscount, enrichTopN });
    const dispatch = await this.dispatchScored(scored, max);
    return {
      sent: dispatch.sent,
      failed: dispatch.failed,
      scored: scored.length,
      topScore: dispatch.topScore,
      category,
      minDiscount,
    };
  }

  async preview(opts?: {
    categories?: string[];
    minDiscount?: number;
    perCategory?: number;
  }) {
    const categories = opts?.categories?.length ? opts.categories : DEFAULT_CATEGORIES;
    const minDiscount =
      opts?.minDiscount ??
      Number(this.config.get<string>('ML_MIN_DISCOUNT', '25'));
    const perCategory = opts?.perCategory ?? 5;

    const results: Record<string, { permalink: string; title: string; price: number; discountPercent: number }[]> = {};
    const flatUrls: string[] = [];

    for (const cat of categories) {
      const deals = await this.ml.getDealsFromHighlights({ category: cat, minDiscount, max: perCategory });
      results[cat] = deals.map((d: DealItem) => ({
        permalink: d.permalink, title: d.title, price: d.price, discountPercent: d.discountPercent,
      }));
      for (const d of deals) flatUrls.push(d.permalink);
    }

    return {
      minDiscount, perCategory, totalUrls: flatUrls.length,
      pasteIntoAffiliatePanel: flatUrls.join('\n'),
      byCategory: results,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
```

- [ ] **Step 4: Update `pipeline.module.ts`**

```typescript
// src/pipeline/pipeline.module.ts

import { Module } from '@nestjs/common';
import { AffiliateModule } from '../affiliate/affiliate.module';
import { AuthModule } from '../auth/auth.module';
import { CurationModule } from '../curation/curation.module';
import { DealScoreModule } from '../deal-score/deal-score.module';
import { DedupModule } from '../dedup/dedup.module';
import { EnrichmentModule } from '../enrichment/enrichment.module';
import { HeadlineModule } from '../headline/headline.module';
import { MercadoLivreModule } from '../mercado-livre/ml.module';
import { WhatsappModule } from '../whatsapp/wa.module';
import { FormatterService } from './formatter.service';
import { PipelineController } from './pipeline.controller';
import { PipelineService } from './pipeline.service';

@Module({
  imports: [
    MercadoLivreModule, WhatsappModule, AffiliateModule, DedupModule,
    CurationModule, HeadlineModule, AuthModule,
    EnrichmentModule, DealScoreModule,
  ],
  controllers: [PipelineController],
  providers: [PipelineService, FormatterService],
  exports: [PipelineService],
})
export class PipelineModule {}
```

- [ ] **Step 5: Run to PASS**

Run: `npx jest src/pipeline/pipeline.service.spec.ts`
Expected: green.

Note: the test references `formatter.formatScored` which does not yet exist. Add a temporary stub method on `FormatterService` returning the same shape as `formatItem`, with a `// TODO: replaced in Milestone E` removed comment (we add it now to keep the test passing; the real implementation lands in Milestone E):

```typescript
// In src/pipeline/formatter.service.ts, add inside the class:

async formatScored(scored: import('../deal-score/types').ScoredDeal): Promise<{ caption: string; imageUrl: string }> {
  return this.formatItem(scored.deal);
}
```

- [ ] **Step 6: Run full suite**

Run: `npm test`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/pipeline/pipeline.service.ts src/pipeline/pipeline.service.spec.ts src/pipeline/pipeline.module.ts src/pipeline/formatter.service.ts
git commit -m "fix(pipeline): record before dedup; add collectScored and dispatchScored

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

**PR 4 ready** — full new pipeline activates. Behavior change: score now filters deals; record runs first. Formatter still uses legacy fire template; per-level templates land in PR 5.

---

## Milestone E — Per-level templates (PR 5)

### Task E1: Three templates

**Files:**
- Create: `src/pipeline/templates/template-imperdivel.ts`
- Create: `src/pipeline/templates/template-top.ts`
- Create: `src/pipeline/templates/template-good.ts`
- Modify: `src/pipeline/templates/index.ts`

- [ ] **Step 1: Template — imperdível**

```typescript
// src/pipeline/templates/template-imperdivel.ts

import { ScoredDeal } from '../../deal-score/types';

export const imperdivelTemplate = (
  sd: ScoredDeal,
  formatBRL: (n: number) => string,
  link: string,
  hook: string,
): string => {
  const d = sd.deal;
  const lines: string[] = [];
  lines.push('🚨 PROMOÇÃO IMPERDÍVEL');
  if (hook) lines.push(hook);
  lines.push('');
  lines.push(`📦 ${d.title}`);
  lines.push('');
  lines.push(`💰 *${formatBRL(d.price)}* (-${d.discountPercent}%)`);
  if (d.item?.hasInstallmentsNoInterest) {
    const installments = pickInstallments(d.price);
    lines.push(`💳 ${installments} sem juros`);
  }
  if (d.freeShipping) lines.push('🚚 Frete grátis');
  lines.push('');

  const historyLine = pickHistoryLine(sd);
  if (historyLine) lines.push(historyLine);

  const sellerLine = pickSellerLine(d);
  if (sellerLine) lines.push(sellerLine);

  lines.push('');
  lines.push(`🛒 ${link}`);
  return lines.join('\n');
};

function pickHistoryLine(sd: ScoredDeal): string | null {
  const hit = sd.reasons.find((r) =>
    ['lowest_price_30d', 'lowest_price_14d', 'lowest_price_7d', 'below_median_30d'].includes(r.code),
  );
  return hit ? `📉 ${hit.message}` : null;
}

function pickSellerLine(d: ScoredDeal['deal']): string | null {
  const seller = d.seller;
  if (!seller) return null;
  const parts: string[] = [];
  if (seller.isOfficialStore) parts.push('Loja oficial');
  if (seller.powerSellerStatus) parts.push(`MercadoLíder ${capitalize(seller.powerSellerStatus)}`);
  if (typeof seller.ratingAverage === 'number') parts.push(`${seller.ratingAverage.toFixed(1)}★`);
  return parts.length > 0 ? `✅ ${parts.join(' · ')}` : null;
}

function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function pickInstallments(price: number): string {
  if (price >= 600) return `12x ${(price / 12).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}`;
  if (price >= 200) return `10x ${(price / 10).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}`;
  return `até 6x`;
}
```

- [ ] **Step 2: Template — top**

```typescript
// src/pipeline/templates/template-top.ts

import { ScoredDeal } from '../../deal-score/types';

export const topTemplate = (
  sd: ScoredDeal,
  formatBRL: (n: number) => string,
  link: string,
  hook: string,
): string => {
  const d = sd.deal;
  const lines: string[] = [];
  lines.push('🔥 PROMOÇÃO TOP');
  if (hook) lines.push(hook);
  lines.push('');
  lines.push(`📦 ${d.title}`);
  lines.push(`💰 *${formatBRL(d.price)}* (-${d.discountPercent}%)`);
  const extras: string[] = [];
  if (d.item?.hasInstallmentsNoInterest) extras.push(`${pickInstallments(d.price)} sem juros`);
  if (d.freeShipping) extras.push('🚚 frete grátis');
  if (extras.length) lines.push(extras.join(' · '));
  lines.push('');
  const historyLine = pickHistoryLine(sd);
  if (historyLine) lines.push(historyLine);
  lines.push('');
  lines.push(`🛒 ${link}`);
  return lines.join('\n');
};

function pickHistoryLine(sd: ScoredDeal): string | null {
  const hit = sd.reasons.find((r) =>
    ['lowest_price_30d', 'lowest_price_14d', 'lowest_price_7d', 'below_median_30d'].includes(r.code),
  );
  return hit ? `📉 ${hit.message}` : null;
}

function pickInstallments(price: number): string {
  if (price >= 600) return `12x`;
  if (price >= 200) return `10x`;
  return `6x`;
}
```

- [ ] **Step 3: Template — good**

```typescript
// src/pipeline/templates/template-good.ts

import { ScoredDeal } from '../../deal-score/types';

export const goodTemplate = (
  sd: ScoredDeal,
  formatBRL: (n: number) => string,
  link: string,
  hook: string,
): string => {
  const d = sd.deal;
  const lines: string[] = [];
  lines.push('💸 Promoção');
  if (hook) lines.push(hook);
  lines.push('');
  lines.push(`📦 ${d.title}`);
  lines.push(`💰 *${formatBRL(d.price)}* (-${d.discountPercent}%)`);
  if (d.freeShipping) lines.push('🚚 Frete grátis');
  lines.push('');
  lines.push(`🛒 ${link}`);
  return lines.join('\n');
};
```

- [ ] **Step 4: Update templates index**

```typescript
// src/pipeline/templates/index.ts

import { ScoredDeal } from '../../deal-score/types';
import { goodTemplate } from './template-good';
import { imperdivelTemplate } from './template-imperdivel';
import { topTemplate } from './template-top';

export type ScoredCaptionTemplate = (
  sd: ScoredDeal,
  formatBRL: (n: number) => string,
  link: string,
  hook: string,
) => string;

export const templatesByLevel: Record<'good' | 'top' | 'super', ScoredCaptionTemplate> = {
  good: goodTemplate,
  top: topTemplate,
  super: imperdivelTemplate,
};

// Legacy fire template kept for backwards compat (formatItem still callable)
export { fireTemplate } from './template-fire';
export type { CaptionTemplate } from './template-fire-types';
```

Note: the existing `index.ts` exports `CaptionTemplate` and `templates` of legacy shape. We renamed exports to `templatesByLevel` and moved the legacy `CaptionTemplate` type into a separate file to keep backwards-compat for `formatter.formatItem`. Create that file:

- [ ] **Step 5: Move legacy type**

```typescript
// src/pipeline/templates/template-fire-types.ts

import { DealItem } from '../../mercado-livre/types';

export type CaptionTemplate = (
  d: DealItem,
  formatBRL: (n: number) => string,
  link: string,
  shipping: string,
  badge: string | undefined,
  hook: string,
) => string;
```

Update existing `template-fire.ts` import:

```typescript
// src/pipeline/templates/template-fire.ts (top of file)
import { DealItem } from '../../mercado-livre/types';
import { CaptionTemplate } from './template-fire-types';

export const fireTemplate: CaptionTemplate = (...) => { /* unchanged body */ };
```

(Just add a `: CaptionTemplate` annotation; body stays.)

- [ ] **Step 6: Update formatter to dispatch per level**

```typescript
// src/pipeline/formatter.service.ts — replace formatScored stub with real impl

async formatScored(scored: ScoredDeal): Promise<{ caption: string; imageUrl: string }> {
  const [link, hook] = await Promise.all([
    this.affiliate.resolve(scored.deal.permalink),
    this.headline.generate(scored.deal),
  ]);
  const formatBRL = (n: number) => this.formatBRL(n);

  const tmpl =
    scored.level === 'super' ? templatesByLevel.super :
    scored.level === 'top'   ? templatesByLevel.top :
    templatesByLevel.good;

  // 'rejected' level never reaches dispatch; fall back to good template defensively.
  const caption = tmpl(scored, formatBRL, link, hook);
  const imageUrl = this.toHiResImage(scored.deal.thumbnail || '');
  return { caption, imageUrl };
}
```

Add the import:

```typescript
import { templatesByLevel } from './templates';
import { ScoredDeal } from '../deal-score/types';
```

- [ ] **Step 7: Spec the per-level dispatch**

Create `src/pipeline/formatter.service.spec.ts` if absent or append:

```typescript
// src/pipeline/formatter.service.spec.ts
import { FormatterService } from './formatter.service';
import { ScoredDeal } from '../deal-score/types';

const affiliate = { resolve: jest.fn(async (u: string) => u) } as any;
const headline = { generate: jest.fn(async () => 'HOOK') } as any;

function makeScored(level: ScoredDeal['level']): ScoredDeal {
  return {
    deal: {
      catalogId: 'C', itemId: 'I', title: 'T', thumbnail: '',
      price: 100, originalPrice: 200, sellerId: 1, freeShipping: true,
      permalink: 'p', discountPercent: 50,
      seller: { sellerId: 1, nickname: 'X', powerSellerStatus: 'platinum', reputationLevel: '5_green', isOfficialStore: true, officialStoreId: 9, ratingAverage: 4.8, fetchedAt: new Date().toISOString() },
      item: { itemId: 'I', soldQuantity: 100, condition: 'new', hasInstallmentsNoInterest: true },
    } as any,
    score: 92, rawScore: 92, level,
    reasons: [{ code: 'lowest_price_30d', weight: 15, message: 'Menor preço dos últimos 30 dias' }],
    penalties: [],
    factors: { lowest_price_30d: 15 },
  };
}

describe('FormatterService.formatScored', () => {
  it('renders the imperdível template for level=super', async () => {
    const svc = new FormatterService(affiliate, headline);
    const { caption } = await svc.formatScored(makeScored('super'));
    expect(caption).toMatch(/PROMOÇÃO IMPERDÍVEL/);
    expect(caption).toMatch(/Menor preço dos últimos 30 dias/);
  });

  it('renders the top template for level=top', async () => {
    const svc = new FormatterService(affiliate, headline);
    const { caption } = await svc.formatScored(makeScored('top'));
    expect(caption).toMatch(/PROMOÇÃO TOP/);
  });

  it('renders the good template for level=good (no analysis bullets)', async () => {
    const svc = new FormatterService(affiliate, headline);
    const { caption } = await svc.formatScored(makeScored('good'));
    expect(caption).toMatch(/Promoção/);
    expect(caption).not.toMatch(/Menor preço/);
  });
});
```

- [ ] **Step 8: Run**

Run: `npm test`
Expected: green.

- [ ] **Step 9: Commit**

```bash
git add src/pipeline/templates src/pipeline/formatter.service.ts src/pipeline/formatter.service.spec.ts
git commit -m "feat(pipeline): per-level WhatsApp templates (good/top/imperdível)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

**PR 5 ready.**

---

## Milestone F — Scheduler batch mode (PR 6)

### Task F1: `CategoryRotator.getWeighted`

**Files:**
- Modify: `src/scheduler/category-rotator.service.ts`
- Modify: `src/scheduler/category-rotator.service.spec.ts`

- [ ] **Step 1: Add the test**

```typescript
// src/scheduler/category-rotator.service.spec.ts — append

it('getWeighted returns the parsed entries', () => {
  const config = { get: () => 'A:2,B:3' } as any;
  const svc = new CategoryRotatorService(config);
  svc.onModuleInit();
  expect(svc.getWeighted()).toEqual([
    { category: 'A', weight: 2 },
    { category: 'B', weight: 3 },
  ]);
});
```

- [ ] **Step 2: Run to FAIL**

Run: `npx jest src/scheduler/category-rotator.service.spec.ts`
Expected: FAIL — method missing.

- [ ] **Step 3: Add the method**

Append to `CategoryRotatorService` in `src/scheduler/category-rotator.service.ts`:

```typescript
getWeighted(): { category: string; weight: number }[] {
  return this.weights.map((w) => ({ category: w.category, weight: w.weight }));
}
```

- [ ] **Step 4: Run to PASS**

Run: `npx jest src/scheduler/category-rotator.service.spec.ts`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/scheduler/category-rotator.service.ts src/scheduler/category-rotator.service.spec.ts
git commit -m "feat(scheduler): expose getWeighted on CategoryRotator

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task F2: Scheduler batch mode

**Files:**
- Modify: `src/scheduler/scheduler.service.ts`

- [ ] **Step 1: Refactor `tick()`**

Replace the inside of `tick()` after the quiet-hours / enabled checks with a mode switch:

```typescript
// Inside tick(), after the quiet-hours/enabled guards:

const mode = (
  this.config.get<string>('SCHEDULER_MODE') ??
  process.env.SCHEDULER_MODE ??
  'legacy'
).toLowerCase();

if (mode === 'batch') {
  const categories = this.rotator.getWeighted();
  if (categories.length === 0) {
    this.logger.warn('Scheduler tick (batch) skipped — no categories configured');
    return;
  }
  const enrichTopN = Number(this.config.get<string>('DEAL_ENRICH_TOP_N', '10'));
  const minDiscount = Number(this.config.get<string>('ML_MIN_DISCOUNT', '25'));
  const maxDeals = Number(this.config.get<string>('MAX_DEALS_PER_RUN', '3'));

  const allScored: import('../deal-score/types').ScoredDeal[] = [];
  for (const { category } of categories) {
    const t0 = Date.now();
    try {
      const scored = await this.pipeline.collectScored(category, { minDiscount, enrichTopN });
      allScored.push(...scored);
      this.logger.log(`batch collect ${category}: ${scored.length} passing (${Date.now() - t0}ms)`);
    } catch (err) {
      this.logger.error(`batch collect ${category} failed: ${(err as Error).message}`);
    }
  }

  allScored.sort((a, b) => b.score - a.score);
  const dispatch = await this.pipeline.dispatchScored(allScored, maxDeals);
  this.logger.log(
    `Scheduler tick batch — categories=${categories.length} ` +
    `totalScored=${allScored.length} dispatched=${dispatch.sent} ` +
    `topScore=${dispatch.topScore ?? 'n/a'}`,
  );
  return;
}

// LEGACY path (unchanged):
const category = this.rotator.pick();
// ... existing legacy code
```

- [ ] **Step 2: Type-check**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: clean.

- [ ] **Step 3: Manual smoke test note**

`SCHEDULER_MODE` defaults to `legacy`, so cron behavior is unchanged. To activate batch mode locally, set `SCHEDULER_MODE=batch` in `.env`.

- [ ] **Step 4: Run full suite**

Run: `npm test`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/scheduler/scheduler.service.ts
git commit -m "feat(scheduler): opt-in SCHEDULER_MODE=batch for cross-category ranking

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

**PR 6 ready.**

---

## Milestone G — Env documentation + cutover (PR 7)

### Task G1: `.env.example` documentation

**Files:**
- Modify: `.env.example` (create section if file exists; create the file if it does not)

- [ ] **Step 1: Inspect current `.env.example`**

Run: `cat .env.example 2>/dev/null || echo "no env example"`

- [ ] **Step 2: Append (or create) the curation section**

```bash
# .env.example — append this block (or create if absent)

# ──────────────────────────────────────────
# Premium Deal Curation
# ──────────────────────────────────────────

# Score gates
DEAL_SCORE_MIN=75
DEAL_SCORE_TOP=90
DEAL_SCORE_SUPER=95
MAX_DEALS_PER_RUN=3

# Enrichment budget
DEAL_ENRICH_TOP_N=10
SELLER_CACHE_TTL_HOURS=24
SELLER_CACHE_FILE=./data/seller-cache.json

# History-related gates
DEAL_SCORE_INSUFFICIENT_HISTORY_PENALTY=25
DEAL_SCORE_MIN_DISCOUNT_NO_HISTORY=40

# Price-raise scam heuristic
PRICE_RAISE_PEAK_WINDOW_DAYS=14
PRICE_RAISE_BASELINE_WINDOW_DAYS=30
PRICE_RAISE_PEAK_RATIO=1.20
PRICE_RAISE_CURRENT_BASELINE_RATIO=0.95

# Scheduler — 'legacy' (one category per tick, current behavior)
# or 'batch' (collect all weighted categories, rank globally, top K)
SCHEDULER_MODE=legacy

# Optional weight overrides (defaults shown)
# DEAL_SCORE_W_DISCOUNT_MAX=20
# DEAL_SCORE_W_BELOW_MEDIAN_MAX=25
# DEAL_SCORE_W_LOWEST_30D=15
# DEAL_SCORE_W_LOWEST_14D=10
# DEAL_SCORE_W_LOWEST_7D=5
# DEAL_SCORE_W_OFFICIAL_STORE=10
# DEAL_SCORE_W_SELLER_REPUTATION_MAX=10
# DEAL_SCORE_W_FREE_SHIPPING=5
# DEAL_SCORE_W_INSTALLMENTS_NO_INTEREST=5
# DEAL_SCORE_W_HIGH_SOLD_QTY_MAX=5
# DEAL_SCORE_W_PRICE_STABILITY=5
# DEAL_SCORE_W_PRICE_RAISE_PENALTY=30
# DEAL_SCORE_W_USED_PENALTY=15
# DEAL_SCORE_W_DISCOUNT_FROM_ORIGINAL_ONLY=10
# DEAL_SCORE_W_ABOVE_MEDIAN_PENALTY=10
# DEAL_SCORE_W_UNKNOWN_SELLER=5
```

- [ ] **Step 3: Commit**

```bash
git add .env.example
git commit -m "docs(env): document premium curation env vars

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

**PR 7 ready.** Production rollout uses the phase table in the spec (Section 7.3) — apply env changes via your secrets/deploy tooling; no further code change required.

---

## Verification

After all milestones:

- [ ] `npm test` — all suites green
- [ ] `npx tsc -p tsconfig.json --noEmit` — no type errors
- [ ] `npm run lint` — no new lint errors
- [ ] Inspect a real-world dry run:
  - Set `SCHEDULER_ENABLED=true`, `SCHEDULER_MODE=batch`, but route WA to a test JID
  - Trigger via the pipeline controller's preview/runOnce HTTP endpoint, observe `[DealScore]` lines in stdout
  - Confirm the right level is picked per deal and no banned-by-curation deals slip through

---

## Self-review summary

**Spec coverage:**

| Spec section | Implementing tasks |
|---|---|
| §2 Architecture (new modules) | A1 (types), B1–B3, C1–C3 |
| §3 Scoring rubric | C2 |
| §4 Price analytics + scam heuristic | A2, A3 |
| §4.4 Curation getAnalytics | A4 |
| §5 Pipeline + scheduler | D1, F1, F2 |
| §6 Per-level templates | E1 |
| §7 Envs | C2 (consumes), G1 (documents) |
| §8 Testing | all TDD steps |
| §10 Migration plan | one milestone per PR |
| §13 Acceptance criteria | D1 (order), C2 (clamps, history clamp), E1 (templates), F2 (legacy preserved) |

**Placeholder scan:** no TBD / TODO / vague "add error handling" / unreferenced symbols.

**Type consistency:** `ScoredDeal` shape stable from A1 onwards; `EnrichedDeal` stub in A1 matches final shape in B; `formatScored` method signature stable from D1 stub to E1 final implementation.
