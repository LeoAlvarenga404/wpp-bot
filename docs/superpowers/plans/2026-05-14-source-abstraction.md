# Source Abstraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract a `DealSourcePort` seam between the pipeline and Mercado Livre, refactor ML as the reference adapter, and normalize the enriched-deal model so additional sources (Shopee, Amazon, …) can land as single-file plug-ins without touching pipeline/scheduler/score.

**Architecture:** Add a new `src/sources/` module with the `DealSourcePort` interface, a `SourceRegistry` for DI-based collection, and an `MLSource` facade that composes the existing `MercadoLivreService` and `EnrichmentService` into the port. Pipeline and scheduler switch from concrete ML calls to the registry. Stores (`price-history.json`, `posted-log.json`) gain idempotent boot-time key-prefix migrations.

**Tech Stack:** TypeScript, NestJS 11, Jest 30 + ts-jest, file-backed JSON stores (atomic tmp+rename), existing Sentry & Prom-client wiring.

**Spec:** `docs/superpowers/specs/2026-05-14-source-abstraction-design.md`

---

## File Map

### New files

```
src/sources/
  source.port.ts                          # SourceId, ProductKey, RawDeal,
                                          # NormalizedSeller, EnrichedDeal,
                                          # DealSourcePort, SOURCES_TOKEN,
                                          # keyToString, parseKey
  source.port.spec.ts
  source-registry.service.ts              # SourceRegistry
  source-registry.service.spec.ts
  sources.module.ts                       # global module exposing registry
  mercado-livre/
    ml-source.service.ts                  # implements DealSourcePort
    ml-source.service.spec.ts
    ml-source.module.ts
    feed-rotator.service.ts               # MOVED from scheduler/
    feed-rotator.service.spec.ts          # MOVED from scheduler/
    mapping.ts                            # pure mapper fns (ML → normalized)
    mapping.spec.ts
  __fixtures__/
    raw-deal-ml.ts
    enriched-deal-ml-normalized.ts
    normalized-seller-high.ts
    normalized-seller-low.ts
    normalized-seller-unknown.ts
```

### Modified files

```
src/app.module.ts                         # +SourcesModule
src/pipeline/pipeline.service.ts          # collectScored(sourceId),
                                          # collectScoredOne(sourceId),
                                          # collectAllScored(),
                                          # runOnce(opts.sourceId)
src/pipeline/pipeline.service.spec.ts     # rewrite — uses fake DealSourcePort
src/pipeline/pipeline.module.ts           # drop direct ML/Enrichment imports,
                                          # +SourcesModule
src/pipeline/pipeline.controller.ts       # runOnce(sourceId) instead of category
src/pipeline/formatter.service.ts         # accept normalized EnrichedDeal
src/pipeline/formatter.service.spec.ts    # update fixtures
src/pipeline/templates/template-good.ts
src/pipeline/templates/template-top.ts
src/pipeline/templates/template-imperdivel.ts
src/pipeline/templates/legacy.ts          # accept normalized shape
src/scheduler/scheduler.service.ts        # tickBatch iterates registry;
                                          # tickLegacy picks sourceId + calls
                                          # collectScoredOne
src/scheduler/scheduler.module.ts         # drop CategoryRotator, drop ML import
src/scheduler/category-rotator.service.ts # DELETED (moved to ml-source)
src/scheduler/category-rotator.service.spec.ts  # DELETED
src/deal-score/deal-score.service.ts      # consume normalized EnrichedDeal
src/deal-score/deal-score.service.spec.ts # update fixtures
src/deal-score/__fixtures__/enriched-deal-official-store.ts  # DELETED (replaced)
src/deal-score/__fixtures__/enriched-deal-unknown-seller.ts  # DELETED (replaced)
src/curation/curation.service.ts          # +boot migration: ml: prefix
src/curation/curation.service.spec.ts     # +migration test
src/dedup/dedup.service.ts                # +boot migration: ml: prefix +
                                          # backup-once on first migrate
src/dedup/dedup.service.spec.ts           # CREATE — covers migration
.env.example                              # +SOURCES_ENABLED,
                                          # +SOURCES_MIGRATION_BACKUP
```

---

## Conventions

- **Branch:** `feat/source-abstraction` (single branch). Each milestone is one logical PR per the spec's §13 PR boundary, but tasks commit incrementally on the same branch and we cherry-pick PR boundaries at the end.
- **PR boundary (3 PRs):**
  - PR1 = M1 + M2 + M3 (contracts + adapter + rename; unused seam, no behavior change)
  - PR2 = M4 + M5 + M6 + M7 (rewire pipeline/scheduler/score/templates + store migrations)
  - PR3 = M8 (env docs + cutover)
- **Commit format:** Conventional commits, e.g. `feat(sources): add DealSourcePort interface`. Use the exact message provided per task.
- **Tests:** `npx jest <path>` for single, `npm test` for full. Type-check: `npx tsc -p tsconfig.json --noEmit`.
- **Stub-then-spec discipline:** never write the implementation before the failing test for the same step.
- **Money:** `priceCents: number` integers internally. Reais → cents at API boundary (`Math.round(deal.price * 100)`).
- **Score parity:** pre- and post-refactor scores for identical inputs must match within ±1 point. M6 includes the parity spec.

---

## Milestone M1 — Contracts + registry (PR 1 part 1)

### Task M1.1: Port types and helpers

**Files:**
- Create: `src/sources/source.port.ts`
- Create: `src/sources/source.port.spec.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/sources/source.port.spec.ts

import { keyToString, parseKey, ProductKey } from './source.port';

describe('source.port helpers', () => {
  it('keyToString joins source and externalId with a colon', () => {
    expect(keyToString({ source: 'ml', externalId: 'MLB1234' })).toBe('ml:MLB1234');
  });

  it('parseKey splits on the first colon only', () => {
    const k = parseKey('ml:weird:id:with:colons');
    expect(k).toEqual<ProductKey>({ source: 'ml', externalId: 'weird:id:with:colons' });
  });

  it('parseKey returns null for empty input', () => {
    expect(parseKey('')).toBeNull();
  });

  it('parseKey returns null when no colon present', () => {
    expect(parseKey('MLB1234')).toBeNull();
  });

  it('parseKey returns null when externalId is empty', () => {
    expect(parseKey('ml:')).toBeNull();
  });

  it('parseKey returns null when source segment is empty', () => {
    expect(parseKey(':MLB1234')).toBeNull();
  });

  it('round-trips keyToString → parseKey', () => {
    const original: ProductKey = { source: 'ml', externalId: 'MLB1234' };
    const parsed = parseKey(keyToString(original));
    expect(parsed).toEqual(original);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/sources/source.port.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the port + helpers**

```typescript
// src/sources/source.port.ts

export type SourceId = 'ml';

export interface ProductKey {
  source: SourceId;
  externalId: string;
}

export interface RawDeal {
  key: ProductKey;
  title: string;
  priceCents: number;
  originalPriceCents: number | null;
  discountPercent: number;
  thumbnail: string;
  permalink: string;
  feedId: string;
  condition?: 'new' | 'used' | 'refurbished';
}

export interface NormalizedSeller {
  externalSellerId: string;
  displayName: string | null;
  sellerTrust: 'high' | 'medium' | 'low' | 'unknown';
  isVerifiedStore: boolean;
  ratingAverage: number | null;
  fetchedAt: string;
}

export interface EnrichedDeal {
  key: ProductKey;
  source: SourceId;
  raw: RawDeal;
  seller: NormalizedSeller | null;
  condition: 'new' | 'used' | 'refurbished' | 'unknown';
  signals: {
    freeShipping: boolean;
    installmentsNoInterest: boolean;
    volumeTier: 'high' | 'mid' | 'low' | 'none';
    isVerifiedStore: boolean;
  };
  extras: Record<string, unknown>;
}

export interface DealSourcePort {
  readonly id: SourceId;
  discover(): Promise<RawDeal[]>;
  discoverOne(): Promise<RawDeal[]>;
  enrichMany(raws: RawDeal[]): Promise<EnrichedDeal[]>;
  ping?(): Promise<{ ok: boolean; message?: string }>;
}

export const SOURCES_TOKEN = Symbol('SOURCES_TOKEN');

export function keyToString(k: ProductKey): string {
  return `${k.source}:${k.externalId}`;
}

export function parseKey(s: string): ProductKey | null {
  if (!s) return null;
  const idx = s.indexOf(':');
  if (idx <= 0) return null;
  const source = s.slice(0, idx);
  const externalId = s.slice(idx + 1);
  if (!externalId) return null;
  return { source: source as SourceId, externalId };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/sources/source.port.spec.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Type-check**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: clean (no use sites yet).

- [ ] **Step 6: Commit**

```bash
git add src/sources/source.port.ts src/sources/source.port.spec.ts
git commit -m "feat(sources): add DealSourcePort interface + key helpers

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task M1.2: SourceRegistry

**Files:**
- Create: `src/sources/source-registry.service.ts`
- Create: `src/sources/source-registry.service.spec.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/sources/source-registry.service.spec.ts

import { SourceRegistry } from './source-registry.service';
import type { DealSourcePort, RawDeal, EnrichedDeal } from './source.port';

function makeFake(id: 'ml'): DealSourcePort {
  return {
    id,
    discover: async (): Promise<RawDeal[]> => [],
    discoverOne: async (): Promise<RawDeal[]> => [],
    enrichMany: async (): Promise<EnrichedDeal[]> => [],
  };
}

describe('SourceRegistry', () => {
  it('getAll returns the injected sources in order', () => {
    const ml = makeFake('ml');
    const reg = new SourceRegistry([ml]);
    expect(reg.getAll()).toEqual([ml]);
  });

  it('getById returns the source with matching id', () => {
    const ml = makeFake('ml');
    const reg = new SourceRegistry([ml]);
    expect(reg.getById('ml')).toBe(ml);
  });

  it('getById throws when id is not registered', () => {
    const reg = new SourceRegistry([]);
    expect(() => reg.getById('ml')).toThrow(/Unknown source id: ml/);
  });

  it('handles empty registry without crashing', () => {
    const reg = new SourceRegistry([]);
    expect(reg.getAll()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/sources/source-registry.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the registry**

```typescript
// src/sources/source-registry.service.ts

import { Inject, Injectable } from '@nestjs/common';
import {
  DealSourcePort,
  SOURCES_TOKEN,
  SourceId,
} from './source.port';

@Injectable()
export class SourceRegistry {
  constructor(
    @Inject(SOURCES_TOKEN) private readonly sources: DealSourcePort[],
  ) {}

  getAll(): DealSourcePort[] {
    return this.sources;
  }

  getById(id: SourceId): DealSourcePort {
    const found = this.sources.find((s) => s.id === id);
    if (!found) throw new Error(`Unknown source id: ${id}`);
    return found;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/sources/source-registry.service.spec.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/sources/source-registry.service.ts src/sources/source-registry.service.spec.ts
git commit -m "feat(sources): add SourceRegistry collecting DealSourcePort via DI

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task M1.3: SourcesModule shell

**Files:**
- Create: `src/sources/sources.module.ts`

- [ ] **Step 1: Write the module (no spec — module wiring covered by integration test in M2)**

```typescript
// src/sources/sources.module.ts

import { Global, Module } from '@nestjs/common';
import { SOURCES_TOKEN } from './source.port';
import { SourceRegistry } from './source-registry.service';

@Global()
@Module({
  providers: [
    {
      provide: SOURCES_TOKEN,
      useFactory: () => [],
    },
    SourceRegistry,
  ],
  exports: [SourceRegistry],
})
export class SourcesModule {}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: clean.

- [ ] **Step 3: Wire into AppModule**

Modify `src/app.module.ts` — add import:

```typescript
import { SourcesModule } from './sources/sources.module';
```

And add `SourcesModule` to the `imports` array (after `SharedLoggerModule`, before `MercadoLivreModule`). Final imports block:

```typescript
imports: [
  ConfigModule.forRoot({ isGlobal: true }),
  SharedLoggerModule,
  SourcesModule,
  MercadoLivreModule,
  WhatsappModule,
  AffiliateModule,
  DedupModule,
  PipelineModule,
  SchedulerModule,
  MetricsModule,
],
```

- [ ] **Step 4: Type-check + full suite**

Run: `npx tsc -p tsconfig.json --noEmit` (clean)
Run: `npm test` (95 existing + 11 new from M1 = 106 pass)

- [ ] **Step 5: Commit**

```bash
git add src/sources/sources.module.ts src/app.module.ts
git commit -m "feat(sources): register SourcesModule globally with empty registry

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Milestone M2 — MLSource adapter (PR 1 part 2)

### Task M2.1: Pure mapping module (ML → normalized)

**Files:**
- Create: `src/sources/mercado-livre/mapping.ts`
- Create: `src/sources/mercado-livre/mapping.spec.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/sources/mercado-livre/mapping.spec.ts

import {
  mapSellerTrust,
  mapVolumeTier,
  mapCondition,
  toNormalizedSeller,
  toRawDeal,
  toEnrichedDeal,
} from './mapping';
import type { SellerInfo, ItemDetails } from '../../enrichment/types';
import type { DealItem } from '../../mercado-livre/types';

describe('mapSellerTrust', () => {
  it.each([
    ['5_green', 'high'],
    ['4_light_green', 'high'],
    ['3_yellow', 'medium'],
    ['2_orange', 'low'],
    ['1_red', 'low'],
    [null, 'unknown'],
    ['unexpected', 'unknown'],
  ])('maps %p to %p', (input, expected) => {
    expect(mapSellerTrust(input as string | null)).toBe(expected);
  });
});

describe('mapVolumeTier', () => {
  it.each([
    [null, 'none'],
    [0, 'none'],
    [19, 'none'],
    [20, 'low'],
    [99, 'low'],
    [100, 'mid'],
    [499, 'mid'],
    [500, 'high'],
    [10000, 'high'],
  ])('maps sold=%p to %p', (sold, expected) => {
    expect(mapVolumeTier(sold as number | null)).toBe(expected);
  });
});

describe('mapCondition', () => {
  it.each([
    ['new', 'new'],
    ['used', 'used'],
    ['refurbished', 'refurbished'],
    ['not_specified', 'unknown'],
    [null, 'unknown'],
    [undefined, 'unknown'],
  ])('maps %p to %p', (input, expected) => {
    expect(mapCondition(input as any)).toBe(expected);
  });
});

describe('toNormalizedSeller', () => {
  it('maps a 5_green official store correctly', () => {
    const ml: SellerInfo = {
      sellerId: 42,
      nickname: 'BIG STORE',
      powerSellerStatus: 'platinum',
      reputationLevel: '5_green',
      isOfficialStore: true,
      officialStoreId: 99,
      ratingAverage: 4.5,
      fetchedAt: '2026-05-14T00:00:00.000Z',
    };
    const out = toNormalizedSeller(ml);
    expect(out).toEqual({
      externalSellerId: '42',
      displayName: 'BIG STORE',
      sellerTrust: 'high',
      isVerifiedStore: true,
      ratingAverage: 0.9,    // 4.5 / 5
      fetchedAt: '2026-05-14T00:00:00.000Z',
    });
  });

  it('returns null-rating when missing', () => {
    const ml: SellerInfo = {
      sellerId: 7,
      nickname: null,
      powerSellerStatus: null,
      reputationLevel: null,
      isOfficialStore: false,
      officialStoreId: null,
      ratingAverage: null,
      fetchedAt: '2026-05-14T00:00:00.000Z',
    };
    expect(toNormalizedSeller(ml).ratingAverage).toBeNull();
    expect(toNormalizedSeller(ml).sellerTrust).toBe('unknown');
  });
});

describe('toRawDeal', () => {
  it('maps a DealItem to a RawDeal with ml: source key', () => {
    const d: DealItem = {
      catalogId: 'MLB123',
      itemId: 'MLBI1',
      title: 'iPhone',
      thumbnail: 'http://img/x.jpg',
      price: 4999.9,
      originalPrice: 9999.9,
      sellerId: 7,
      freeShipping: true,
      permalink: 'https://x',
      discountPercent: 50,
    };
    const out = toRawDeal(d, 'MLB1648');
    expect(out).toEqual({
      key: { source: 'ml', externalId: 'MLB123' },
      title: 'iPhone',
      priceCents: 499990,
      originalPriceCents: 999990,
      discountPercent: 50,
      thumbnail: 'http://img/x.jpg',
      permalink: 'https://x',
      feedId: 'MLB1648',
    });
  });
});

describe('toEnrichedDeal', () => {
  it('composes RawDeal + ML seller/item into normalized EnrichedDeal', () => {
    const raw = toRawDeal(
      {
        catalogId: 'MLB1',
        itemId: 'MLBI1',
        title: 'X',
        thumbnail: '',
        price: 100,
        originalPrice: 200,
        sellerId: 7,
        freeShipping: true,
        permalink: 'p',
        discountPercent: 50,
      },
      'MLB1648',
    );
    const seller: SellerInfo = {
      sellerId: 7,
      nickname: 'S',
      powerSellerStatus: 'gold',
      reputationLevel: '5_green',
      isOfficialStore: true,
      officialStoreId: 99,
      ratingAverage: 5,
      fetchedAt: '2026-05-14T00:00:00.000Z',
    };
    const item: ItemDetails = {
      itemId: 'MLBI1',
      soldQuantity: 250,
      condition: 'new',
      hasInstallmentsNoInterest: true,
    };

    const out = toEnrichedDeal(raw, seller, item);

    expect(out.key).toEqual({ source: 'ml', externalId: 'MLB1' });
    expect(out.source).toBe('ml');
    expect(out.seller?.sellerTrust).toBe('high');
    expect(out.seller?.isVerifiedStore).toBe(true);
    expect(out.condition).toBe('new');
    expect(out.signals).toEqual({
      freeShipping: true,
      installmentsNoInterest: true,
      volumeTier: 'mid',
      isVerifiedStore: true,
    });
    expect(out.extras).toMatchObject({
      powerSellerStatus: 'gold',
      reputationLevel: '5_green',
      officialStoreId: 99,
      soldQuantity: 250,
      catalogId: 'MLB1',
      itemId: 'MLBI1',
    });
  });

  it('handles null seller and null item gracefully', () => {
    const raw = toRawDeal(
      {
        catalogId: 'MLB1',
        itemId: 'MLBI1',
        title: 'X',
        thumbnail: '',
        price: 100,
        originalPrice: 200,
        sellerId: 7,
        freeShipping: false,
        permalink: 'p',
        discountPercent: 50,
      },
      'MLB1648',
    );
    const out = toEnrichedDeal(raw, null, null);
    expect(out.seller).toBeNull();
    expect(out.condition).toBe('unknown');
    expect(out.signals).toEqual({
      freeShipping: false,
      installmentsNoInterest: false,
      volumeTier: 'none',
      isVerifiedStore: false,
    });
    expect(out.extras.soldQuantity).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/sources/mercado-livre/mapping.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the mapping module**

```typescript
// src/sources/mercado-livre/mapping.ts

import type { DealItem } from '../../mercado-livre/types';
import type { ItemDetails, SellerInfo } from '../../enrichment/types';
import type {
  EnrichedDeal,
  NormalizedSeller,
  RawDeal,
} from '../source.port';

export function mapSellerTrust(
  reputationLevel: string | null,
): 'high' | 'medium' | 'low' | 'unknown' {
  switch (reputationLevel) {
    case '5_green':
    case '4_light_green':
      return 'high';
    case '3_yellow':
      return 'medium';
    case '2_orange':
    case '1_red':
      return 'low';
    default:
      return 'unknown';
  }
}

export function mapVolumeTier(
  sold: number | null,
): 'high' | 'mid' | 'low' | 'none' {
  if (sold == null) return 'none';
  if (sold >= 500) return 'high';
  if (sold >= 100) return 'mid';
  if (sold >= 20) return 'low';
  return 'none';
}

export function mapCondition(
  c: 'new' | 'used' | 'refurbished' | 'not_specified' | null | undefined,
): 'new' | 'used' | 'refurbished' | 'unknown' {
  if (c === 'new' || c === 'used' || c === 'refurbished') return c;
  return 'unknown';
}

export function toNormalizedSeller(s: SellerInfo): NormalizedSeller {
  return {
    externalSellerId: String(s.sellerId),
    displayName: s.nickname,
    sellerTrust: mapSellerTrust(s.reputationLevel),
    isVerifiedStore: s.isOfficialStore,
    ratingAverage: s.ratingAverage == null ? null : s.ratingAverage / 5,
    fetchedAt: s.fetchedAt,
  };
}

export function toRawDeal(d: DealItem, feedId: string): RawDeal {
  return {
    key: { source: 'ml', externalId: d.catalogId },
    title: d.title,
    priceCents: Math.round(d.price * 100),
    originalPriceCents: d.originalPrice
      ? Math.round(d.originalPrice * 100)
      : null,
    discountPercent: d.discountPercent,
    thumbnail: d.thumbnail,
    permalink: d.permalink,
    feedId,
  };
}

export function toEnrichedDeal(
  raw: RawDeal,
  seller: SellerInfo | null,
  item: ItemDetails | null,
): EnrichedDeal {
  const normalizedSeller = seller ? toNormalizedSeller(seller) : null;
  const condition = mapCondition(item?.condition);
  const installmentsNoInterest = !!item?.hasInstallmentsNoInterest;
  const volumeTier = mapVolumeTier(item?.soldQuantity ?? null);
  const isVerifiedStore = !!seller?.isOfficialStore;

  return {
    key: raw.key,
    source: 'ml',
    raw,
    seller: normalizedSeller,
    condition,
    signals: {
      freeShipping: false,        // populated below from raw
      installmentsNoInterest,
      volumeTier,
      isVerifiedStore,
    },
    extras: {
      powerSellerStatus: seller?.powerSellerStatus ?? null,
      reputationLevel: seller?.reputationLevel ?? null,
      officialStoreId: seller?.officialStoreId ?? null,
      soldQuantity: item?.soldQuantity ?? null,
      catalogId: raw.key.externalId,
      itemId: item?.itemId ?? null,
    },
    // freeShipping comes from raw — we don't yet expose raw.freeShipping;
    // RawDeal does not have a freeShipping field directly. It is implicit
    // in the original DealItem; pass it via the raw deal builder caller.
  } as EnrichedDeal;
}
```

> Note: `toEnrichedDeal` needs `freeShipping` from the original `DealItem`, but `RawDeal` does not carry it. We add it as a parameter so the mapping stays pure.

Revise the function signature:

```typescript
export function toEnrichedDeal(
  raw: RawDeal,
  seller: SellerInfo | null,
  item: ItemDetails | null,
  freeShipping: boolean,
): EnrichedDeal {
  const normalizedSeller = seller ? toNormalizedSeller(seller) : null;
  const condition = mapCondition(item?.condition);
  const installmentsNoInterest = !!item?.hasInstallmentsNoInterest;
  const volumeTier = mapVolumeTier(item?.soldQuantity ?? null);
  const isVerifiedStore = !!seller?.isOfficialStore;

  return {
    key: raw.key,
    source: 'ml',
    raw,
    seller: normalizedSeller,
    condition,
    signals: {
      freeShipping,
      installmentsNoInterest,
      volumeTier,
      isVerifiedStore,
    },
    extras: {
      powerSellerStatus: seller?.powerSellerStatus ?? null,
      reputationLevel: seller?.reputationLevel ?? null,
      officialStoreId: seller?.officialStoreId ?? null,
      soldQuantity: item?.soldQuantity ?? null,
      catalogId: raw.key.externalId,
      itemId: item?.itemId ?? null,
    },
  };
}
```

Update the spec to pass `freeShipping`:

```typescript
// In the spec, both toEnrichedDeal calls — update to pass freeShipping arg:
const out = toEnrichedDeal(raw, seller, item, true);
// and
const out = toEnrichedDeal(raw, null, null, false);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/sources/mercado-livre/mapping.spec.ts`
Expected: PASS, ~25 cases.

- [ ] **Step 5: Commit**

```bash
git add src/sources/mercado-livre/mapping.ts src/sources/mercado-livre/mapping.spec.ts
git commit -m "feat(sources): pure ML→normalized mapping module

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task M2.2: Fixtures

**Files:**
- Create: `src/sources/__fixtures__/raw-deal-ml.ts`
- Create: `src/sources/__fixtures__/enriched-deal-ml-normalized.ts`
- Create: `src/sources/__fixtures__/normalized-seller-high.ts`
- Create: `src/sources/__fixtures__/normalized-seller-low.ts`
- Create: `src/sources/__fixtures__/normalized-seller-unknown.ts`

- [ ] **Step 1: Write fixtures**

```typescript
// src/sources/__fixtures__/normalized-seller-high.ts

import type { NormalizedSeller } from '../source.port';

export const sellerHigh: NormalizedSeller = {
  externalSellerId: '42',
  displayName: 'TOP STORE',
  sellerTrust: 'high',
  isVerifiedStore: true,
  ratingAverage: 0.94,
  fetchedAt: '2026-05-14T00:00:00.000Z',
};
```

```typescript
// src/sources/__fixtures__/normalized-seller-low.ts

import type { NormalizedSeller } from '../source.port';

export const sellerLow: NormalizedSeller = {
  externalSellerId: '99',
  displayName: 'sketchy',
  sellerTrust: 'low',
  isVerifiedStore: false,
  ratingAverage: 0.5,
  fetchedAt: '2026-05-14T00:00:00.000Z',
};
```

```typescript
// src/sources/__fixtures__/normalized-seller-unknown.ts

import type { NormalizedSeller } from '../source.port';

export const sellerUnknown: NormalizedSeller = {
  externalSellerId: '0',
  displayName: null,
  sellerTrust: 'unknown',
  isVerifiedStore: false,
  ratingAverage: null,
  fetchedAt: '2026-05-14T00:00:00.000Z',
};
```

```typescript
// src/sources/__fixtures__/raw-deal-ml.ts

import type { RawDeal } from '../source.port';

export const rawDealMl: RawDeal = {
  key: { source: 'ml', externalId: 'MLB1234' },
  title: 'iPhone 15 Pro',
  priceCents: 599900,
  originalPriceCents: 999900,
  discountPercent: 40,
  thumbnail: 'https://http2.mlstatic.com/D_x.jpg',
  permalink: 'https://www.mercadolivre.com.br/p/MLB1234',
  feedId: 'MLB1648',
};
```

```typescript
// src/sources/__fixtures__/enriched-deal-ml-normalized.ts

import type { EnrichedDeal } from '../source.port';
import { rawDealMl } from './raw-deal-ml';
import { sellerHigh } from './normalized-seller-high';

export const enrichedDealMlNormalized: EnrichedDeal = {
  key: { source: 'ml', externalId: 'MLB1234' },
  source: 'ml',
  raw: rawDealMl,
  seller: sellerHigh,
  condition: 'new',
  signals: {
    freeShipping: true,
    installmentsNoInterest: true,
    volumeTier: 'mid',
    isVerifiedStore: true,
  },
  extras: {
    powerSellerStatus: 'platinum',
    reputationLevel: '5_green',
    officialStoreId: 99,
    soldQuantity: 250,
    catalogId: 'MLB1234',
    itemId: 'MLBI1234',
  },
};
```

- [ ] **Step 2: Type-check**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/sources/__fixtures__/
git commit -m "test(sources): fixtures for raw/enriched deal and normalized sellers

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task M2.3: MLSource.discover() + discoverOne() with internal feed rotator

**Files:**
- Create: `src/sources/mercado-livre/feed-rotator.service.ts` (copy of `src/scheduler/category-rotator.service.ts`, renamed)
- Create: `src/sources/mercado-livre/feed-rotator.service.spec.ts` (copy of the existing spec, renamed)
- Create: `src/sources/mercado-livre/ml-source.service.ts`
- Create: `src/sources/mercado-livre/ml-source.service.spec.ts`

- [ ] **Step 1: Copy the rotator (no behavior change; rename class + persist file)**

```typescript
// src/sources/mercado-livre/feed-rotator.service.ts

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';

interface WeightedFeed {
  feedId: string;
  weight: number;
}

interface PersistedState {
  lastFeedId: string | null;
  updatedAt: string;
}

const DEFAULT_WEIGHTS = 'MLB1648:3,MLB1000:2,MLB1051:2,MLB1276:1';
const STATE_FILE = path.join(process.cwd(), 'data', 'ml-last-feed.json');
const LEGACY_STATE_FILE = path.join(
  process.cwd(),
  'data',
  'last-category.json',
);

@Injectable()
export class FeedRotatorService implements OnModuleInit {
  private readonly logger = new Logger(FeedRotatorService.name);
  private weights: WeightedFeed[] = [];
  private lastFeedId: string | null = null;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    this.weights = this.parseWeights(
      this.config.get<string>('CATEGORY_WEIGHTS', DEFAULT_WEIGHTS) ??
        DEFAULT_WEIGHTS,
    );
    this.maybeMigrateLegacyState();
    this.loadState();
    this.logger.log(
      `Loaded ${this.weights.length} weighted feed(s); last=${this.lastFeedId ?? 'none'}`,
    );
  }

  parseWeights(raw: string): WeightedFeed[] {
    const out: WeightedFeed[] = [];
    if (!raw || !raw.trim()) return out;
    for (const chunk of raw.split(',')) {
      const trimmed = chunk.trim();
      if (!trimmed) continue;
      const [feedId, w] = trimmed.split(':').map((s) => s.trim());
      if (!feedId) continue;
      const weight = Number(w);
      if (!Number.isFinite(weight) || weight <= 0) continue;
      out.push({ feedId, weight });
    }
    return out;
  }

  pick(): string | null {
    if (this.weights.length === 0) return null;
    if (this.weights.length === 1) {
      const only = this.weights[0].feedId;
      this.persist(only);
      return only;
    }

    const candidates =
      this.lastFeedId !== null
        ? this.weights.filter((w) => w.feedId !== this.lastFeedId)
        : this.weights;

    const pool = candidates.length > 0 ? candidates : this.weights;
    const total = pool.reduce((s, w) => s + w.weight, 0);
    let roll = Math.random() * total;
    let chosen = pool[pool.length - 1].feedId;
    for (const w of pool) {
      roll -= w.weight;
      if (roll <= 0) {
        chosen = w.feedId;
        break;
      }
    }

    this.persist(chosen);
    return chosen;
  }

  getLast(): string | null {
    return this.lastFeedId;
  }

  getWeighted(): { feedId: string; weight: number }[] {
    return this.weights.map((w) => ({ feedId: w.feedId, weight: w.weight }));
  }

  private persist(feedId: string): void {
    this.lastFeedId = feedId;
    try {
      const dir = path.dirname(STATE_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const payload: PersistedState = {
        lastFeedId: feedId,
        updatedAt: new Date().toISOString(),
      };
      fs.writeFileSync(STATE_FILE, JSON.stringify(payload, null, 2), 'utf8');
    } catch (err) {
      this.logger.warn(
        `Failed to persist last feed: ${(err as Error).message}`,
      );
    }
  }

  private loadState(): void {
    try {
      if (!fs.existsSync(STATE_FILE)) return;
      const raw = fs.readFileSync(STATE_FILE, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PersistedState> & {
        lastCategory?: string;
      };
      if (parsed && typeof parsed.lastFeedId === 'string') {
        this.lastFeedId = parsed.lastFeedId;
      } else if (parsed && typeof parsed.lastCategory === 'string') {
        this.lastFeedId = parsed.lastCategory;
      }
    } catch (err) {
      this.logger.warn(
        `Failed to load last feed state: ${(err as Error).message}`,
      );
    }
  }

  private maybeMigrateLegacyState(): void {
    try {
      if (fs.existsSync(STATE_FILE)) return;
      if (!fs.existsSync(LEGACY_STATE_FILE)) return;
      const raw = fs.readFileSync(LEGACY_STATE_FILE, 'utf8');
      const parsed = JSON.parse(raw) as { lastCategory?: string };
      if (parsed && typeof parsed.lastCategory === 'string') {
        const payload: PersistedState = {
          lastFeedId: parsed.lastCategory,
          updatedAt: new Date().toISOString(),
        };
        const dir = path.dirname(STATE_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(STATE_FILE, JSON.stringify(payload, null, 2), 'utf8');
        this.logger.log(
          `Migrated last-category.json → ml-last-feed.json (lastFeedId=${parsed.lastCategory})`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `Legacy state migration failed: ${(err as Error).message}`,
      );
    }
  }
}
```

```typescript
// src/sources/mercado-livre/feed-rotator.service.spec.ts

import { ConfigService } from '@nestjs/config';
import { FeedRotatorService } from './feed-rotator.service';

function makeService(weights?: string): FeedRotatorService {
  const config = {
    get: (key: string, def?: string) => {
      if (key === 'CATEGORY_WEIGHTS') return weights ?? def;
      return def;
    },
  } as unknown as ConfigService;
  const svc = new FeedRotatorService(config);
  svc.onModuleInit();
  return svc;
}

describe('FeedRotatorService', () => {
  it('parseWeights handles well-formed input', () => {
    const svc = makeService('A:2,B:3');
    expect(svc.getWeighted()).toEqual([
      { feedId: 'A', weight: 2 },
      { feedId: 'B', weight: 3 },
    ]);
  });

  it('parseWeights drops malformed entries', () => {
    const svc = makeService('A:2, :3 ,B:abc,C:4');
    expect(svc.getWeighted()).toEqual([
      { feedId: 'A', weight: 2 },
      { feedId: 'C', weight: 4 },
    ]);
  });

  it('pick() returns null on empty weights', () => {
    const svc = makeService('');
    expect(svc.pick()).toBeNull();
  });

  it('pick() never repeats when more than one feed is configured', () => {
    const svc = makeService('A:1,B:1,C:1');
    const first = svc.pick()!;
    const second = svc.pick()!;
    expect(second).not.toBe(first);
  });

  it('getWeighted returns the parsed entries', () => {
    const svc = makeService('A:2,B:3');
    expect(svc.getWeighted()).toEqual([
      { feedId: 'A', weight: 2 },
      { feedId: 'B', weight: 3 },
    ]);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npx jest src/sources/mercado-livre/feed-rotator.service.spec.ts`
Expected: PASS, 5 tests.

- [ ] **Step 3: Write the failing MLSource test**

```typescript
// src/sources/mercado-livre/ml-source.service.spec.ts

import { MLSource } from './ml-source.service';
import type { MercadoLivreService } from '../../mercado-livre/ml.service';
import type { EnrichmentService } from '../../enrichment/enrichment.service';
import type { FeedRotatorService } from './feed-rotator.service';
import type { DealItem } from '../../mercado-livre/types';
import type { EnrichedDeal as MLEnriched } from '../../enrichment/types';

function makeMlDeal(id: string): DealItem {
  return {
    catalogId: id,
    itemId: 'I_' + id,
    title: 'T',
    thumbnail: '',
    price: 100,
    originalPrice: 200,
    sellerId: 7,
    freeShipping: true,
    permalink: 'p',
    discountPercent: 50,
  };
}

function makeDeps(opts: { feeds: { feedId: string; weight: number }[] }) {
  const ml = {
    getDealsFromHighlights: jest.fn(async ({ category }: { category: string }) => [
      makeMlDeal(`${category}_DEAL`),
    ]),
  } as unknown as MercadoLivreService;
  const enrichment = {
    enrichMany: jest.fn(async (deals: DealItem[]): Promise<MLEnriched[]> =>
      deals.map((d) => ({
        ...d,
        seller: {
          sellerId: d.sellerId,
          nickname: 's',
          powerSellerStatus: 'gold',
          reputationLevel: '5_green',
          isOfficialStore: false,
          officialStoreId: null,
          ratingAverage: 4.5,
          fetchedAt: '2026-05-14T00:00:00.000Z',
        },
        item: {
          itemId: d.itemId,
          soldQuantity: 50,
          condition: 'new',
          hasInstallmentsNoInterest: true,
        },
      })),
    ),
  } as unknown as EnrichmentService;
  const rotator = {
    getWeighted: jest.fn(() => opts.feeds),
    pick: jest.fn(() => opts.feeds[0]?.feedId ?? null),
  } as unknown as FeedRotatorService;
  return { ml, enrichment, rotator };
}

describe('MLSource', () => {
  it('id is "ml"', () => {
    const deps = makeDeps({ feeds: [] });
    const src = new MLSource(deps.ml, deps.enrichment, deps.rotator, {
      minDiscount: 25,
      maxPerFeed: 10,
    });
    expect(src.id).toBe('ml');
  });

  it('discover() fans out across all weighted feeds', async () => {
    const deps = makeDeps({
      feeds: [
        { feedId: 'MLB1648', weight: 1 },
        { feedId: 'MLB1000', weight: 1 },
      ],
    });
    const src = new MLSource(deps.ml, deps.enrichment, deps.rotator, {
      minDiscount: 25,
      maxPerFeed: 5,
    });
    const raws = await src.discover();
    expect(raws).toHaveLength(2);
    expect(raws.map((r) => r.feedId).sort()).toEqual(['MLB1000', 'MLB1648']);
    expect(raws.every((r) => r.key.source === 'ml')).toBe(true);
  });

  it('discoverOne() uses rotator pick and queries only that feed', async () => {
    const deps = makeDeps({
      feeds: [
        { feedId: 'MLB1648', weight: 1 },
        { feedId: 'MLB1000', weight: 1 },
      ],
    });
    const src = new MLSource(deps.ml, deps.enrichment, deps.rotator, {
      minDiscount: 25,
      maxPerFeed: 5,
    });
    const raws = await src.discoverOne();
    expect(raws).toHaveLength(1);
    expect(raws[0].feedId).toBe('MLB1648');
    expect(deps.ml.getDealsFromHighlights).toHaveBeenCalledTimes(1);
  });

  it('discover() isolates failures per feed', async () => {
    const deps = makeDeps({
      feeds: [
        { feedId: 'MLB1648', weight: 1 },
        { feedId: 'BROKEN', weight: 1 },
      ],
    });
    (deps.ml.getDealsFromHighlights as jest.Mock).mockImplementation(
      async ({ category }: { category: string }) => {
        if (category === 'BROKEN') throw new Error('boom');
        return [makeMlDeal(`${category}_DEAL`)];
      },
    );
    const src = new MLSource(deps.ml, deps.enrichment, deps.rotator, {
      minDiscount: 25,
      maxPerFeed: 5,
    });
    const raws = await src.discover();
    expect(raws).toHaveLength(1);
    expect(raws[0].feedId).toBe('MLB1648');
  });

  it('enrichMany() maps ML enriched into normalized EnrichedDeal', async () => {
    const deps = makeDeps({ feeds: [] });
    const src = new MLSource(deps.ml, deps.enrichment, deps.rotator, {
      minDiscount: 25,
      maxPerFeed: 5,
    });
    const raw = {
      key: { source: 'ml' as const, externalId: 'MLB1' },
      title: 'T',
      priceCents: 10000,
      originalPriceCents: 20000,
      discountPercent: 50,
      thumbnail: '',
      permalink: 'p',
      feedId: 'MLB1648',
    };
    const out = await src.enrichMany([raw]);
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe('ml');
    expect(out[0].seller?.sellerTrust).toBe('high');
    expect(out[0].condition).toBe('new');
    expect(out[0].signals.volumeTier).toBe('low'); // sold=50 → low
    expect(out[0].signals.installmentsNoInterest).toBe(true);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx jest src/sources/mercado-livre/ml-source.service.spec.ts`
Expected: FAIL — `MLSource` not exported.

- [ ] **Step 5: Write the MLSource implementation**

> Design note: the pure mapper `toRawDeal` drops `sellerId`/`itemId`/`freeShipping`, which `EnrichmentService` still needs. We keep an internal `Map<externalId, DealItem>` populated by `discover()`/`discoverOne()` so `enrichMany()` can recover the original `DealItem`. The port stays clean (no ML-only fields leak), and the cache is invalidated each discovery call.

```typescript
// src/sources/mercado-livre/ml-source.service.ts

import { Inject, Injectable, Logger } from '@nestjs/common';
import { EnrichmentService } from '../../enrichment/enrichment.service';
import { MercadoLivreService } from '../../mercado-livre/ml.service';
import type { DealItem } from '../../mercado-livre/types';
import {
  DealSourcePort,
  EnrichedDeal,
  RawDeal,
} from '../source.port';
import { FeedRotatorService } from './feed-rotator.service';
import { toEnrichedDeal, toRawDeal } from './mapping';

interface MLSourceOpts {
  minDiscount: number;
  maxPerFeed: number;
}

export const ML_SOURCE_OPTS = Symbol('ML_SOURCE_OPTS');

@Injectable()
export class MLSource implements DealSourcePort {
  readonly id = 'ml' as const;
  private readonly logger = new Logger(MLSource.name);
  private readonly rawIndex = new Map<string, DealItem>();

  constructor(
    private readonly ml: MercadoLivreService,
    private readonly enrichment: EnrichmentService,
    private readonly rotator: FeedRotatorService,
    @Inject(ML_SOURCE_OPTS) private readonly opts: MLSourceOpts,
  ) {}

  async discover(): Promise<RawDeal[]> {
    const feeds = this.rotator.getWeighted();
    const all: RawDeal[] = [];
    this.rawIndex.clear();
    for (const { feedId } of feeds) {
      try {
        const deals = await this.ml.getDealsFromHighlights({
          category: feedId,
          minDiscount: this.opts.minDiscount,
          max: this.opts.maxPerFeed,
        });
        for (const d of deals) {
          const raw = toRawDeal(d, feedId);
          this.rawIndex.set(raw.key.externalId, d);
          all.push(raw);
        }
      } catch (err) {
        this.logger.warn(
          `MLSource discover feed=${feedId} failed: ${(err as Error).message}`,
        );
      }
    }
    return all;
  }

  async discoverOne(): Promise<RawDeal[]> {
    const feedId = this.rotator.pick();
    if (!feedId) return [];
    this.rawIndex.clear();
    try {
      const deals = await this.ml.getDealsFromHighlights({
        category: feedId,
        minDiscount: this.opts.minDiscount,
        max: this.opts.maxPerFeed,
      });
      const raws: RawDeal[] = [];
      for (const d of deals) {
        const raw = toRawDeal(d, feedId);
        this.rawIndex.set(raw.key.externalId, d);
        raws.push(raw);
      }
      return raws;
    } catch (err) {
      this.logger.warn(
        `MLSource discoverOne feed=${feedId} failed: ${(err as Error).message}`,
      );
      return [];
    }
  }

  async enrichMany(raws: RawDeal[]): Promise<EnrichedDeal[]> {
    const dealItems: DealItem[] = raws.map((r) => {
      const cached = this.rawIndex.get(r.key.externalId);
      if (cached) return cached;
      // Defensive fallback when caller passes a RawDeal we did not produce.
      return this.fallbackDealItem(r);
    });
    const enrichedML = await this.enrichment.enrichMany(dealItems);
    return enrichedML.map((e, i) =>
      toEnrichedDeal(raws[i], e.seller, e.item, dealItems[i].freeShipping),
    );
  }

  private fallbackDealItem(r: RawDeal): DealItem {
    return {
      catalogId: r.key.externalId,
      itemId: '',
      title: r.title,
      thumbnail: r.thumbnail,
      price: r.priceCents / 100,
      originalPrice: (r.originalPriceCents ?? 0) / 100,
      sellerId: 0,
      freeShipping: false,
      permalink: r.permalink,
      discountPercent: r.discountPercent,
    };
  }
}
```

- [ ] **Step 6: Run tests**

Run: `npx jest src/sources/mercado-livre/ml-source.service.spec.ts`
Expected: PASS, 5 tests.

- [ ] **Step 7: Commit**

```bash
git add src/sources/mercado-livre/feed-rotator.service.ts \
        src/sources/mercado-livre/feed-rotator.service.spec.ts \
        src/sources/mercado-livre/ml-source.service.ts \
        src/sources/mercado-livre/ml-source.service.spec.ts
git commit -m "feat(sources): MLSource adapter + feed rotator

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task M2.4: MLSourceModule wires registry registration

**Files:**
- Create: `src/sources/mercado-livre/ml-source.module.ts`
- Modify: `src/sources/sources.module.ts`

- [ ] **Step 1: Write the module**

```typescript
// src/sources/mercado-livre/ml-source.module.ts

import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EnrichmentModule } from '../../enrichment/enrichment.module';
import { MercadoLivreModule } from '../../mercado-livre/ml.module';
import { ML_SOURCE_OPTS, MLSource } from './ml-source.service';
import { FeedRotatorService } from './feed-rotator.service';

@Module({
  imports: [ConfigModule, MercadoLivreModule, EnrichmentModule],
  providers: [
    FeedRotatorService,
    {
      provide: ML_SOURCE_OPTS,
      useFactory: (config: ConfigService) => ({
        minDiscount: Number(config.get<string>('ML_MIN_DISCOUNT', '25')),
        maxPerFeed: Number(config.get<string>('DEAL_ENRICH_TOP_N', '10')) * 3,
      }),
      inject: [ConfigService],
    },
    MLSource,
  ],
  exports: [MLSource, FeedRotatorService],
})
export class MLSourceModule {}
```

- [ ] **Step 2: Wire MLSource into SourcesModule registry**

Replace `src/sources/sources.module.ts`:

```typescript
// src/sources/sources.module.ts

import { Global, Module } from '@nestjs/common';
import { MLSourceModule } from './mercado-livre/ml-source.module';
import { MLSource } from './mercado-livre/ml-source.service';
import { SOURCES_TOKEN } from './source.port';
import { SourceRegistry } from './source-registry.service';

@Global()
@Module({
  imports: [MLSourceModule],
  providers: [
    {
      provide: SOURCES_TOKEN,
      useFactory: (ml: MLSource) => [ml],
      inject: [MLSource],
    },
    SourceRegistry,
  ],
  exports: [SourceRegistry, MLSourceModule],
})
export class SourcesModule {}
```

- [ ] **Step 3: Type-check + full suite**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: clean.
Run: `npm test`
Expected: 95 existing + new M1/M2 specs pass.

- [ ] **Step 4: Commit**

```bash
git add src/sources/mercado-livre/ml-source.module.ts src/sources/sources.module.ts
git commit -m "feat(sources): register MLSource in SourcesModule registry

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Milestone M3 — Remove old category rotator (PR 1 part 3)

### Task M3.1: Delete old `CategoryRotatorService` from scheduler

**Files:**
- Delete: `src/scheduler/category-rotator.service.ts`
- Delete: `src/scheduler/category-rotator.service.spec.ts`
- Modify: `src/scheduler/scheduler.module.ts`

- [ ] **Step 1: Delete the old service**

```bash
git rm src/scheduler/category-rotator.service.ts src/scheduler/category-rotator.service.spec.ts
```

- [ ] **Step 2: Update SchedulerModule**

Replace `src/scheduler/scheduler.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { MercadoLivreModule } from '../mercado-livre/ml.module';
import { PipelineModule } from '../pipeline/pipeline.module';
import { SchedulerService } from './scheduler.service';
import { TokenRefresherService } from './token-refresher.service';

@Module({
  imports: [ScheduleModule.forRoot(), PipelineModule, MercadoLivreModule],
  providers: [SchedulerService, TokenRefresherService],
  exports: [SchedulerService, TokenRefresherService],
})
export class SchedulerModule {}
```

- [ ] **Step 3: Update SchedulerService to remove the now-broken `CategoryRotatorService` import**

> Note: `SchedulerService` still references `CategoryRotatorService` until M4. To keep the build green at this point, we temporarily inject `FeedRotatorService` from the sources module as a shim.

Modify `src/scheduler/scheduler.service.ts`:

Replace:
```typescript
import { CategoryRotatorService } from './category-rotator.service';
```
with:
```typescript
import { FeedRotatorService } from '../sources/mercado-livre/feed-rotator.service';
```

Replace all `CategoryRotatorService` occurrences with `FeedRotatorService`. Replace `this.rotator.pick()` return type (still `string | null`). Replace `this.rotator.getWeighted()` calls: the return shape changed from `{category, weight}[]` to `{feedId, weight}[]`. Update the destructuring in `tickBatch`:

```typescript
// before:
for (const { category } of categories) { ... pipeline.collectScored(category, ...) ... }
// after:
for (const { feedId } of categories) { ... pipeline.collectScored(feedId, ...) ... }
```

> This is a temporary shim — M4 deletes the scheduler-side iteration entirely.

Also update `src/scheduler/scheduler.module.ts` to include `SourcesModule` for the rotator dependency. But `SourcesModule` is `@Global()`, so import is implicit. Confirm no extra changes needed.

- [ ] **Step 4: Type-check + tests**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: clean.
Run: `npm test`
Expected: all green (scheduler specs still work because behavior is preserved through the shim).

- [ ] **Step 5: Commit**

```bash
git add src/scheduler/scheduler.module.ts src/scheduler/scheduler.service.ts
git commit -m "refactor(scheduler): drop CategoryRotator; shim via FeedRotator from sources

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

**PR 1 ready** (M1+M2+M3 — contracts + adapter + rename + unused seam wired).

---

## Milestone M4 — Pipeline + scheduler rewire (PR 2 part 1)

### Task M4.1: PipelineService.collectScored(sourceId)

**Files:**
- Modify: `src/pipeline/pipeline.service.ts`
- Modify: `src/pipeline/pipeline.service.spec.ts`

- [ ] **Step 1: Write the failing test**

Replace `src/pipeline/pipeline.service.spec.ts` (full rewrite):

```typescript
// src/pipeline/pipeline.service.spec.ts

jest.mock('@whiskeysockets/baileys', () => ({}));
jest.mock('@hapi/boom', () => ({ Boom: class Boom {} }));
jest.mock('@sentry/node', () => ({ captureException: jest.fn(), init: jest.fn() }));
jest.mock('../whatsapp/wa.service');

import { ConfigService } from '@nestjs/config';
import { PipelineService } from './pipeline.service';
import type { DealSourcePort, RawDeal, EnrichedDeal } from '../sources/source.port';
import type { ScoredDeal } from '../deal-score/types';

function rawFor(id: string, priceCents = 10000): RawDeal {
  return {
    key: { source: 'ml', externalId: id },
    title: 'T',
    priceCents,
    originalPriceCents: priceCents * 2,
    discountPercent: 50,
    thumbnail: '',
    permalink: 'p',
    feedId: 'MLB1648',
  };
}

function enrichedFor(raw: RawDeal): EnrichedDeal {
  return {
    key: raw.key,
    source: 'ml',
    raw,
    seller: {
      externalSellerId: '1',
      displayName: 'S',
      sellerTrust: 'high',
      isVerifiedStore: false,
      ratingAverage: 0.9,
      fetchedAt: '2026-05-14T00:00:00.000Z',
    },
    condition: 'new',
    signals: {
      freeShipping: true,
      installmentsNoInterest: false,
      volumeTier: 'low',
      isVerifiedStore: false,
    },
    extras: {},
  };
}

function makeDeps(opts: { rawDeals: RawDeal[]; failingId?: string }) {
  const fakeSource: DealSourcePort = {
    id: 'ml',
    discover: jest.fn(async () => opts.rawDeals),
    discoverOne: jest.fn(async () => opts.rawDeals.slice(0, 1)),
    enrichMany: jest.fn(async (rs: RawDeal[]) => rs.map(enrichedFor)),
  };
  const registry = {
    getById: jest.fn((id: string) => {
      if (id === 'ml') return fakeSource;
      throw new Error('Unknown');
    }),
    getAll: jest.fn(() => [fakeSource]),
  } as any;

  const ml = { getDealsFromHighlights: jest.fn() } as any; // unused — kept for legacy DI
  const wa = { isReady: () => true, sendImage: jest.fn(), sendText: jest.fn() } as any;
  const formatter = {
    formatScored: jest.fn(async () => ({ caption: 'cap', imageUrl: '' })),
  } as any;
  const dedup = {
    wasRecentlyPosted: jest.fn(async (key: string) => key.endsWith(opts.failingId ?? '')),
    markPosted: jest.fn(async () => undefined),
  } as any;
  const curation = {
    record: jest.fn(async () => undefined),
    isFakeDiscount: jest.fn(() => false),
    getAnalytics: jest.fn(() => ({
      median7d: null,
      median14d: null,
      median30d: null,
      min7d: null,
      min14d: null,
      min30d: null,
      distinctDays: 10,
    })),
    getObservations: jest.fn(() => []),
  } as any;
  const dealScore = {
    computeWithObservations: jest.fn(
      (e: EnrichedDeal): ScoredDeal => ({
        deal: e,
        score: 80,
        rawScore: 80,
        level: 'good',
        reasons: [],
        penalties: [],
        factors: {},
      }),
    ),
  } as any;
  const config = { get: (_k: string, def?: string) => def } as unknown as ConfigService;

  return {
    fakeSource,
    registry,
    pipeline: new PipelineService(
      ml,
      wa,
      formatter,
      config,
      dedup,
      curation,
      registry,
      dealScore,
    ),
    dedup,
    curation,
    dealScore,
    formatter,
    wa,
  };
}

describe('PipelineService.collectScored(sourceId)', () => {
  it('records each survivor under composite key "ml:..."', async () => {
    const d = makeDeps({ rawDeals: [rawFor('MLB1'), rawFor('MLB2')] });
    await d.pipeline.collectScored('ml');
    expect(d.curation.record).toHaveBeenCalledWith('ml:MLB1', 10000);
    expect(d.curation.record).toHaveBeenCalledWith('ml:MLB2', 10000);
  });

  it('skips deals already posted', async () => {
    const d = makeDeps({
      rawDeals: [rawFor('MLB1'), rawFor('MLB2')],
      failingId: 'MLB1',
    });
    const out = await d.pipeline.collectScored('ml');
    expect(out.map((s) => s.deal.key.externalId)).toEqual(['MLB2']);
  });

  it('scores survivors and returns sorted desc', async () => {
    const d = makeDeps({ rawDeals: [rawFor('MLB1'), rawFor('MLB2')] });
    (d.dealScore.computeWithObservations as jest.Mock)
      .mockImplementationOnce((e: EnrichedDeal): ScoredDeal => ({
        deal: e, score: 70, rawScore: 70, level: 'good',
        reasons: [], penalties: [], factors: {},
      }))
      .mockImplementationOnce((e: EnrichedDeal): ScoredDeal => ({
        deal: e, score: 90, rawScore: 90, level: 'top',
        reasons: [], penalties: [], factors: {},
      }));
    const out = await d.pipeline.collectScored('ml');
    // After filtering (default MIN=75) only the 90 survives:
    expect(out.map((s) => s.score)).toEqual([90]);
  });
});

describe('PipelineService.collectScoredOne(sourceId)', () => {
  it('uses discoverOne and returns scored', async () => {
    const d = makeDeps({ rawDeals: [rawFor('MLB1')] });
    const out = await d.pipeline.collectScoredOne('ml');
    expect(d.fakeSource.discoverOne).toHaveBeenCalled();
    expect(out).toHaveLength(1);
  });
});

describe('PipelineService.collectAllScored', () => {
  it('iterates all registered sources', async () => {
    const d = makeDeps({ rawDeals: [rawFor('MLB1')] });
    const out = await d.pipeline.collectAllScored();
    expect(d.registry.getAll).toHaveBeenCalled();
    expect(out).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/pipeline/pipeline.service.spec.ts`
Expected: FAIL — constructor signature mismatch, method names not found.

- [ ] **Step 3: Rewrite `PipelineService`**

Replace `src/pipeline/pipeline.service.ts`:

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CurationService } from '../curation/curation.service';
import { DealScoreService } from '../deal-score/deal-score.service';
import type { ScoredDeal } from '../deal-score/types';
import { DedupService } from '../dedup/dedup.service';
import { MercadoLivreService } from '../mercado-livre/ml.service';
import {
  EnrichedDeal,
  keyToString,
  RawDeal,
  SourceId,
} from '../sources/source.port';
import { SourceRegistry } from '../sources/source-registry.service';
import { WhatsappService } from '../whatsapp/wa.service';
import { FormatterService } from './formatter.service';

@Injectable()
export class PipelineService {
  private readonly logger = new Logger(PipelineService.name);

  constructor(
    private readonly ml: MercadoLivreService,            // kept for /preview endpoint
    private readonly wa: WhatsappService,
    private readonly formatter: FormatterService,
    private readonly config: ConfigService,
    private readonly dedup: DedupService,
    private readonly curation: CurationService,
    private readonly registry: SourceRegistry,
    private readonly dealScore: DealScoreService,
  ) {}

  async collectScored(sourceId: SourceId): Promise<ScoredDeal[]> {
    const source = this.registry.getById(sourceId);
    const raws = await source.discover();
    return this.scorePipeline(source, raws);
  }

  async collectScoredOne(sourceId: SourceId): Promise<ScoredDeal[]> {
    const source = this.registry.getById(sourceId);
    const raws = await source.discoverOne();
    return this.scorePipeline(source, raws);
  }

  async collectAllScored(): Promise<ScoredDeal[]> {
    const all: ScoredDeal[] = [];
    for (const source of this.registry.getAll()) {
      try {
        const raws = await source.discover();
        const scored = await this.scorePipeline(source, raws);
        all.push(...scored);
      } catch (err) {
        this.logger.error(
          `collectAllScored source=${source.id} failed: ${(err as Error).message}`,
        );
      }
    }
    all.sort((a, b) => b.score - a.score);
    return all;
  }

  private async scorePipeline(
    source: { id: SourceId; enrichMany: (raws: RawDeal[]) => Promise<EnrichedDeal[]> },
    rawDeals: RawDeal[],
  ): Promise<ScoredDeal[]> {
    const windowDays = Number(this.config.get<string>('DEDUP_WINDOW_DAYS', '7'));
    const scoreMin = Number(this.config.get<string>('DEAL_SCORE_MIN', '75'));
    const enrichTopN = Number(this.config.get<string>('DEAL_ENRICH_TOP_N', '10'));

    const survivors: RawDeal[] = [];
    for (const raw of rawDeals) {
      const keyStr = keyToString(raw.key);
      await this.curation.record(keyStr, raw.priceCents);
      if (await this.dedup.wasRecentlyPosted(keyStr, windowDays)) continue;
      if (this.curation.isFakeDiscount(keyStr, raw.priceCents)) continue;
      survivors.push(raw);
    }

    if (survivors.length === 0) {
      this.logger.log(`scorePipeline ${source.id} — raw=${rawDeals.length} survivors=0`);
      return [];
    }

    const preScored = survivors
      .map((r) => ({ raw: r, pre: this.prescore(r) }))
      .sort((a, b) => b.pre - a.pre)
      .slice(0, enrichTopN)
      .map((x) => x.raw);

    const enriched = await source.enrichMany(preScored);

    const scored: ScoredDeal[] = enriched.map((e) => {
      const keyStr = keyToString(e.key);
      const analytics = this.curation.getAnalytics(keyStr);
      const observations = this.curation.getObservations(keyStr);
      return this.dealScore.computeWithObservations(e, analytics, observations);
    });

    const passing = scored.filter((s) => s.score >= scoreMin);
    passing.sort((a, b) => b.score - a.score);

    this.logger.log(
      `scorePipeline ${source.id} — raw=${rawDeals.length} survivors=${survivors.length} ` +
        `enriched=${enriched.length} passing=${passing.length}`,
    );

    return passing;
  }

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
        await this.dedup.markPosted(keyToString(sd.deal.key));
        this.logger.log(
          `dispatch ${keyToString(sd.deal.key)} → WA sent ok (level=${sd.level}, score=${sd.score})`,
        );
        sent++;
      } catch (err) {
        failed++;
        this.logger.error(
          `dispatch ${keyToString(sd.deal.key)} failed: ${(err as Error).message}`,
        );
      }
      await this.sleep(2000);
    }

    return { sent, failed, topScore };
  }

  private prescore(raw: RawDeal): number {
    const keyStr = keyToString(raw.key);
    const analytics = this.curation.getAnalytics(keyStr);
    let s = 0;
    s += Math.min(20, Math.max(0, raw.discountPercent - 25));
    if (analytics.median30d != null && raw.priceCents < analytics.median30d) {
      const ratio = 1 - raw.priceCents / analytics.median30d;
      s += Math.min(25, ratio * 100);
    }
    if (analytics.min30d != null && raw.priceCents <= analytics.min30d) s += 15;
    else if (analytics.min14d != null && raw.priceCents <= analytics.min14d) s += 10;
    else if (analytics.min7d != null && raw.priceCents <= analytics.min7d) s += 5;
    if (analytics.distinctDays < 7) s -= 25;
    return s;
  }

  async runOnce(opts?: {
    sourceId?: SourceId;
    max?: number;
  }) {
    const sourceId: SourceId = opts?.sourceId ?? 'ml';
    const max = opts?.max ?? Number(this.config.get<string>('MAX_DEALS_PER_RUN', '3'));

    const scored = await this.collectScored(sourceId);
    const dispatch = await this.dispatchScored(scored, max);
    return {
      sent: dispatch.sent,
      failed: dispatch.failed,
      scored: scored.length,
      topScore: dispatch.topScore,
      sourceId,
    };
  }

  async preview(opts?: {
    categories?: string[];
    minDiscount?: number;
    perCategory?: number;
  }) {
    // Preview keeps the old ML-only contract for the HTTP controller compatibility.
    const DEFAULT_CATEGORIES = [
      'MLB1648', 'MLB1000', 'MLB1051', 'MLB5726',
      'MLB1276', 'MLB1246', 'MLB1144', 'MLB1430',
    ];
    const categories = opts?.categories?.length ? opts.categories : DEFAULT_CATEGORIES;
    const minDiscount =
      opts?.minDiscount ?? Number(this.config.get<string>('ML_MIN_DISCOUNT', '25'));
    const perCategory = opts?.perCategory ?? 5;

    const results: Record<string, { permalink: string; title: string; price: number; discountPercent: number }[]> = {};
    const flatUrls: string[] = [];
    for (const cat of categories) {
      const deals = await this.ml.getDealsFromHighlights({ category: cat, minDiscount, max: perCategory });
      results[cat] = deals.map((d) => ({
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

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/pipeline/pipeline.service.spec.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Update `PipelineModule` to inject `SourceRegistry`**

Replace `src/pipeline/pipeline.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { AffiliateModule } from '../affiliate/affiliate.module';
import { AuthModule } from '../auth/auth.module';
import { CurationModule } from '../curation/curation.module';
import { DealScoreModule } from '../deal-score/deal-score.module';
import { DedupModule } from '../dedup/dedup.module';
import { HeadlineModule } from '../headline/headline.module';
import { MercadoLivreModule } from '../mercado-livre/ml.module';
import { WhatsappModule } from '../whatsapp/wa.module';
import { FormatterService } from './formatter.service';
import { PipelineController } from './pipeline.controller';
import { PipelineService } from './pipeline.service';

@Module({
  imports: [
    MercadoLivreModule, WhatsappModule, AffiliateModule, DedupModule,
    CurationModule, HeadlineModule, AuthModule, DealScoreModule,
  ],
  controllers: [PipelineController],
  providers: [PipelineService, FormatterService],
  exports: [PipelineService],
})
export class PipelineModule {}
```

> `SourceRegistry` comes from the `@Global() SourcesModule`, so no explicit import is needed. `MercadoLivreModule` stays because `PipelineService.preview()` still uses it directly.

- [ ] **Step 6: Update `PipelineController.runOnce` body if it references `category`**

Read `src/pipeline/pipeline.controller.ts` and replace any `runOnce({ category })` payload with `runOnce({ sourceId: 'ml' })`. The preview endpoint stays unchanged.

- [ ] **Step 7: Type-check + run full suite**

Run: `npx tsc -p tsconfig.json --noEmit` (clean)
Run: `npm test` (all green except scheduler — that's M4.2)

- [ ] **Step 8: Commit**

```bash
git add src/pipeline/pipeline.service.ts src/pipeline/pipeline.service.spec.ts \
        src/pipeline/pipeline.module.ts src/pipeline/pipeline.controller.ts
git commit -m "refactor(pipeline): consume SourceRegistry; collectScored(sourceId)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task M4.2: Scheduler uses registry directly

**Files:**
- Modify: `src/scheduler/scheduler.service.ts`

- [ ] **Step 1: Write the failing test**

Add a new spec `src/scheduler/scheduler.service.spec.ts` (create if missing):

```typescript
// src/scheduler/scheduler.service.spec.ts

import { ConfigService } from '@nestjs/config';
import { SchedulerService } from './scheduler.service';
import type { PipelineService } from '../pipeline/pipeline.service';
import type { SourceRegistry } from '../sources/source-registry.service';
import type { DealSourcePort } from '../sources/source.port';
import type { ScoredDeal } from '../deal-score/types';

function makeFakeSource(id: 'ml'): DealSourcePort {
  return {
    id,
    discover: jest.fn(async () => []),
    discoverOne: jest.fn(async () => []),
    enrichMany: jest.fn(async () => []),
  };
}

function makePipeline(): PipelineService {
  return {
    collectScored: jest.fn(async (): Promise<ScoredDeal[]> => []),
    collectScoredOne: jest.fn(async (): Promise<ScoredDeal[]> => []),
    collectAllScored: jest.fn(async (): Promise<ScoredDeal[]> => []),
    dispatchScored: jest.fn(async () => ({ sent: 0, failed: 0, topScore: null })),
    runOnce: jest.fn(async () => ({ sent: 0, failed: 0, scored: 0, topScore: null, sourceId: 'ml' })),
  } as unknown as PipelineService;
}

function makeRegistry(sources: DealSourcePort[]): SourceRegistry {
  return {
    getAll: jest.fn(() => sources),
    getById: jest.fn((id: string) => sources.find((s) => s.id === id)!),
  } as unknown as SourceRegistry;
}

function makeConfig(env: Record<string, string>): ConfigService {
  return {
    get: (k: string, def?: string) => env[k] ?? def,
  } as unknown as ConfigService;
}

describe('SchedulerService.tickBatch', () => {
  it('calls pipeline.collectAllScored then dispatchScored', async () => {
    const env = {
      SCHEDULER_ENABLED: 'true',
      SCHEDULER_MODE: 'batch',
      MAX_DEALS_PER_RUN: '3',
      QUIET_START: '23',
      QUIET_END: '7',
      TZ: 'UTC',
    };
    const pipeline = makePipeline();
    const registry = makeRegistry([makeFakeSource('ml')]);
    const svc = new SchedulerService(pipeline, registry, makeConfig(env));

    // Bypass quiet hours by patching isQuietHours through the module clock:
    jest.useFakeTimers().setSystemTime(new Date('2026-05-14T12:00:00Z'));

    await svc.tick();

    expect(pipeline.collectAllScored).toHaveBeenCalled();
    expect(pipeline.dispatchScored).toHaveBeenCalled();
    jest.useRealTimers();
  });
});

describe('SchedulerService.tickLegacy', () => {
  it('calls pipeline.collectScoredOne with sourceId from rotator', async () => {
    const env = {
      SCHEDULER_ENABLED: 'true',
      SCHEDULER_MODE: 'legacy',
      MAX_DEALS_PER_RUN: '3',
    };
    const pipeline = makePipeline();
    const registry = makeRegistry([makeFakeSource('ml')]);
    const svc = new SchedulerService(pipeline, registry, makeConfig(env));
    jest.useFakeTimers().setSystemTime(new Date('2026-05-14T12:00:00Z'));

    await svc.tick();

    expect(pipeline.collectScoredOne).toHaveBeenCalledWith('ml');
    expect(pipeline.dispatchScored).toHaveBeenCalled();
    jest.useRealTimers();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/scheduler/scheduler.service.spec.ts`
Expected: FAIL — constructor or methods do not match.

- [ ] **Step 3: Rewrite `SchedulerService`**

Replace `src/scheduler/scheduler.service.ts`:

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { PipelineService } from '../pipeline/pipeline.service';
import type { SourceId } from '../sources/source.port';
import { SourceRegistry } from '../sources/source-registry.service';
import { isQuietHours } from './quiet-hours';

@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);

  constructor(
    private readonly pipeline: PipelineService,
    private readonly registry: SourceRegistry,
    private readonly config: ConfigService,
  ) {}

  @Cron(process.env.SCHEDULER_CRON ?? '0 10,13,17,20 * * *')
  async tick(): Promise<void> {
    const enabled =
      (this.config.get<string>('SCHEDULER_ENABLED') ??
        process.env.SCHEDULER_ENABLED) === 'true';
    if (!enabled) {
      this.logger.debug('Scheduler tick skipped — SCHEDULER_ENABLED!=true');
      return;
    }

    const tz =
      this.config.get<string>('TZ') ?? process.env.TZ ?? 'America/Sao_Paulo';
    const quietStart = Number(
      this.config.get<string>('QUIET_START') ?? process.env.QUIET_START ?? '23',
    );
    const quietEnd = Number(
      this.config.get<string>('QUIET_END') ?? process.env.QUIET_END ?? '7',
    );
    if (isQuietHours(new Date(), quietStart, quietEnd, tz)) {
      this.logger.log(`Scheduler tick skipped — quiet hours`);
      return;
    }

    const mode = (
      this.config.get<string>('SCHEDULER_MODE') ??
      process.env.SCHEDULER_MODE ??
      'legacy'
    ).toLowerCase();

    if (mode === 'batch') {
      await this.tickBatch();
      return;
    }
    await this.tickLegacy();
  }

  private async tickBatch(): Promise<void> {
    const maxDeals = Number(this.config.get<string>('MAX_DEALS_PER_RUN', '3'));
    const startedAt = Date.now();
    try {
      const allScored = await this.pipeline.collectAllScored();
      const dispatch = await this.pipeline.dispatchScored(allScored, maxDeals);
      const ms = Date.now() - startedAt;
      this.logger.log(
        `Scheduler tick batch — totalScored=${allScored.length} ` +
          `dispatched=${dispatch.sent} failed=${dispatch.failed} ` +
          `topScore=${dispatch.topScore ?? 'n/a'} took=${ms}ms`,
      );
    } catch (err) {
      const ms = Date.now() - startedAt;
      this.logger.error(
        `Scheduler tick batch failed — took=${ms}ms: ${(err as Error).message}`,
        (err as Error).stack,
      );
    }
  }

  private async tickLegacy(): Promise<void> {
    const sourceId = this.pickSourceId();
    if (!sourceId) {
      this.logger.warn('Scheduler tick (legacy) skipped — no source registered');
      return;
    }
    const maxDeals = Number(this.config.get<string>('MAX_DEALS_PER_RUN', '3'));
    const startedAt = Date.now();
    try {
      const scored = await this.pipeline.collectScoredOne(sourceId);
      const dispatch = await this.pipeline.dispatchScored(scored, maxDeals);
      const ms = Date.now() - startedAt;
      this.logger.log(
        `Scheduler tick legacy — source=${sourceId} scored=${scored.length} ` +
          `sent=${dispatch.sent} took=${ms}ms`,
      );
    } catch (err) {
      const ms = Date.now() - startedAt;
      this.logger.error(
        `Scheduler tick legacy failed — source=${sourceId} took=${ms}ms: ${(err as Error).message}`,
        (err as Error).stack,
      );
    }
  }

  private pickSourceId(): SourceId | null {
    const all = this.registry.getAll();
    if (all.length === 0) return null;
    // Round-robin / single-source pick. Today only 'ml'; future sub-projects
    // can replace this with a real cross-source rotator.
    return all[0].id;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/scheduler/scheduler.service.spec.ts`
Expected: PASS.

Run: `npm test`
Expected: full green.

- [ ] **Step 5: Commit**

```bash
git add src/scheduler/scheduler.service.ts src/scheduler/scheduler.service.spec.ts
git commit -m "refactor(scheduler): iterate SourceRegistry; drop ML-specific coupling

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Milestone M5 — Store migrations (PR 2 part 2)

### Task M5.1: CurationService boot migration to `ml:` prefix

**Files:**
- Modify: `src/curation/curation.service.ts`
- Modify: `src/curation/curation.service.spec.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/curation/curation.service.spec.ts`:

```typescript
describe('CurationService boot migration', () => {
  it('re-prefixes unprefixed keys with ml: on load', async () => {
    await fs.writeFile(
      TMP_FILE,
      JSON.stringify({
        MLB1: [{ priceCents: 10000, at: '2026-05-14T00:00:00.000Z' }],
        'ml:MLB2': [{ priceCents: 20000, at: '2026-05-14T00:00:00.000Z' }],
      }),
      'utf8',
    );
    const svc = makeService();
    await svc.onModuleInit();
    expect(svc.getObservations('ml:MLB1')).toHaveLength(1);
    expect(svc.getObservations('ml:MLB2')).toHaveLength(1);
    expect(svc.getObservations('MLB1')).toHaveLength(0);
  });

  it('migration is idempotent on second boot', async () => {
    await fs.writeFile(
      TMP_FILE,
      JSON.stringify({ MLB1: [{ priceCents: 10000, at: '2026-05-14T00:00:00.000Z' }] }),
      'utf8',
    );
    const svc1 = makeService();
    await svc1.onModuleInit();
    await svc1.record('ml:MLB3', 15000); // forces persist of migrated file

    const svc2 = makeService();
    await svc2.onModuleInit();
    expect(svc2.getObservations('ml:MLB1')).toHaveLength(1);
    expect(svc2.getObservations('ml:MLB3')).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/curation/curation.service.spec.ts`
Expected: FAIL — keys still unprefixed.

- [ ] **Step 3: Patch the migration**

In `src/curation/curation.service.ts`, after the JSON parse inside `load()` (around the place where `this.store = parsed as PriceHistoryStore` is set), insert:

```typescript
let migrated = 0;
for (const k of Object.keys(this.store)) {
  if (!k.includes(':')) {
    const newKey = `ml:${k}`;
    if (!this.store[newKey]) this.store[newKey] = this.store[k];
    delete this.store[k];
    migrated++;
  }
}
if (migrated > 0) {
  this.logger.log(`Migrated ${migrated} key(s) to ml: prefix`);
  // Defer persist to the next write (avoid awaiting during onModuleInit chain).
  // Set a flag for explicit flush:
  this.pendingMigrationFlush = true;
}
```

Add the field:
```typescript
private pendingMigrationFlush = false;
```

And at the end of `load()` (just before `this.loaded = true`):
```typescript
if (this.pendingMigrationFlush) {
  try { await this.persist(); } catch (err) {
    this.logger.error('Failed to flush migrated store', err as Error);
  }
  this.pendingMigrationFlush = false;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/curation/curation.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/curation/curation.service.ts src/curation/curation.service.spec.ts
git commit -m "feat(curation): idempotent boot migration of unprefixed keys to ml:

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task M5.2: DedupService boot migration

**Files:**
- Modify: `src/dedup/dedup.service.ts`
- Create: `src/dedup/dedup.service.spec.ts` (if absent)

- [ ] **Step 1: Write the failing test**

```typescript
// src/dedup/dedup.service.spec.ts

import * as fs from 'fs/promises';
import * as path from 'path';
import { DedupService } from './dedup.service';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/dedup/dedup.service.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Patch DedupService**

In `src/dedup/dedup.service.ts`, after `this.log = ...` parsing but before the GC block in `load()`, insert:

```typescript
let migrated = 0;
for (const k of Object.keys(this.log)) {
  if (!k.includes(':')) {
    const newKey = `ml:${k}`;
    if (!this.log[newKey]) this.log[newKey] = this.log[k];
    delete this.log[k];
    migrated++;
  }
}
if (migrated > 0) {
  this.logger.log(`Migrated ${migrated} dedup key(s) to ml: prefix`);
  try { await this.persist(); } catch (err) {
    this.logger.error('Failed to persist migrated dedup log', err as Error);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/dedup/dedup.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/dedup/dedup.service.ts src/dedup/dedup.service.spec.ts
git commit -m "feat(dedup): idempotent boot migration of unprefixed keys to ml:

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task M5.3: One-shot backup before migration

**Files:**
- Modify: `src/curation/curation.service.ts`
- Modify: `src/dedup/dedup.service.ts`

- [ ] **Step 1: Add helper to both services**

In `src/curation/curation.service.ts`, near the top, add:

```typescript
const BACKUP_SUFFIX = '.pre-refactor-bak';
```

In `load()`, just before the migration loop, add:

```typescript
const backupEnabled =
  (process.env.SOURCES_MIGRATION_BACKUP ?? 'true').toLowerCase() === 'true';
if (backupEnabled) {
  try {
    const backupPath = `${this.filePath}${BACKUP_SUFFIX}`;
    try {
      await fs.access(backupPath);
      // already exists — skip
    } catch {
      const raw = await fs.readFile(this.filePath, 'utf8').catch(() => '');
      if (raw) {
        await fs.writeFile(backupPath, raw, { encoding: 'utf8', mode: 0o600 });
        this.logger.log(`Pre-refactor backup saved → ${backupPath}`);
      }
    }
  } catch (err) {
    this.logger.warn(`Backup failed (continuing): ${(err as Error).message}`);
  }
}
```

Mirror the same block in `DedupService.load()`.

- [ ] **Step 2: Run full suite**

Run: `npm test`
Expected: green. (No new spec — backup is best-effort; observed via log.)

- [ ] **Step 3: Commit**

```bash
git add src/curation/curation.service.ts src/dedup/dedup.service.ts
git commit -m "feat(stores): one-shot backup before refactor migration

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Milestone M6 — Score rubric refactor (PR 2 part 3)

### Task M6.1: DealScoreService consumes normalized EnrichedDeal

**Files:**
- Modify: `src/deal-score/deal-score.service.ts`
- Modify: `src/deal-score/deal-score.service.spec.ts`
- Delete: `src/deal-score/__fixtures__/enriched-deal-official-store.ts`
- Delete: `src/deal-score/__fixtures__/enriched-deal-unknown-seller.ts`
- Create: `src/deal-score/__fixtures__/enriched-deal-official-store.ts` (new shape)
- Create: `src/deal-score/__fixtures__/enriched-deal-unknown-seller.ts` (new shape)

- [ ] **Step 1: Rewrite fixtures**

```typescript
// src/deal-score/__fixtures__/enriched-deal-official-store.ts

import type { EnrichedDeal } from '../../sources/source.port';

export const enrichedOfficialStore: EnrichedDeal = {
  key: { source: 'ml', externalId: 'MLB1234' },
  source: 'ml',
  raw: {
    key: { source: 'ml', externalId: 'MLB1234' },
    title: 'iPhone',
    priceCents: 499900,
    originalPriceCents: 999900,
    discountPercent: 50,
    thumbnail: '',
    permalink: 'p',
    feedId: 'MLB1648',
  },
  seller: {
    externalSellerId: '42',
    displayName: 'TOP',
    sellerTrust: 'high',
    isVerifiedStore: true,
    ratingAverage: 0.9,
    fetchedAt: '2026-05-14T00:00:00.000Z',
  },
  condition: 'new',
  signals: {
    freeShipping: true,
    installmentsNoInterest: true,
    volumeTier: 'high',
    isVerifiedStore: true,
  },
  extras: {},
};
```

```typescript
// src/deal-score/__fixtures__/enriched-deal-unknown-seller.ts

import type { EnrichedDeal } from '../../sources/source.port';

export const enrichedUnknownSeller: EnrichedDeal = {
  key: { source: 'ml', externalId: 'MLB9999' },
  source: 'ml',
  raw: {
    key: { source: 'ml', externalId: 'MLB9999' },
    title: 'X',
    priceCents: 10000,
    originalPriceCents: 20000,
    discountPercent: 50,
    thumbnail: '',
    permalink: 'p',
    feedId: 'MLB1648',
  },
  seller: null,
  condition: 'unknown',
  signals: {
    freeShipping: false,
    installmentsNoInterest: false,
    volumeTier: 'none',
    isVerifiedStore: false,
  },
  extras: {},
};
```

- [ ] **Step 2: Refactor `DealScoreService.compute` to read normalized fields**

Replace the entire body of `compute()` in `src/deal-score/deal-score.service.ts`. Key changes from the existing implementation:

```typescript
import type { EnrichedDeal } from '../sources/source.port';
// remove: import type { EnrichedDeal } from '../enrichment/types';
```

Inside `compute()`:
- `Math.round(deal.price * 100)` → `deal.raw.priceCents`
- `deal.discountPercent` → `deal.raw.discountPercent`
- `deal.seller?.isOfficialStore` → `deal.signals.isVerifiedStore`
- `deal.seller?.reputationLevel` block → use `deal.seller?.sellerTrust`:
  ```typescript
  if (deal.seller) {
    const map: Record<string, number> = {
      high: this.w.sellerReputationMax,
      medium: Math.round(this.w.sellerReputationMax * 0.3),
      low: -Math.round(this.w.sellerReputationMax * 1.5),
      unknown: 0,
    };
    const w = map[deal.seller.sellerTrust];
    if (typeof w === 'number' && w !== 0) {
      const label = w > 0 ? `Vendedor com boa reputação` : `Vendedor com reputação baixa`;
      add('seller_reputation', w, label);
    }
  } else {
    add('unknown_seller', -this.w.unknownSeller, 'Vendedor não identificado');
  }
  ```
- `deal.freeShipping` → `deal.signals.freeShipping`
- `deal.item?.hasInstallmentsNoInterest` → `deal.signals.installmentsNoInterest`
- `deal.item?.soldQuantity` block → `deal.signals.volumeTier`:
  ```typescript
  const tierW: Record<string, number> = {
    high: this.w.highSoldQtyMax,
    mid: Math.round(this.w.highSoldQtyMax * 0.6),
    low: Math.round(this.w.highSoldQtyMax * 0.2),
    none: 0,
  };
  const soldW = tierW[deal.signals.volumeTier];
  if (soldW > 0) {
    const label =
      deal.signals.volumeTier === 'high' ? 'Muitas vendas' :
      deal.signals.volumeTier === 'mid'  ? 'Boa quantidade de vendas' :
      'Algumas vendas';
    add('high_sold_quantity', soldW, label);
  }
  ```
- `deal.item?.condition !== 'new' && deal.item.condition !== 'not_specified'` → `deal.condition === 'used' || deal.condition === 'refurbished'`

Also update `computeWithObservations`:
- `Math.round(deal.price * 100)` → `deal.raw.priceCents`

- [ ] **Step 3: Update spec fixtures usage**

Update `src/deal-score/deal-score.service.spec.ts` to import the rewritten fixtures and adjust any place that referenced the old `DealItem`/`EnrichedDeal` shape. Specifically:
- `deal.discountPercent` references in test setup → `deal.raw.discountPercent`
- `Math.round(deal.price * 100)` setup → use `deal.raw.priceCents` directly
- `deal.seller.reputationLevel = '5_green'` → `deal.seller!.sellerTrust = 'high'`
- `deal.seller.isOfficialStore = true` → `deal.signals.isVerifiedStore = true`
- `deal.item.soldQuantity = 500` → `deal.signals.volumeTier = 'high'`
- `deal.item.condition = 'used'` → `deal.condition = 'used'`
- `deal.item.hasInstallmentsNoInterest = true` → `deal.signals.installmentsNoInterest = true`
- `deal.freeShipping = true` → `deal.signals.freeShipping = true`

- [ ] **Step 4: Run tests**

Run: `npx jest src/deal-score/`
Expected: PASS (specs updated to match new shape; numeric scores unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/deal-score/deal-score.service.ts src/deal-score/deal-score.service.spec.ts \
        src/deal-score/__fixtures__/enriched-deal-official-store.ts \
        src/deal-score/__fixtures__/enriched-deal-unknown-seller.ts
git commit -m "refactor(deal-score): consume normalized EnrichedDeal (sellerTrust, volumeTier, signals)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task M6.2: Score parity spec

**Files:**
- Create: `src/deal-score/score-parity.spec.ts`

- [ ] **Step 1: Write the parity test**

```typescript
// src/deal-score/score-parity.spec.ts

import { ConfigService } from '@nestjs/config';
import { DealScoreService } from './deal-score.service';
import type { EnrichedDeal } from '../sources/source.port';
import type { PriceAnalytics } from './types';

// These golden cases mirror the spec §5 table. Each row encodes the EXPECTED
// score derived from the rubric definition in the spec. Any drift between
// implementation and these values fails this spec.

const config = { get: (k: string, def?: string) => def } as unknown as ConfigService;
const svc = new DealScoreService(config);

const baseDeal = (over: Partial<EnrichedDeal> = {}): EnrichedDeal => ({
  key: { source: 'ml', externalId: 'MLB1' },
  source: 'ml',
  raw: {
    key: { source: 'ml', externalId: 'MLB1' },
    title: 'X',
    priceCents: 10000,
    originalPriceCents: 20000,
    discountPercent: 50,
    thumbnail: '',
    permalink: 'p',
    feedId: 'MLB1648',
  },
  seller: {
    externalSellerId: '1',
    displayName: 'S',
    sellerTrust: 'high',
    isVerifiedStore: true,
    ratingAverage: 0.9,
    fetchedAt: '2026-05-14T00:00:00.000Z',
  },
  condition: 'new',
  signals: {
    freeShipping: true,
    installmentsNoInterest: true,
    volumeTier: 'high',
    isVerifiedStore: true,
  },
  extras: {},
  ...over,
});

const fullAnalytics: PriceAnalytics = {
  median7d: 12000, median14d: 12000, median30d: 12000,
  min7d: 11000, min14d: 10500, min30d: 10000,
  distinctDays: 30,
};

describe('Score parity (golden values vs spec §5)', () => {
  it('high-trust + official + free + no-interest + high-volume + lowest-30d + 50% discount → 92 (±1)', () => {
    const sd = svc.compute(baseDeal(), fullAnalytics);
    // discount 20 + below_median 17 + lowest_30d 15 + official 10 + seller 10 + free 5 + inst 5 + volume 5 + stab 5 = 92
    // Below the clamp ceiling of 100. Spec acceptance: ±1.
    expect(Math.abs(sd.score - 92)).toBeLessThanOrEqual(1);
  });

  it('unknown seller → unknown_seller penalty applied', () => {
    const sd = svc.compute(baseDeal({ seller: null }), fullAnalytics);
    expect(sd.factors.unknown_seller).toBe(-5);
  });

  it('used condition → used penalty', () => {
    const sd = svc.compute(baseDeal({ condition: 'used' }), fullAnalytics);
    expect(sd.factors.used_or_refurbished).toBe(-15);
  });

  it('volumeTier=mid → +3 (60% of max)', () => {
    const deal = baseDeal({
      signals: { ...baseDeal().signals, volumeTier: 'mid' },
    });
    const sd = svc.compute(deal, fullAnalytics);
    expect(sd.factors.high_sold_quantity).toBe(3);
  });

  it('sellerTrust=low → -15 (1.5× max penalty)', () => {
    const deal = baseDeal({
      seller: { ...baseDeal().seller!, sellerTrust: 'low' },
    });
    const sd = svc.compute(deal, fullAnalytics);
    expect(sd.factors.seller_reputation).toBe(-15);
  });
});
```

- [ ] **Step 2: Run the parity test**

Run: `npx jest src/deal-score/score-parity.spec.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/deal-score/score-parity.spec.ts
git commit -m "test(deal-score): golden parity spec for normalized rubric

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Milestone M7 — Templates (PR 2 part 4)

### Task M7.1: Update templates to read normalized fields

**Files:**
- Modify: `src/pipeline/templates/template-good.ts`
- Modify: `src/pipeline/templates/template-top.ts`
- Modify: `src/pipeline/templates/template-imperdivel.ts`
- Modify: `src/pipeline/templates/legacy.ts`
- Modify: `src/pipeline/templates/index.ts`
- Modify: `src/pipeline/formatter.service.ts`
- Modify: `src/pipeline/formatter.service.spec.ts`

- [ ] **Step 1: Inspect each template and rewrite field references**

For every template that reads `scored.deal.<field>`:
- `scored.deal.price` → `scored.deal.raw.priceCents / 100`
- `scored.deal.originalPrice` → `(scored.deal.raw.originalPriceCents ?? 0) / 100`
- `scored.deal.discountPercent` → `scored.deal.raw.discountPercent`
- `scored.deal.permalink` → `scored.deal.raw.permalink`
- `scored.deal.title` → `scored.deal.raw.title`
- `scored.deal.thumbnail` → `scored.deal.raw.thumbnail`
- `scored.deal.freeShipping` → `scored.deal.signals.freeShipping`
- `scored.deal.seller?.reputationLevel` → use `scored.deal.extras.reputationLevel` (defensive cast); badge only when `scored.deal.signals.isVerifiedStore` for "loja oficial"

Concrete example — `template-imperdivel.ts`:

Before any change, **read the current file** to capture all field accesses. Then replace each one per the list above. Repeat for `template-top.ts`, `template-good.ts`, and `legacy.ts`.

> Do not change visible copy. The badges, emojis, and order remain identical so caption snapshots compare clean.

- [ ] **Step 2: Update `formatter.service.ts`**

`FormatterService.formatScored(scored)` reads:
- `scored.deal.permalink` → `scored.deal.raw.permalink`
- `scored.deal.thumbnail` → `scored.deal.raw.thumbnail`

`FormatterService.formatItem(item, badge)` accepts the old `DealItem` shape — keep it for the `preview` endpoint compatibility. No change needed there.

- [ ] **Step 3: Update spec**

In `src/pipeline/formatter.service.spec.ts`, update any `ScoredDeal` fixture to use the new `EnrichedDeal` shape with `raw`, `signals`, etc.

- [ ] **Step 4: Run full suite**

Run: `npm test`
Expected: green. If a snapshot test fails because formatting differs, **read the diff first**. If copy is the same, accept the snapshot. If copy regressed, fix the template until output matches.

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/
git commit -m "refactor(pipeline): templates read normalized EnrichedDeal

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

**PR 2 ready** (M4+M5+M6+M7 — full rewire + migrations + score + templates).

---

## Milestone M8 — Env docs + cutover (PR 3)

### Task M8.1: `.env.example` documentation

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Append the new section**

Append (or insert after the "Premium Deal Curation" section):

```bash
# ──────────────────────────────────────────
# Source abstraction
# ──────────────────────────────────────────

# Comma-separated list of source ids to register. Today: 'ml'.
# Future: 'ml,shopee,amazon'. Empty = all available.
SOURCES_ENABLED=ml

# One-shot backup of legacy stores before the source-abstraction key
# migration (price-history.json, posted-log.json → .pre-refactor-bak).
# Set to 'false' after the first successful post-refactor boot. Idempotent
# (the backup is skipped if the .bak file already exists).
SOURCES_MIGRATION_BACKUP=true
```

- [ ] **Step 2: Commit**

```bash
git add .env.example
git commit -m "docs(env): document SOURCES_ENABLED and SOURCES_MIGRATION_BACKUP

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task M8.2: Cutover notes

**Files:**
- Create: `docs/superpowers/notes/2026-05-14-source-abstraction-cutover.md`

- [ ] **Step 1: Write the cutover doc**

```markdown
# Source Abstraction Cutover Notes (2026-05-14)

## Pre-deploy

1. Confirm staging passes `npm test` + `npx tsc --noEmit`.
2. Backup prod `data/price-history.json` and `data/posted-log.json` manually
   (in addition to the automatic `.pre-refactor-bak` files created on boot).
3. Confirm `SOURCES_ENABLED=ml` (default) and `SOURCES_MIGRATION_BACKUP=true`
   in the prod env.

## Deploy

1. Deploy with `SCHEDULER_ENABLED=false`.
2. Hit `GET /pipeline/preview` to confirm ML discovery still works.
3. Set `SCHEDULER_ENABLED=true` and `SCHEDULER_MODE=batch` with `WA_TARGET_JID`
   pointing to a test JID.
4. Observe 3 ticks. Validate:
   - log line `Scheduler tick batch — totalScored=N dispatched=K topScore=X`
   - no Sentry errors
   - score distribution against prior baseline ≤ 5% drift
5. Flip `WA_TARGET_JID` back to production target.

## Rollback

1. Revert the merge commit on `main`.
2. Restore `data/price-history.json` and `data/posted-log.json` from
   `.pre-refactor-bak`.
3. Re-deploy.

## Post-deploy

1. Set `SOURCES_MIGRATION_BACKUP=false` after 24h of clean operation.
2. Mark the source-abstraction sub-project complete in `docs/superpowers/plans/`.
3. Open the next sub-project (Shopee adapter) per the spec roadmap.
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/notes/2026-05-14-source-abstraction-cutover.md
git commit -m "docs: source abstraction cutover notes

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

**PR 3 ready.**

---

## Verification (after all milestones)

- [ ] `npm test` — all suites green (95 existing + ~25 new)
- [ ] `npx tsc -p tsconfig.json --noEmit` — no errors
- [ ] `npm run lint` — no NEW errors (pre-existing 3 errors out-of-scope)
- [ ] Manual: add a no-op `FakeShopeeSource` (id `'shopee' as SourceId` — temporarily widen `SourceId`) in a test, register via a temporary module, run `npm test`. Assert pipeline includes it without changes to pipeline/scheduler/score files. Revert.
- [ ] Manual staging dry-run per the cutover notes §"Deploy".
- [ ] Score distribution pre/post matches within 5% on a 7-day window of identical inputs (compared via stash of `price-history.json` snapshot).

---

## Self-review summary

**Spec coverage:**

| Spec section | Implementing tasks |
|---|---|
| §2.1 New modules | M1.1, M1.2, M1.3, M2.1, M2.3, M2.4 |
| §2.2 Modified modules | M3.1, M4.1, M4.2, M6.1, M7.1 |
| §2.3 Batch flow | M4.1 (`collectAllScored`), M4.2 |
| §2.4 Legacy flow | M4.1 (`collectScoredOne`), M4.2 |
| §3 Port contracts | M1.1 |
| §4 ML→normalized mapping | M2.1 (`mapping.ts`) |
| §5 Score rubric adaptation | M6.1, M6.2 (parity) |
| §6 Store migrations | M5.1, M5.2, M5.3 |
| §7 Module composition | M1.3, M2.4 |
| §8 Env changes | M8.1 |
| §9 Testing strategy | all task specs |
| §10 Acceptance criteria | Verification section + M6.2 |
| §11 Rollout phases | M8.2 cutover doc |
| §13 Migration plan / milestones | M1–M8 = §13 M1–M8 |

**Placeholder scan:** no `TBD`, no `TODO`, no vague "add error handling", no unreferenced symbols. The `MercadoLivreService` import in `PipelineService` is intentional (preview endpoint compatibility).

**Type consistency:**
- `keyToString` / `parseKey` defined in M1.1 are consumed in M4.1 (`pipeline.service.ts`), M5.1 (curation migration), M5.2 (dedup migration) — same signature.
- `EnrichedDeal` shape defined in M1.1 is consumed in M2.1 mapping, M2.3 enrichMany, M4.1 score pipeline, M6.1 dealScore.compute, M7.1 templates — all use `raw`, `seller`, `signals`, `condition`, `extras` consistently.
- `DealSourcePort.discover()` / `discoverOne()` / `enrichMany()` shapes defined in M1.1 are honored by `MLSource` in M2.3 and consumed by pipeline in M4.1.
- `SourceId = 'ml'` (string literal type) is widened only for the verification step's manual `FakeShopeeSource` test — production code keeps `'ml'`-only until sub-project #2.
