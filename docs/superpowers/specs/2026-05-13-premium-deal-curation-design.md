# Premium Deal Curation — Design Spec

**Date:** 2026-05-13
**Author:** Leonardo Prado (with Claude brainstorm)
**Status:** Draft, awaiting plan
**Goal:** Transform the current Mercado Livre deal bot into a premium curation bot that sends few, excellent deals — not many average ones.

---

## 1. Philosophy

> "Don't send the highest discount percentage — send the best real opportunity."

Quality over volume. A deal must earn its publish slot via an explainable score. Hard gates (existing curation) remain as a safety net; soft scoring decides what makes it through.

---

## 2. Architecture

### 2.1 New modules

```
src/
  enrichment/
    enrichment.service.ts       # fetches /users/{id} + /items/{itemId}, builds EnrichedDeal
    seller-cache.service.ts     # JSON file cache with TTL, atomic tmp+rename writes
    types.ts                    # EnrichedDeal, SellerInfo, ItemDetails
  deal-score/
    deal-score.service.ts       # computes ScoredDeal {score, level, reasons, penalties, factors}
    price-analytics.ts          # pure functions: analyze(), detectPriceRaiseBeforeDiscount(), trend
    types.ts                    # ScoredDeal, DealLevel, ScoreReason, PriceAnalytics
```

### 2.2 Modified modules

- `src/curation/curation.service.ts` — exposes `getAnalytics(catalogId): PriceAnalytics` and `getObservations(catalogId): PriceObservation[]`. Existing `isFakeDiscount` and `getLowestPriceBadge` preserved (hard gate retained).
- `src/pipeline/pipeline.service.ts` — split into `collectScored(category, opts)` and `dispatchScored(deals, max)`. `runOnce(opts)` is now `collectScored` + `dispatchScored` for backwards compatibility.
- `src/pipeline/formatter.service.ts` — accepts `ScoredDeal`, renders 3 templates by `level`.
- `src/scheduler/scheduler.service.ts` — opt-in `SCHEDULER_MODE=batch` collects all weighted categories, ranks globally, dispatches top K.
- `src/scheduler/category-rotator.service.ts` — adds `getWeighted(): {category, weight}[]`. `pick()` preserved for legacy mode.

### 2.3 Flow (per scheduler tick, batch mode)

```
For each category in CATEGORY_WEIGHTS:
  ml.getDealsFromHighlights(category) → DealItem[]
  For each deal:
    1. curation.record(catalogId, priceCents)              ← ALWAYS FIRST
    2. dedup.wasRecentlyPosted? → skip
    3. curation.isFakeDiscount? → skip (hard gate)
    4. survivor list ← deal
  prescore(survivors)            → cheap score with existing fields only
  topN ← survivors sorted desc, sliced DEAL_ENRICH_TOP_N
  enrichment.enrichMany(topN)    → EnrichedDeal[] (seller cached, item fresh)
  dealScore.compute(...)         → ScoredDeal[]
  filter score >= DEAL_SCORE_MIN

Cross-category merge:
  allScored sorted desc
  top MAX_DEALS_PER_RUN
  → formatter (template per level)
  → wa.send
  → dedup.markPosted
```

---

## 3. Scoring rubric

Additive model, clamped [0, 100]. All weights overrideable via `DEAL_SCORE_W_<FACTOR>` env vars.

### 3.1 Positive factors

| Code | Default weight | Condition |
|---|---|---|
| `discount_percent` | 0–20 | linear: 25% → 0, 50% → 20, clamp |
| `below_median_30d` | 0–25 | `(1 - price / median30d) * 100`, cap 25 |
| `lowest_price_30d` | 15 | `price <= min30d` |
| `lowest_price_14d` | 10 | `price <= min14d` (only if 30d did not match) |
| `lowest_price_7d` | 5 | `price <= min7d` (only if 14d/30d did not match) |
| `official_store` | 10 | `official_store_id != null` |
| `seller_reputation` | -15 to +10 | `5_green=10`, `4_light_green=7`, `3_yellow=3`, `2_orange=-5`, `1_red=-15` |
| `free_shipping` | 5 | `shipping.free_shipping === true` |
| `installments_no_interest` | 5 | item exposes parcelas sem juros |
| `high_sold_quantity` | 0–5 | `sold>=500=5`, `>=100=3`, `>=20=1` |
| `price_stability` | 5 | stddev of last 30d observations < 5% of median30d |

### 3.2 Penalty factors

| Code | Default weight | Condition |
|---|---|---|
| `insufficient_history` | -25 | `distinctDays < CURATION_MIN_HISTORY_DAYS` |
| `price_raise_before_discount` | -30 | hybrid heuristic (Section 4) |
| `used_or_refurbished` | -15 | `condition !== 'new'` |
| `discount_from_original_only` | -10 | no history AND only signal is `original_price > price` |
| `current_above_median_30d` | -10 | `price > median30d` |
| `unknown_seller` | -5 | enrichment failed to fetch seller |

(Seller reputation `1_red` / `2_orange` are negative inside `seller_reputation` factor — not a separate penalty.)

### 3.3 Output type

```typescript
type DealLevel = 'rejected' | 'good' | 'top' | 'super';

interface ScoreReason {
  code: string;        // e.g. 'lowest_price_30d'
  weight: number;      // contribution to final score
  message: string;     // pt-BR, ready to display
}

interface ScoredDeal {
  deal: EnrichedDeal;
  score: number;       // 0-100 clamped
  rawScore: number;    // pre-clamp, for debugging
  level: DealLevel;
  reasons: ScoreReason[];   // positive only, sorted by weight desc
  penalties: ScoreReason[];
  factors: Record<string, number>; // factor code → final contribution
}
```

### 3.4 Level buckets

- `score < DEAL_SCORE_MIN` (default 75) → `rejected` (do not send)
- `[75, 90)` → `good`
- `[90, 95)` → `top`
- `[95, 100]` → `super`

**Insufficient history clamp:** when `distinctDays < CURATION_MIN_HISTORY_DAYS`, level is capped at `top` regardless of raw score. A `super` label requires real historical evidence.

---

## 4. Price analytics + scam heuristic

Pure module: `src/deal-score/price-analytics.ts`. No I/O, fully testable.

### 4.1 API

```typescript
interface PriceHistoryInput {
  observations: { priceCents: number; at: string }[];
  now?: Date;          // injectable for tests
}

interface PriceAnalytics {
  median7d: number | null;
  median14d: number | null;
  median30d: number | null;
  min7d: number | null;
  min14d: number | null;
  min30d: number | null;
  distinctDays: number;
  lastObservedBefore: { priceCents: number; at: string } | null;
  trend: 'falling' | 'rising' | 'flat' | 'unknown';
}

interface PriceRaiseSignal {
  suspicious: boolean;
  peakInWindowCents: number | null;
  baselinePreWindowCents: number | null;
  currentVsBaselineRatio: number | null;
  reason?: string;     // human-readable explanation
}

function analyze(input: PriceHistoryInput): PriceAnalytics;

function detectPriceRaiseBeforeDiscount(
  input: PriceHistoryInput,
  currentPriceCents: number,
  opts: {
    peakWindowDays: number;          // PRICE_RAISE_PEAK_WINDOW_DAYS=14
    baselineWindowDays: number;      // PRICE_RAISE_BASELINE_WINDOW_DAYS=30
    peakRatio: number;               // PRICE_RAISE_PEAK_RATIO=1.20
    currentBaselineRatio: number;    // PRICE_RAISE_CURRENT_BASELINE_RATIO=0.95
  },
): PriceRaiseSignal;
```

### 4.2 Scam heuristic logic

```
peak14d     = max(observations in last 14d, excluding today's observations)
baseline30d = min(observations in window [30d ago, 14d ago])   // before the spike

if peak14d == null OR baseline30d == null:
  → suspicious = false (not enough data to accuse)

peakRatio    = peak14d / baseline30d
currentRatio = current / baseline30d

suspicious = (peakRatio >= 1.20) AND (currentRatio >= 0.95)
```

**Why both conditions:** the first detects the spike; the second ensures the "discount" did not actually drop the price below the pre-spike baseline. A genuine drop (current < baseline * 0.95) is not penalized even if there was a recent spike.

### 4.3 Trend

Compare `median7d` vs `median14d`:
- `m7 < m14 * 0.95` → `falling`
- `m7 > m14 * 1.05` → `rising`
- otherwise → `flat`
- either side null → `unknown`

`trend` is informational only in v1 (not a score factor). The `price_raise_before_discount` penalty stands on its own. `trend` is surfaced in logs to aid manual tuning and may become a weighted factor in a later iteration.

### 4.4 CurationService changes

New public methods (do not break existing API):
- `getObservations(catalogId): PriceObservation[]` — read-only snapshot
- `getAnalytics(catalogId): PriceAnalytics` — wraps `analyze()` over stored observations
- `isFakeDiscount` and `getLowestPriceBadge` — unchanged

---

## 5. Pipeline + scheduler

### 5.1 PipelineService

New public methods:

```typescript
async collectScored(
  category: string,
  opts: { minDiscount: number; enrichTopN: number },
): Promise<ScoredDeal[]>;

async dispatchScored(
  scored: ScoredDeal[],
  max: number,
): Promise<{ sent: number; failed: number; topScore: number | null }>;
```

`collectScored` order:
1. `ml.getDealsFromHighlights({ category, minDiscount, max: enrichTopN * 3 })`
2. For each raw deal:
   - `curation.record(catalogId, priceCents)` (always)
   - `dedup.wasRecentlyPosted` → skip
   - `curation.isFakeDiscount` → skip
3. `prescore` survivors with available fields only, take top `DEAL_ENRICH_TOP_N`. `prescore` is a cheap subset of the full rubric using only the fields already loaded (`discount_percent`, `below_median_30d`, `lowest_price_*`, `free_shipping`, `discount_from_original_only`, `insufficient_history`, `current_above_median_30d`). It exists to budget enrichment calls, not to decide publishability — the full `dealScore.compute` runs after enrichment and is the only score used for filtering and ranking.
4. `enrichment.enrichMany` (parallel, respects existing `PARALLEL_LIMIT=6`)
5. `dealScore.compute` per enriched deal, using `curation.getAnalytics`
6. Filter `score >= DEAL_SCORE_MIN`
7. Return sorted desc

`dispatchScored`:
- Re-sort desc (defensive)
- Slice `max`
- For each: formatter → wa.send → `dedup.markPosted` (only on send success)
- 2s sleep between sends (existing pattern)
- Log explainability (level, score, top reasons) per dispatch

`runOnce({category})` (legacy):
- Calls `collectScored` + `dispatchScored(result, MAX_DEALS_PER_RUN)`
- Preserved for ad-hoc invocation / tests.

### 5.2 SchedulerService

Default `SCHEDULER_MODE=legacy` keeps current behavior (1 category per tick via rotator). Opt-in `SCHEDULER_MODE=batch`:

```typescript
@Cron(...)
async tick() {
  // ... quiet hours + enabled checks unchanged
  const mode = config.get('SCHEDULER_MODE', 'legacy');

  if (mode === 'batch') {
    const categories = rotator.getWeighted();
    const allScored: ScoredDeal[] = [];
    for (const { category } of categories) {
      try {
        const scored = await pipeline.collectScored(category, {...});
        allScored.push(...scored);
      } catch (err) { logger.error(...); }
    }
    allScored.sort((a, b) => b.score - a.score);
    await pipeline.dispatchScored(allScored, MAX_DEALS_PER_RUN);
    return;
  }

  // legacy path (current code, unchanged)
  const category = rotator.pick();
  ...
}
```

### 5.3 CategoryRotatorService

New method `getWeighted(): {category, weight}[]` returns the parsed weights as-is. `pick()` preserved.

---

## 6. Message templates by level

Single image+caption send (existing pattern). 3 templates selected by `ScoredDeal.level`.

### 6.1 Imperdível (super)

```
🚨 PROMOÇÃO IMPERDÍVEL
[Hook generated by Groq]

📦 [Title]

💰 *R$ 749,00* (-25%)
💳 12x R$ 62,42 sem juros
🚚 Frete grátis

📉 Menor preço dos últimos 30 dias
✅ Loja oficial · MercadoLíder Platinum · 4.8★

🛒 [affiliate link]
```

### 6.2 Top (top)

```
🔥 PROMOÇÃO TOP
[Hook]

📦 [Title]
💰 *R$ 749,00* (-18%)
💳 10x sem juros · 🚚 frete grátis

📉 22% abaixo da mediana de 30 dias

🛒 [link]
```

### 6.3 Boa (good)

```
💸 Promoção
[Hook]

📦 [Title]
💰 *R$ 749,00* (-15%)
🚚 Frete grátis

🛒 [link]
```

### 6.4 Rendering rules

- **History bullet:** prefer `📉 Menor preço em Xd` if any window matched; otherwise `📉 Y% abaixo da mediana de 30 dias`. Never both.
- **Seller bullet:** only if enrichment returned `official_store_id` OR a known `power_seller_status`. Otherwise omit.
- **Installments line:** only if item exposes parcelas sem juros.
- **PIX badge:** omit initially. Add when an ML field for PIX-specific pricing is confirmed.
- **Penalties never appear in the WhatsApp message** — they only go to logs.
- **Insufficient history clamp** (already applied at level computation): level cannot be `super` without enough history; templates therefore stay honest.

---

## 7. Environment variables

### 7.1 New

```bash
# Score gates
DEAL_SCORE_MIN=75
DEAL_SCORE_TOP=90
DEAL_SCORE_SUPER=95
MAX_DEALS_PER_RUN=3

# Enrich budget
DEAL_ENRICH_TOP_N=10
SELLER_CACHE_TTL_HOURS=24
SELLER_CACHE_FILE=./data/seller-cache.json

# History gates
DEAL_SCORE_INSUFFICIENT_HISTORY_PENALTY=25
DEAL_SCORE_MIN_DISCOUNT_NO_HISTORY=40

# Price-raise heuristic
PRICE_RAISE_PEAK_WINDOW_DAYS=14
PRICE_RAISE_BASELINE_WINDOW_DAYS=30
PRICE_RAISE_PEAK_RATIO=1.20
PRICE_RAISE_CURRENT_BASELINE_RATIO=0.95

# Scheduler mode
SCHEDULER_MODE=legacy            # opt-in 'batch' after rollout

# Score weights (optional — defaults from rubric)
DEAL_SCORE_W_DISCOUNT_MAX=20
DEAL_SCORE_W_BELOW_MEDIAN_MAX=25
DEAL_SCORE_W_LOWEST_30D=15
DEAL_SCORE_W_LOWEST_14D=10
DEAL_SCORE_W_LOWEST_7D=5
DEAL_SCORE_W_OFFICIAL_STORE=10
DEAL_SCORE_W_SELLER_REPUTATION_MAX=10
DEAL_SCORE_W_FREE_SHIPPING=5
DEAL_SCORE_W_INSTALLMENTS_NO_INTEREST=5
DEAL_SCORE_W_HIGH_SOLD_QTY_MAX=5
DEAL_SCORE_W_PRICE_STABILITY=5
DEAL_SCORE_W_PRICE_RAISE_PENALTY=30
DEAL_SCORE_W_USED_PENALTY=15
DEAL_SCORE_W_DISCOUNT_FROM_ORIGINAL_ONLY=10
DEAL_SCORE_W_ABOVE_MEDIAN_PENALTY=10
DEAL_SCORE_W_UNKNOWN_SELLER=5
```

### 7.2 Preserved

```bash
ML_MIN_DISCOUNT=25                # floor for the pre-score stage
CURATION_DISCOUNT_THRESHOLD=0.85  # hard gate, retained
CURATION_MIN_HISTORY_DAYS=7
CURATION_REQUIRE_HISTORY=false    # safe default for cold-start
DEDUP_WINDOW_DAYS=7
```

### 7.3 Production rollout phases

| Phase | Trigger | Settings |
|---|---|---|
| Phase 1 (cold) | week 1–2 | `DEAL_SCORE_MIN=70`, `MAX_DEALS_PER_RUN=2`, `CURATION_REQUIRE_HISTORY=false`, `SCHEDULER_MODE=legacy` |
| Phase 2 (warming) | 14d history in 50+ catalogIds | `DEAL_SCORE_MIN=75`, `MAX_DEALS_PER_RUN=3`, `SCHEDULER_MODE=batch` |
| Phase 3 (premium) | 30d+ broad history | `CURATION_REQUIRE_HISTORY=true`, `DEAL_SCORE_MIN=80`, tune weights from observed distribution |

---

## 8. Testing

Jest + ts-jest, focus on pure functions.

### 8.1 New specs

```
src/deal-score/price-analytics.spec.ts
  - analyze() empty history → all nulls
  - analyze() single observation → median/min equal observation
  - analyze() 30d varied history → correct medians/mins
  - distinctDays counts unique UTC dates
  - trend rising/falling/flat/unknown
  - detectPriceRaiseBeforeDiscount classic scam case → suspicious=true
  - detectPriceRaiseBeforeDiscount genuine drop (current < baseline*0.95) → suspicious=false
  - detectPriceRaiseBeforeDiscount missing data → suspicious=false

src/deal-score/deal-score.service.spec.ts
  - score=0 floor with all bad factors
  - score clamped [0, 100]
  - level=rejected below DEAL_SCORE_MIN
  - level=super only with sufficient history
  - level clamped to top when history insufficient even at score=98
  - reasons populated with positive factors only, sorted by weight desc
  - penalties populated separately
  - factors map sums to rawScore
  - reasons carry pt-BR messages matching templates

src/enrichment/seller-cache.service.spec.ts
  - get within TTL returns cached value
  - get after TTL returns null
  - set persists via tmp+rename
  - corrupted file → starts empty without throwing

src/enrichment/enrichment.service.spec.ts
  - enrich uses cache when valid
  - enrich fetches /users/{id} on cache miss
  - enrich 404 on seller → returns deal without seller info (no throw)
  - enrich 5xx → propagates (caller decides)

src/pipeline/pipeline.service.spec.ts
  - record() called BEFORE dedup AND BEFORE isFakeDiscount
  - dedup skip does not skip record
  - isFakeDiscount skip does not skip record
  - prescore filters before enrich (enrichMany not invoked for dropped deals)
  - filter < DEAL_SCORE_MIN drops the deal
  - dispatchScored sorts desc and respects max
  - markPosted only after successful send
```

### 8.2 Modify existing

```
src/curation/curation.service.spec.ts (create if absent)
  - getAnalytics returns correct PriceAnalytics
  - isFakeDiscount unchanged (regression guard)
  - getLowestPriceBadge unchanged (regression guard)
```

### 8.3 Fixtures

`src/deal-score/__fixtures__/`:
- `history-empty.ts`
- `history-30d-stable.ts`
- `history-classic-trap.ts` — 100 → 150 → 120 timeline
- `history-genuine-drop.ts` — 100 → 90 → 80 timeline
- `enriched-deal-official-store.ts`
- `enriched-deal-unknown-seller.ts`

### 8.4 Not tested (YAGNI)

- Real WhatsApp send (already mocked elsewhere)
- Groq headline (isolated by port)
- Affiliate resolver (isolated by port)
- Real ML API (mock HttpService)

---

## 9. Risks

| Risk | Mitigation |
|---|---|
| Rate limit on ML after extra enrich calls | Seller cached 24h, enrich only top-N, `PARALLEL_LIMIT=6` preserved, existing `withRetry` |
| Weights arbitrary without calibration data | Conservative defaults phase 1, all env-overrideable, log explainability enables tuning |
| Sparse history → unfair score for new products | `insufficientHistory=-25` + level cap `top` + gate `MIN_DISCOUNT_NO_HISTORY=40` |
| False negatives (good deal filtered) | Phase 1 `DEAL_SCORE_MIN=70` more permissive; dispatch logs include rejected-deal scores for audit |
| False positives (bad deal sent) | Phase 3 enables `REQUIRE_HISTORY=true`; `isFakeDiscount` hard gate always on |
| Scam heuristic fails on legitimate Black Friday seasonal pricing | Pre-window baseline (30→14d) excludes the spike window, so a real seasonal drop below the older baseline is not penalized |
| Scheduler change breaks cron | `SCHEDULER_MODE=legacy` is default; batch mode opt-in via env |
| Corrupted seller cache | Try/catch on load, fallback empty store, same pattern as price-history |
| Seller cache disk usage | TTL 24h + prune on load; ~5KB per seller × ~500 sellers ≈ 2.5MB ceiling |
| Score volatility between runs | Pure deterministic given same history + enrichment; history changes gradually |

---

## 10. Migration plan (incremental, no big-bang)

| PR | Scope | Behavior change? |
|---|---|---|
| PR 1 | `price-analytics.ts` + `CurationService.getAnalytics` + specs | None (read-only addition) |
| PR 2 | `seller-cache.service.ts` + `enrichment.service.ts` + types + specs | None (not wired into pipeline yet) |
| PR 3 | `deal-score.service.ts` + types + specs | None (not wired yet) |
| PR 4 | Pipeline refactor: fix record order, add `collectScored` + `dispatchScored`. `runOnce` becomes a wrapper. | **Fixes the existing P0 bug** (record now before dedup). Scoring still inactive (legacy path bypasses dealScore). |
| PR 5 | Formatter accepts `ScoredDeal`, 3 templates by level + specs | None until scoring activates |
| PR 6 | Scheduler batch mode opt-in via `SCHEDULER_MODE=batch`, `CategoryRotator.getWeighted` | Default still legacy |
| PR 7 | Cutover: `SCHEDULER_MODE=batch` default; tune `DEAL_SCORE_MIN` based on observed data | Activates full new pipeline |

---

## 11. Next steps post-implementation

- Prometheus metrics: `deal_score_distribution`, `deal_level_count`, `enrich_cache_hit_rate`, `price_raise_detected_total`
- Simple dashboard: % runs that sent, mean score sent, mean score rejected
- Manual feedback loop: tag dispatched deals as good/bad in a local file → adjust weights
- Investigate an alternative price-of-truth source (Buscapé scraping?) — separate project
- A/B test template wording variants for `super`/`top`

---

## 12. Sample log output

```
[Pipeline] collectScored MLB1051 — raw=24 afterDedup=18 afterCuration=15 preTopN=10 enriched=10 scored=10 passing=4
[DealScore] MLB123456 score=92 level=top reasons=[lowest_price_14d, below_median_30d, official_store, free_shipping] penalties=[]
[DealScore] MLB789012 score=58 level=rejected reasons=[discount_percent, free_shipping] penalties=[insufficient_history, price_raise_before_discount]
[Scheduler] tick batch — categories=4 totalScored=12 dispatched=3 topScore=94 lowestSentScore=87
[Pipeline] dispatch MLB123456 → WA sent ok (level=top, score=92)
```

---

## 13. Acceptance criteria

- `curation.record(catalogId, priceCents)` is called **before** `dedup.wasRecentlyPosted` and `curation.isFakeDiscount` for every raw deal with a valid `catalogId` and price.
- `DealScore` produces a deterministic score in `[0, 100]` given the same `EnrichedDeal` + `PriceAnalytics`.
- A deal with `score < DEAL_SCORE_MIN` is never dispatched.
- A deal with `distinctDays < CURATION_MIN_HISTORY_DAYS` is never labelled `super`.
- A deal matching the `priceRaiseBeforeDiscount` heuristic incurs the configured penalty and surfaces in the log under `penalties`.
- `SCHEDULER_MODE=legacy` preserves current behavior (verified by existing tests passing).
- `SCHEDULER_MODE=batch` collects across all `CATEGORY_WEIGHTS` entries and dispatches at most `MAX_DEALS_PER_RUN` per tick.
- `getLowestPriceBadge`, `isFakeDiscount`, and the existing pre-fetch flow continue to function unchanged.
- New unit tests pass; existing unit tests continue to pass.
