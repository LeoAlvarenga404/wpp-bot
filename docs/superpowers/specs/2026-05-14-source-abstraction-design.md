# Source Abstraction — Design Spec

**Date:** 2026-05-14
**Author:** Leonardo Prado (with Claude brainstorm)
**Status:** Draft, awaiting plan
**Goal:** Extract a `DealSourcePort` abstraction so adding a new affiliate source (Shopee, Amazon, etc.) becomes a single-file plug-in. Refactor the current Mercado Livre code path as the reference adapter. No new sources are added in this scope.

---

## 1. Philosophy

> "Pipeline must not know which marketplace it is talking to. Adding a new source must touch only that source's module."

This refactor takes the existing ML-coupled pipeline and slides a port-and-adapter seam between the pipeline and the source. ML becomes one implementation of `DealSourcePort`; the pipeline iterates over the registry. Adding a second source becomes additive, not invasive.

Out of scope: implementing Shopee/Amazon adapters, multi-target WhatsApp distribution, affiliate-link multi-source registry. Those land in follow-up sub-projects.

---

## 2. Architecture

### 2.1 New modules

```
src/sources/
  source.port.ts                 # DealSourcePort, ProductKey, RawDeal,
                                 # EnrichedDeal, NormalizedSeller, helpers
  source-registry.service.ts     # collects all DealSourcePort impls via DI
  sources.module.ts              # registers registry + each source module
  mercado-livre/
    ml-source.service.ts         # implements DealSourcePort — composes
                                 # MercadoLivreService + EnrichmentService
                                 # + internal feed rotator
    ml-source.module.ts          # imports MercadoLivreModule, EnrichmentModule,
                                 # provides MLSource + internal rotator
```

### 2.2 Modified modules

- `src/pipeline/pipeline.service.ts`
  - `collectScored(sourceId): Promise<ScoredDeal[]>` — uses `source.discover()` (all feeds). Replaces `collectScored(category)`.
  - `collectScoredOne(sourceId): Promise<ScoredDeal[]>` — uses `source.discoverOne()` (rotated single feed). New, for legacy scheduler path.
  - `collectAllScored(): Promise<ScoredDeal[]>` — iterates `SourceRegistry.getAll()` calling `collectScored` per source, merges results.
  - `runOnce(opts)` accepts `sourceId` instead of `category`; preserves existing public shape for HTTP controller compatibility.
  - All three collect methods share: enrich-top-N, score, filter, sort — only the `discover()` vs `discoverOne()` differ.
- `src/pipeline/pipeline.module.ts` — imports `SourcesModule`, drops direct `MercadoLivreModule` / `EnrichmentModule` imports (those become transitive via MLSource).
- `src/scheduler/scheduler.service.ts`
  - Batch path iterates sources via registry, no longer references categories at scheduler level.
  - Legacy path picks one `sourceId` (today only `'ml'`), calls `pipeline.collectScoredOne(sourceId)` which delegates to `source.discoverOne()`.
- `src/deal-score/deal-score.service.ts` — consumes normalized `EnrichedDeal` (reads `signals.*`, `seller.sellerTrust`, `condition`); rubric factors map to new field names but keep same weights/levels.
- `src/curation/curation.service.ts` — no API change; callers pass `keyToString(productKey)` strings. Adds idempotent boot migration that re-prefixes legacy unprefixed keys with `ml:`.
- `src/dedup/dedup.service.ts` — same: callers pass composite-key strings; on-load migration prefixes legacy keys with `ml:`.
- `src/pipeline/templates/*.ts` — updated to read normalized fields; can still pull source-specific badges from `EnrichedDeal.extras`.
- `src/scheduler/category-rotator.service.ts` — relocated into `src/sources/mercado-livre/feed-rotator.service.ts` (rename, scope to ML feeds). Public API unchanged where reused inside MLSource. `CATEGORY_WEIGHTS` env stays but is now consumed only by ML source.

### 2.3 Flow (per scheduler tick, batch mode)

```
SchedulerService.tickBatch():
  pipeline.collectAllScored()
    ↓
    for source in registry.getAll():
      raws = await source.discover()
      survivors = []
      for raw in raws:
        keyStr = keyToString(raw.key)            # "ml:MLB1234"
        curation.record(keyStr, raw.priceCents)  # ALWAYS FIRST
        if dedup.wasRecentlyPosted(keyStr) → skip
        if curation.isFakeDiscount(keyStr) → skip
        survivors.push(raw)
      preScored = prescore(survivors).slice(0, DEAL_ENRICH_TOP_N)
      enriched = await source.enrichMany(preScored)
      scored = enriched.map(e => dealScore.compute(e, analytics(e.key), observations(e.key)))
      pass = scored.filter(s => s.score >= DEAL_SCORE_MIN)
      allScored.push(...pass)
    ↓
  allScored.sort(desc by score).slice(0, MAX_DEALS_PER_RUN)
    ↓
  for sd in topK:
    format by sd.level + sd.source
    wa.send
    dedup.markPosted(keyToString(sd.deal.key))
```

### 2.4 Legacy flow (one source per tick, rotated feed)

```
SchedulerService.tickLegacy():
  sourceId = legacyRotator.pickSource()       # today: only 'ml'
  scored = pipeline.collectScoredOne(sourceId)
    ↓ internally:
      source = registry.getById(sourceId)
      raws = await source.discoverOne()       # ML source rotates own feeds internally
      # same survivors → enrich → score → filter as collectScored, bounded to one feed
    ↓
  pipeline.dispatchScored(scored, MAX_DEALS_PER_RUN)
```

`legacyRotator` is a trivial source-level picker (today only `'ml'` available, so it returns `'ml'`); future sub-projects can extend it to round-robin across multiple sources in legacy mode.

---

## 3. Port contracts

### 3.1 Identity

```typescript
export type SourceId = 'ml';  // future: 'shopee' | 'amazon' | ...

export interface ProductKey {
  source: SourceId;
  externalId: string;
}

export function keyToString(k: ProductKey): string {
  return `${k.source}:${k.externalId}`;
}

export function parseKey(s: string): ProductKey | null {
  const idx = s.indexOf(':');
  if (idx <= 0) return null;
  const source = s.slice(0, idx);
  const externalId = s.slice(idx + 1);
  if (!externalId) return null;
  return { source: source as SourceId, externalId };
}
```

Rule: `externalId` may contain `:` (split on first `:` only). All store keys are the serialized string; in-memory model uses `ProductKey`.

### 3.2 Raw + enriched models

```typescript
export interface RawDeal {
  key: ProductKey;
  title: string;
  priceCents: number;
  originalPriceCents: number | null;
  discountPercent: number;
  thumbnail: string;
  permalink: string;
  feedId: string;       // telemetry: "MLB1648" for ML, keyword for Shopee, etc.
  condition?: 'new' | 'used' | 'refurbished';
}

export interface NormalizedSeller {
  externalSellerId: string;
  displayName: string | null;
  sellerTrust: 'high' | 'medium' | 'low' | 'unknown';
  isVerifiedStore: boolean;
  ratingAverage: number | null;   // normalized 0..1 (null when unknown)
  fetchedAt: string;              // ISO
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
  extras: Record<string, unknown>;  // source-specific (e.g. ML: powerSellerStatus, reputationLevel, soldQuantity, catalogId)
}
```

### 3.3 Port

```typescript
export interface DealSourcePort {
  readonly id: SourceId;
  discover(): Promise<RawDeal[]>;
  discoverOne(): Promise<RawDeal[]>;
  enrichMany(raws: RawDeal[]): Promise<EnrichedDeal[]>;
  ping?(): Promise<{ ok: boolean; message?: string }>;
}
```

### 3.4 Registry

```typescript
@Injectable()
export class SourceRegistry {
  constructor(@Inject(SOURCES_TOKEN) private readonly sources: DealSourcePort[]) {}
  getAll(): DealSourcePort[] { return this.sources; }
  getById(id: SourceId): DealSourcePort {
    const s = this.sources.find(x => x.id === id);
    if (!s) throw new Error(`Unknown source id: ${id}`);
    return s;
  }
}
```

`SOURCES_TOKEN` is a multi-injection token. Each source module registers itself with `provide: SOURCES_TOKEN, useExisting: <SourceClass>, multi: true` (or via NestJS-equivalent pattern using `useFactory` to collect).

---

## 4. ML → normalized mapping (reference adapter)

| ML field | Normalized field | Mapping rule |
|---|---|---|
| `reputationLevel === '5_green' \| '4_light_green'` | `seller.sellerTrust = 'high'` | exact match |
| `reputationLevel === '3_yellow'` | `seller.sellerTrust = 'medium'` | exact match |
| `reputationLevel === '2_orange' \| '1_red'` | `seller.sellerTrust = 'low'` | exact match |
| `reputationLevel === null` | `seller.sellerTrust = 'unknown'` | null/absent |
| `isOfficialStore` | `seller.isVerifiedStore` + `signals.isVerifiedStore` | direct |
| `ratingAverage` (0..5 in ML) | `seller.ratingAverage` (0..1) | `ml / 5` |
| `sold_quantity >= 500` | `signals.volumeTier = 'high'` | thresholds preserved from current rubric |
| `sold_quantity >= 100` | `signals.volumeTier = 'mid'` | |
| `sold_quantity >= 20` | `signals.volumeTier = 'low'` | |
| `sold_quantity < 20` | `signals.volumeTier = 'none'` | |
| `installments.rate === 0` | `signals.installmentsNoInterest = true` | |
| `shipping.free_shipping` | `signals.freeShipping` | direct |
| `condition` ∈ {'new','used','refurbished'} | `condition` (same enum) | direct |
| `condition` other/null | `condition = 'unknown'` | |
| `powerSellerStatus`, `reputationLevel`, `officialStoreId`, `soldQuantity`, ML `catalogId` | `extras.*` | preserved verbatim for templates |

---

## 5. Score rubric adaptation

All current factors stay; only the read sites change. Same weights, same level cutoffs.

| Factor | Current read | After refactor read |
|---|---|---|
| `seller_reputation` | `seller.reputationLevel` string | `seller.sellerTrust` enum mapped to weights: `high=+10`, `medium=+3`, `low=-15`, `unknown=0` |
| `official_store` | `seller.isOfficialStore` | `signals.isVerifiedStore` |
| `high_sold_quantity` | `item.soldQuantity` number | `signals.volumeTier`: `high=+5, mid=+3, low=+1, none=0` |
| `free_shipping` | `raw.freeShipping` | `signals.freeShipping` |
| `installments_no_interest` | `item.installments.rate === 0` | `signals.installmentsNoInterest` |
| `used_or_refurbished` | `item.condition !== 'new'` | `enriched.condition !== 'new'` (counting `'used'` and `'refurbished'`; `'unknown'` does NOT trigger penalty) |
| `unknown_seller` | `seller === null` | `seller === null` (unchanged) |
| `discount_percent`, `below_median_30d`, `lowest_price_*`, `price_stability`, `insufficient_history`, `price_raise_before_discount`, `discount_from_original_only`, `current_above_median_30d` | source-agnostic already | unchanged |

Acceptance: scores for the same input pre- and post-refactor must match within ±1 point (rounding noise allowed; otherwise mapping has a bug).

---

## 6. Store migrations

### 6.1 `data/price-history.json`

- Boot-time migration in `CurationService.load()`:
  ```
  for key in store:
    if ':' not in key: store['ml:' + key] = store[key]; delete store[key]
  if migrated > 0: persist; log "Migrated N keys to ml: prefix"
  ```
- Idempotent (only acts on unprefixed keys).
- Triggered on every boot; effectively one-shot in practice.

### 6.2 `data/posted.json` (dedup)

- Same pattern as 6.1, in `DedupService` boot path.

### 6.3 `data/seller-cache.json`

- Stays in ML enrichment scope. No prefix; ML-internal. Future Shopee adapter owns its own cache file.

### 6.4 `data/last-category.json` → `data/ml-last-feed.json`

- Rename. On boot, if new file missing AND old file exists, copy contents and delete old.
- One-shot; safe to leave both for one release cycle.

### 6.5 One-time backup

- New env: `SOURCES_MIGRATION_BACKUP=true` (default true).
- When true and `price-history.json.pre-refactor-bak` does not exist, copy current `price-history.json` to that path before running migration. Logged at `LOG`.
- Same for `posted.json` → `posted.json.pre-refactor-bak`.
- Backup is one-shot (skipped if `.bak` already exists). Set env to false to disable.

---

## 7. Module composition

```
AppModule
├── SourcesModule           # NEW
│   ├── SourceRegistry
│   ├── MLSourceModule       # NEW
│   │   ├── MLSource (DealSourcePort)
│   │   ├── MercadoLivreModule (existing, transitive)
│   │   ├── EnrichmentModule (existing, transitive)
│   │   └── FeedRotatorService (renamed CategoryRotatorService)
│   └── (future: ShopeeSourceModule, AmazonSourceModule)
├── PipelineModule          # imports SourcesModule (drops direct ML/Enrichment imports)
├── SchedulerModule         # imports PipelineModule + SourcesModule
├── CurationModule          # unchanged API
├── DealScoreModule         # unchanged DI, refactored impl
├── DedupModule
├── WhatsappModule
└── AffiliateModule
```

`SourcesModule` is the new top-level seam. Pipeline injects only `SourceRegistry`, never a concrete source.

---

## 8. Env changes

### 8.1 New

| Name | Default | Purpose |
|---|---|---|
| `SOURCES_ENABLED` | `ml` | Comma-separated list of source ids to register. Empty = all available. |
| `SOURCES_MIGRATION_BACKUP` | `true` | One-shot pre-refactor backup of legacy stores. |

### 8.2 Unchanged (now consumed only by ML source)

- `CATEGORY_WEIGHTS` — ML feed rotation
- `ML_*` — ML auth + base config
- `SELLER_CACHE_*` — ML enrichment cache
- All `DEAL_SCORE_*`, `CURATION_*`, `DEDUP_*` — source-agnostic

### 8.3 Behavior

- If `SOURCES_ENABLED=ml` (default), only ML source registers; identical behavior to today.
- Future: `SOURCES_ENABLED=ml,shopee` to enable Shopee adapter when shipped.

---

## 9. Testing strategy

### 9.1 New specs

- `src/sources/source.port.spec.ts` — `keyToString` / `parseKey` round-trip + edge cases (empty, no colon, multiple colons, special chars in externalId).
- `src/sources/source-registry.service.spec.ts` — multi-inject collection, `getById` throws on unknown, `getAll` returns all.
- `src/sources/mercado-livre/ml-source.service.spec.ts` — covers:
  - `discover()` fans out across configured categories, returns `RawDeal[]` with correct `feedId`, `key.source = 'ml'`.
  - `discoverOne()` invokes feed rotator, uses chosen category only.
  - `enrichMany()` mapping: validates every row of the §4 table with fixture inputs.
  - Error isolation: a failed category in `discover()` does not abort other categories.
- `src/sources/mercado-livre/feed-rotator.service.spec.ts` — rename of existing `category-rotator.service.spec.ts`, specs preserved.

### 9.2 Refactored specs

- `src/deal-score/deal-score.service.spec.ts` — fixtures rewritten to use normalized `EnrichedDeal`. Assertions on final score unchanged from pre-refactor (acceptance §5).
- `src/pipeline/pipeline.service.spec.ts` — `collectScored(sourceId)` and `collectAllScored()` paths. Tests inject a fake `DealSourcePort` returning fixture raws + enriched.
- `src/curation/curation.service.spec.ts` — adds boot-migration test: load file with mixed legacy + prefixed keys, assert all re-prefixed.
- `src/dedup/dedup.service.spec.ts` — same migration test.
- `src/scheduler/scheduler.service.spec.ts` — batch path iterates registry of fakes; legacy path picks one.

### 9.3 Fixtures

- `src/sources/__fixtures__/raw-deal-ml.ts`
- `src/sources/__fixtures__/enriched-deal-ml-normalized.ts`
- `src/sources/__fixtures__/normalized-seller-high.ts`, `-low.ts`, `-unknown.ts`
- `src/deal-score/__fixtures__/enriched-deal-*.ts` — rewritten to normalized shape; legacy fixtures (`enriched-deal-official-store.ts`, `enriched-deal-unknown-seller.ts`) replaced.

### 9.4 Coverage gate

- Jest config thresholds preserved. Refactored services keep ≥80% line coverage. New port + registry require 100%.

---

## 10. Acceptance criteria

- [ ] `npm test` — all suites green (existing 95 + new specs).
- [ ] `npx tsc -p tsconfig.json --noEmit` — clean.
- [ ] `npm run lint` — no NEW errors (pre-existing 3 errors documented as out-of-scope).
- [ ] Pipeline behavior is observationally identical pre/post-refactor for the same input data:
  - Same deals enter survivor list.
  - Same scores within ±1 point.
  - Same level (`good`/`top`/`imperdível`) assigned.
  - Same WhatsApp dispatch order.
- [ ] `CurationService` and `DedupService` migrate legacy unprefixed keys on first boot; log line emitted; subsequent boots are no-ops.
- [ ] Backup files created when `SOURCES_MIGRATION_BACKUP=true` and `.bak` absent; skipped otherwise.
- [ ] Adding a Shopee source stub (any class implementing `DealSourcePort` with `id = 'shopee'`, registered in a new module) requires zero changes in `pipeline/`, `scheduler/`, `deal-score/`. Verified by adding a no-op `FakeShopeeSource` in a test and asserting pipeline picks it up.
- [ ] `SOURCES_ENABLED=ml` (default) and absent both produce identical behavior to today.

---

## 11. Rollout phases

| Phase | Action | Validation |
|---|---|---|
| 1 | Open PR with refactor | CI green (tests + tsc + lint) |
| 2 | Deploy staging with `SCHEDULER_ENABLED=false` | smoke via `/pipeline/preview` HTTP endpoint |
| 3 | Enable staging scheduler, batch mode, test JID | observe 3-4 ticks; verify dispatch, score distribution, level mix |
| 4 | Backup `price-history.json` and `posted.json` in prod via env (one-shot) | confirm `.bak` files exist |
| 5 | Deploy prod, monitor 24h | no new Sentry errors; dispatch rate normal; score distribution shifted <5% |
| 6 | Mark refactor complete; open sub-project #2 (Shopee adapter) | — |

Rollback: revert merge commit, restore `price-history.json` / `posted.json` from `.bak`. Migration is one-way at the data level but reversible via backup.

---

## 12. Out of scope (handled by future sub-projects)

- Shopee adapter implementation (sub-project #2).
- Amazon adapter via PA-API (sub-project #3).
- Multi-target WhatsApp distribution (route deals per group/level/source) (sub-project #4).
- `AffiliateRegistry` — per-source affiliate link adapters (lands with sub-project #2 when needed).
- Cross-source product deduplication via GTIN/EAN (sub-project #5+).
- Observability dashboards (orthogonal track).
- CTR-driven score weight tuning (orthogonal track).

---

## 13. Migration plan

One milestone per logical PR. Each milestone is independently testable.

- **M1 — Contracts + registry.** Adds `src/sources/source.port.ts`, `source-registry.service.ts`, `sources.module.ts`. Empty registry (no sources yet). Tests for helpers + registry.
- **M2 — MLSource adapter.** Adds `src/sources/mercado-livre/ml-source.service.ts` that wraps existing `MercadoLivreService` + `EnrichmentService`. Includes mapping table impl. `MLSourceModule` registers it. Pipeline NOT yet rewired. Specs cover §4 mapping.
- **M3 — Feed rotator move.** Renames `CategoryRotatorService` → `FeedRotatorService` under `src/sources/mercado-livre/`. Imports updated. Specs renamed.
- **M4 — Pipeline + scheduler rewire.** `PipelineService` switches to `SourceRegistry.getById('ml')` + `collectAllScored()`. `SchedulerService` iterates registry. Tests updated. Legacy mode preserved.
- **M5 — Curation + dedup migrations.** Adds boot-time prefix migration + backup logic. Specs for both.
- **M6 — Score rubric refactor.** `DealScoreService` reads normalized fields. Fixtures rewritten. Score-parity validation (acceptance §5).
- **M7 — Templates.** Templates read normalized fields; access `extras` for ML badges. Snapshot tests updated.
- **M8 — Env docs + cutover.** `.env.example` documents `SOURCES_ENABLED`, `SOURCES_MIGRATION_BACKUP`. Cutover notes in `docs/`.

PR boundary: M1+M2+M3 in one PR (contracts + adapter + rename, all behind unused seam); M4+M5+M6+M7 in second PR (the actual rewire); M8 in third PR. Or single combined PR if reviewers prefer big-bang — flag for user.

---

## 14. Risks + mitigations

| Risk | Mitigation |
|---|---|
| Score parity violated → different deals dispatched | Acceptance §5 (±1 point); fixtures cover every mapping row |
| Store migration corrupts data | One-shot backup files; idempotent migration; rollback documented |
| Legacy mode breaks during scheduler refactor | Both paths covered by spec; explicit test asserts legacy still works |
| Pipeline circular DI when registry sits between source and pipeline | Registry holds only port refs; sources hold no pipeline ref; verified by `NestApplication.init()` in a smoke test |
| `extras` becomes a junk drawer | Templates document which `extras.*` they read; reviewer enforces no business logic on `extras` outside templates |

---

## 15. Open questions (none blocking)

- Should `SourceRegistry.getAll()` order be stable? Suggested: order by registration (env `SOURCES_ENABLED` list order); document in spec for §5 rollout phase comparability.
- Future-proof: should `EnrichedDeal.source` be derivable from `key.source` instead of duplicated? Yes — drop redundancy in v2 once second source lands; harmless duplication for v1.
