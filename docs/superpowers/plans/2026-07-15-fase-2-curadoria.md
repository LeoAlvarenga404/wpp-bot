# Fase 2 — Curadoria Confiável Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auditoria completa de decisões de curadoria (`CurationDecision`), price-raise como bloqueio duro, juiz LLM DeepSeek fail-closed na zona cinza, e copy A/B com registro de variante.

**Architecture:** Novo `CurationGateService` (em `src/curation/`) concentra todas as decisões de publicar/rejeitar e grava cada uma via upsert `(catalogId, stage, day)`. Juiz é port (`DEAL_JUDGE`) + adapter DeepSeek (OpenAI-compatible), com cache de veredito in-memory e fallback noop-reject sem API key. `PipelineService` delega ao gate; variante A/B flui `gate → SendDealJob → worker → FormatterService/SentMessage`.

**Tech Stack:** NestJS 10, Prisma 6.19.3 (pinado — NÃO subir para 7), BullMQ, jest (specs planos com fakes manuais, sem TestingModule), fetch nativo Node 22.

**Spec:** `docs/superpowers/specs/2026-07-15-fase-2-curadoria-design.md`

## Global Constraints

- Prisma pinado em 6.19.3; migrations hand-authored + validadas com `prisma migrate diff`.
- `stage`/`outcome` são `TEXT`, nunca enum Prisma (novo estágio sem migration).
- Sem FK de `CurationDecision` para `Product` (catalogId aparece antes do Product).
- Juiz é fail-closed: qualquer erro/timeout/JSON inválido → NÃO posta.
- `day` calculado em `America/Sao_Paulo` (env `TZ`), formato `YYYY-MM-DD`.
- Escrita de decisão nunca derruba o pipeline (try/catch + `logger.error`).
- Copy dos templates em pt-BR; estilo dos existentes (`template-good.ts`).
- Specs: jest puro, instanciação manual, config stub `{ get: (k, d) => overrides[k] ?? d }` (padrão de `curation.service.spec.ts`).
- Commits: Conventional Commits; terminar mensagem com `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Testes de arquivo: `npx jest <path> --silent`. Build: `npm run build`.

---

### Task 1: Migration — CurationDecision + SentMessage.variant

**Files:**
- Modify: `prisma/schema.prisma` (após model `SentMessage`, ~linha 60)
- Create: `prisma/migrations/20260715120000_add_curation_decision/migration.sql`

**Interfaces:**
- Produces: tabela `CurationDecision` com unique `(catalogId, stage, day)`; coluna `SentMessage.variant TEXT NULL`. Client Prisma regenerado com `prisma.curationDecision`.

- [ ] **Step 1: Adicionar model ao schema**

Em `prisma/schema.prisma`, adicionar `variant String?` ao model `SentMessage` (após `caption String`) e o novo model após `SentMessage`:

```prisma
// Curation decision audit (Fase 2). One row per (catalogId, stage, day) —
// repeated rejections on the */1 cron only bump `count`. stage/outcome are
// strings, not enums, so a new stage doesn't require a migration (same
// rationale as WaTarget.channel). No FK to Product — see PriceHistory note.
model CurationDecision {
  id           BigInt   @id @default(autoincrement())
  catalogId    String
  stage        String
  outcome      String
  day          String
  count        Int      @default(1)
  score        Int?
  priceCents   Int?
  reasons      Json?
  judgeVerdict Json?
  variant      String?
  firstAt      DateTime @default(now())
  lastAt       DateTime @updatedAt

  @@unique([catalogId, stage, day])
  @@index([day, stage])
}
```

- [ ] **Step 2: Escrever migration SQL hand-authored**

`prisma/migrations/20260715120000_add_curation_decision/migration.sql`:

```sql
-- Curation decision audit (Fase 2). One row per (catalogId, stage, day);
-- repeats increment "count". stage/outcome are TEXT, not enums, so new
-- stages don't require another migration.
CREATE TABLE "CurationDecision" (
    "id" BIGSERIAL NOT NULL,
    "catalogId" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,
    "score" INTEGER,
    "priceCents" INTEGER,
    "reasons" JSONB,
    "judgeVerdict" JSONB,
    "variant" TEXT,
    "firstAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CurationDecision_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CurationDecision_catalogId_stage_day_key"
    ON "CurationDecision"("catalogId", "stage", "day");

CREATE INDEX "CurationDecision_day_stage_idx"
    ON "CurationDecision"("day", "stage");

-- Copy A/B variant on the send audit row.
ALTER TABLE "SentMessage" ADD COLUMN "variant" TEXT;
```

- [ ] **Step 3: Validar migration contra o schema**

Run:
```bash
npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url "postgresql://wppbot:changeme@localhost:5433/wppbot_shadow"
```
Expected: `No difference detected.` (Postgres do compose precisa estar de pé: `docker compose up -d postgres`; host usa porta 5433.)

- [ ] **Step 4: Regenerar client**

Run: `npx prisma generate`
Expected: `Generated Prisma Client` sem erros.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260715120000_add_curation_decision/
git commit -m "feat(db): CurationDecision audit table + SentMessage.variant"
```

---

### Task 2: Day util + CurationDecisionRepo

**Files:**
- Create: `src/shared/day.ts`
- Create: `src/shared/day.spec.ts`
- Create: `src/curation/curation-decision.repo.ts`
- Create: `src/curation/curation-decision.repo.spec.ts`

**Interfaces:**
- Consumes: tabela `CurationDecision` (Task 1), `PrismaService` (`src/db/prisma.service.ts`).
- Produces:
  - `dayString(d: Date, tz: string): string` — `YYYY-MM-DD` no fuso dado.
  - `CURATION_DECISION_REPO: symbol`
  - `interface DecisionUpsert { catalogId: string; stage: string; outcome: 'rejected' | 'approved' | 'posted'; day: string; score?: number; priceCents?: number; reasons?: unknown; judgeVerdict?: unknown; variant?: string }`
  - `interface CurationDecisionRepo { upsert(d: DecisionUpsert): Promise<void>; pruneOlderThan(cutoff: Date): Promise<number> }`
  - `class PrismaCurationDecisionRepo implements CurationDecisionRepo`

- [ ] **Step 1: Teste do dayString (falhando)**

`src/shared/day.spec.ts`:

```ts
import { dayString } from './day';

describe('dayString', () => {
  it('formats YYYY-MM-DD in the given timezone', () => {
    // 2026-07-15T01:30Z = 2026-07-14 22:30 em São Paulo (UTC-3)
    const d = new Date('2026-07-15T01:30:00Z');
    expect(dayString(d, 'America/Sao_Paulo')).toBe('2026-07-14');
    expect(dayString(d, 'UTC')).toBe('2026-07-15');
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx jest src/shared/day.spec.ts --silent`
Expected: FAIL — `Cannot find module './day'`

- [ ] **Step 3: Implementar**

`src/shared/day.ts`:

```ts
/** Calendar day (YYYY-MM-DD) of `d` in timezone `tz`. 'en-CA' locale emits ISO order. */
export function dayString(d: Date, tz: string): string {
  return d.toLocaleDateString('en-CA', { timeZone: tz });
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx jest src/shared/day.spec.ts --silent`
Expected: PASS

- [ ] **Step 5: Teste do repo (falhando)**

`src/curation/curation-decision.repo.spec.ts`:

```ts
import { PrismaCurationDecisionRepo } from './curation-decision.repo';

function makePrisma() {
  return {
    curationDecision: {
      upsert: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 3 }),
    },
  };
}

describe('PrismaCurationDecisionRepo', () => {
  it('upserts on (catalogId, stage, day) and increments count on update', async () => {
    const prisma = makePrisma();
    const repo = new PrismaCurationDecisionRepo(prisma as any);

    await repo.upsert({
      catalogId: 'ml:MLB1',
      stage: 'fake_discount',
      outcome: 'rejected',
      day: '2026-07-15',
      priceCents: 9990,
    });

    expect(prisma.curationDecision.upsert).toHaveBeenCalledWith({
      where: {
        catalogId_stage_day: {
          catalogId: 'ml:MLB1',
          stage: 'fake_discount',
          day: '2026-07-15',
        },
      },
      create: expect.objectContaining({
        catalogId: 'ml:MLB1',
        stage: 'fake_discount',
        outcome: 'rejected',
        day: '2026-07-15',
        priceCents: 9990,
      }),
      update: expect.objectContaining({
        count: { increment: 1 },
        outcome: 'rejected',
        priceCents: 9990,
      }),
    });
  });

  it('prunes rows older than cutoff by firstAt', async () => {
    const prisma = makePrisma();
    const repo = new PrismaCurationDecisionRepo(prisma as any);
    const cutoff = new Date('2026-05-16T00:00:00Z');

    const n = await repo.pruneOlderThan(cutoff);

    expect(n).toBe(3);
    expect(prisma.curationDecision.deleteMany).toHaveBeenCalledWith({
      where: { firstAt: { lt: cutoff } },
    });
  });
});
```

- [ ] **Step 6: Rodar e ver falhar**

Run: `npx jest src/curation/curation-decision.repo.spec.ts --silent`
Expected: FAIL — `Cannot find module './curation-decision.repo'`

- [ ] **Step 7: Implementar repo**

`src/curation/curation-decision.repo.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../db/prisma.service';

export const CURATION_DECISION_REPO = Symbol('CURATION_DECISION_REPO');

export interface DecisionUpsert {
  catalogId: string;
  stage: string;
  outcome: 'rejected' | 'approved' | 'posted';
  day: string;
  score?: number;
  priceCents?: number;
  reasons?: unknown;
  judgeVerdict?: unknown;
  variant?: string;
}

export interface CurationDecisionRepo {
  upsert(d: DecisionUpsert): Promise<void>;
  pruneOlderThan(cutoff: Date): Promise<number>;
}

@Injectable()
export class PrismaCurationDecisionRepo implements CurationDecisionRepo {
  constructor(private readonly prisma: PrismaService) {}

  async upsert(d: DecisionUpsert): Promise<void> {
    const fields = {
      outcome: d.outcome,
      score: d.score ?? null,
      priceCents: d.priceCents ?? null,
      reasons: (d.reasons as any) ?? undefined,
      judgeVerdict: (d.judgeVerdict as any) ?? undefined,
      variant: d.variant ?? null,
    };
    await (this.prisma as any).curationDecision.upsert({
      where: {
        catalogId_stage_day: {
          catalogId: d.catalogId,
          stage: d.stage,
          day: d.day,
        },
      },
      create: { catalogId: d.catalogId, stage: d.stage, day: d.day, ...fields },
      update: { count: { increment: 1 }, ...fields },
    });
  }

  async pruneOlderThan(cutoff: Date): Promise<number> {
    const res = await (this.prisma as any).curationDecision.deleteMany({
      where: { firstAt: { lt: cutoff } },
    });
    return res.count as number;
  }
}
```

- [ ] **Step 8: Rodar e ver passar**

Run: `npx jest src/curation/curation-decision.repo.spec.ts src/shared/day.spec.ts --silent`
Expected: PASS (ambos)

- [ ] **Step 9: Commit**

```bash
git add src/shared/day.ts src/shared/day.spec.ts src/curation/curation-decision.repo.ts src/curation/curation-decision.repo.spec.ts
git commit -m "feat(curation): CurationDecision repo with daily upsert + day util"
```

---

### Task 3: Judge port, input builder, noop-reject e cache de veredito

**Files:**
- Create: `src/judge/judge.port.ts`
- Create: `src/judge/judge-input.ts`
- Create: `src/judge/judge-input.spec.ts`
- Create: `src/judge/noop-judge.adapter.ts`
- Create: `src/judge/verdict-cache.ts`
- Create: `src/judge/verdict-cache.spec.ts`

**Interfaces:**
- Consumes: `ScoredDeal`, `PriceAnalytics` (`src/deal-score/types.ts`), `EnrichedDeal` (`src/sources/source.port.ts`).
- Produces:
  - `DEAL_JUDGE: symbol`
  - `interface JudgeVerdict { approve: boolean; confidence: number; reason: string }`
  - `interface JudgeInput` (campos abaixo)
  - `interface DealJudge { judge(input: JudgeInput): Promise<JudgeVerdict> }`
  - `buildJudgeInput(sd: ScoredDeal, analytics: PriceAnalytics): JudgeInput`
  - `class NoopJudge implements DealJudge` — sempre rejeita
  - `class JudgeVerdictCache` — `get(catalogId, priceCents, now?)`, `set(catalogId, priceCents, verdict, now?)`

- [ ] **Step 1: Port (sem teste — só tipos)**

`src/judge/judge.port.ts`:

```ts
export const DEAL_JUDGE = Symbol('DEAL_JUDGE');

export interface JudgeVerdict {
  approve: boolean;
  confidence: number; // 0..1
  reason: string; // 1 frase — persiste em CurationDecision.judgeVerdict
}

export interface JudgeInput {
  title: string;
  priceCents: number;
  originalPriceCents: number | null;
  discountPercent: number;
  condition: string;
  score: number;
  level: string;
  reasons: string[];
  penalties: string[];
  priceRaiseSuspicious: boolean;
  analytics: {
    median30d: number | null;
    min30d: number | null;
    min14d: number | null;
    min7d: number | null;
    distinctDays: number;
    trend: string;
  };
  seller: {
    trust: string;
    isVerifiedStore: boolean;
    displayName: string | null;
  } | null;
  volumeTier: string;
}

export interface DealJudge {
  judge(input: JudgeInput): Promise<JudgeVerdict>;
}
```

- [ ] **Step 2: Teste do buildJudgeInput (falhando)**

`src/judge/judge-input.spec.ts`:

```ts
import type { PriceAnalytics, ScoredDeal } from '../deal-score/types';
import { buildJudgeInput } from './judge-input';

const analytics: PriceAnalytics = {
  median7d: 10000,
  median14d: 10500,
  median30d: 11000,
  min7d: 9800,
  min14d: 9500,
  min30d: 9000,
  distinctDays: 12,
  lastObservedBefore: null,
  trend: 'falling',
};

function makeScored(overrides: Partial<ScoredDeal> = {}): ScoredDeal {
  return {
    deal: {
      key: { source: 'ml', externalId: 'MLB1' },
      source: 'ml',
      raw: {
        key: { source: 'ml', externalId: 'MLB1' },
        title: 'Fone Bluetooth XYZ',
        priceCents: 8990,
        originalPriceCents: 14990,
        discountPercent: 40,
        thumbnail: '',
        permalink: 'https://ml/p',
        feedId: 'f1',
      },
      seller: {
        externalSellerId: 's1',
        displayName: 'Loja XYZ',
        sellerTrust: 'high',
        isVerifiedStore: true,
        ratingAverage: 4.8,
        fetchedAt: '2026-07-15T00:00:00Z',
      },
      condition: 'new',
      signals: {
        freeShipping: true,
        installmentsNoInterest: false,
        volumeTier: 'high',
        isVerifiedStore: true,
      },
      extras: {},
    },
    score: 82,
    rawScore: 82,
    level: 'good',
    reasons: [{ code: 'discount_percent', weight: 12, message: 'Desconto de 40%' }],
    penalties: [],
    factors: { discount_percent: 12 },
    ...overrides,
  } as ScoredDeal;
}

describe('buildJudgeInput', () => {
  it('maps deal, analytics, seller and reason messages', () => {
    const input = buildJudgeInput(makeScored(), analytics);
    expect(input.title).toBe('Fone Bluetooth XYZ');
    expect(input.priceCents).toBe(8990);
    expect(input.score).toBe(82);
    expect(input.reasons).toEqual(['Desconto de 40%']);
    expect(input.analytics.median30d).toBe(11000);
    expect(input.seller).toEqual({
      trust: 'high',
      isVerifiedStore: true,
      displayName: 'Loja XYZ',
    });
    expect(input.priceRaiseSuspicious).toBe(false);
  });

  it('flags price raise when factor present and handles null seller', () => {
    const sd = makeScored({
      factors: { price_raise_before_discount: -30 },
    });
    (sd.deal as any).seller = null;
    const input = buildJudgeInput(sd, analytics);
    expect(input.priceRaiseSuspicious).toBe(true);
    expect(input.seller).toBeNull();
  });
});
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `npx jest src/judge/judge-input.spec.ts --silent`
Expected: FAIL — `Cannot find module './judge-input'`

- [ ] **Step 4: Implementar builder + noop**

`src/judge/judge-input.ts`:

```ts
import type { PriceAnalytics, ScoredDeal } from '../deal-score/types';
import type { JudgeInput } from './judge.port';

export function buildJudgeInput(
  sd: ScoredDeal,
  analytics: PriceAnalytics,
): JudgeInput {
  const raw = sd.deal.raw;
  return {
    title: raw.title,
    priceCents: raw.priceCents,
    originalPriceCents: raw.originalPriceCents,
    discountPercent: raw.discountPercent,
    condition: sd.deal.condition,
    score: sd.score,
    level: sd.level,
    reasons: sd.reasons.map((r) => r.message),
    penalties: sd.penalties.map((p) => p.message),
    priceRaiseSuspicious: 'price_raise_before_discount' in sd.factors,
    analytics: {
      median30d: analytics.median30d,
      min30d: analytics.min30d,
      min14d: analytics.min14d,
      min7d: analytics.min7d,
      distinctDays: analytics.distinctDays,
      trend: analytics.trend,
    },
    seller: sd.deal.seller
      ? {
          trust: sd.deal.seller.sellerTrust,
          isVerifiedStore: sd.deal.seller.isVerifiedStore,
          displayName: sd.deal.seller.displayName,
        }
      : null,
    volumeTier: sd.deal.signals.volumeTier,
  };
}
```

`src/judge/noop-judge.adapter.ts`:

```ts
import { Injectable } from '@nestjs/common';
import type { DealJudge, JudgeVerdict } from './judge.port';

/** Active when DEEPSEEK_API_KEY is missing: gray zone rejects by design. */
@Injectable()
export class NoopJudge implements DealJudge {
  async judge(): Promise<JudgeVerdict> {
    return {
      approve: false,
      confidence: 1,
      reason: 'judge disabled — DEEPSEEK_API_KEY missing',
    };
  }
}
```

- [ ] **Step 5: Rodar e ver passar**

Run: `npx jest src/judge/judge-input.spec.ts --silent`
Expected: PASS

- [ ] **Step 6: Teste do cache (falhando)**

`src/judge/verdict-cache.spec.ts`:

```ts
import { JudgeVerdictCache } from './verdict-cache';
import type { JudgeVerdict } from './judge.port';

const v: JudgeVerdict = { approve: true, confidence: 0.9, reason: 'ok' };

describe('JudgeVerdictCache', () => {
  it('returns cached verdict within TTL and same price', () => {
    const cache = new JudgeVerdictCache();
    cache.set('ml:MLB1', 10000, v, 1_000);
    expect(cache.get('ml:MLB1', 10000, 2_000)).toEqual(v);
  });

  it('misses after TTL', () => {
    const cache = new JudgeVerdictCache(1000);
    cache.set('ml:MLB1', 10000, v, 1_000);
    expect(cache.get('ml:MLB1', 10000, 2_500)).toBeNull();
  });

  it('invalidates when price moves more than 2%', () => {
    const cache = new JudgeVerdictCache();
    cache.set('ml:MLB1', 10000, v, 1_000);
    expect(cache.get('ml:MLB1', 10300, 1_500)).toBeNull(); // +3%
    expect(cache.get('ml:MLB1', 10000, 1_500)).toBeNull(); // invalidado acima
  });

  it('evicts oldest entry beyond maxEntries', () => {
    const cache = new JudgeVerdictCache(60_000, 2);
    cache.set('a', 100, v, 1);
    cache.set('b', 100, v, 2);
    cache.set('c', 100, v, 3);
    expect(cache.get('a', 100, 4)).toBeNull();
    expect(cache.get('c', 100, 4)).toEqual(v);
  });
});
```

- [ ] **Step 7: Rodar e ver falhar**

Run: `npx jest src/judge/verdict-cache.spec.ts --silent`
Expected: FAIL — `Cannot find module './verdict-cache'`

- [ ] **Step 8: Implementar cache**

`src/judge/verdict-cache.ts`:

```ts
import { Injectable } from '@nestjs/common';
import type { JudgeVerdict } from './judge.port';

interface Entry {
  verdict: JudgeVerdict;
  priceCents: number;
  at: number;
}

/**
 * In-memory verdict cache: a gray-zone deal recurring on every tick doesn't
 * pay one LLM call per tick. Invalidated by TTL or price drift > 2%.
 * Insertion-ordered Map => first key is the oldest (eviction).
 */
@Injectable()
export class JudgeVerdictCache {
  private readonly map = new Map<string, Entry>();

  constructor(
    private readonly ttlMs = 6 * 60 * 60 * 1000,
    private readonly maxEntries = 500,
    private readonly maxPriceDrift = 0.02,
  ) {}

  get(catalogId: string, priceCents: number, now = Date.now()): JudgeVerdict | null {
    const e = this.map.get(catalogId);
    if (!e) return null;
    if (now - e.at > this.ttlMs) {
      this.map.delete(catalogId);
      return null;
    }
    if (
      e.priceCents > 0 &&
      Math.abs(priceCents - e.priceCents) / e.priceCents > this.maxPriceDrift
    ) {
      this.map.delete(catalogId);
      return null;
    }
    return e.verdict;
  }

  set(
    catalogId: string,
    priceCents: number,
    verdict: JudgeVerdict,
    now = Date.now(),
  ): void {
    if (this.map.size >= this.maxEntries && !this.map.has(catalogId)) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(catalogId, { verdict, priceCents, at: now });
  }
}
```

- [ ] **Step 9: Rodar e ver passar**

Run: `npx jest src/judge --silent`
Expected: PASS (judge-input + verdict-cache)

- [ ] **Step 10: Commit**

```bash
git add src/judge/
git commit -m "feat(judge): DealJudge port, input builder, noop-reject, verdict cache"
```

---

### Task 4: DeepSeekJudgeAdapter + JudgeModule

**Files:**
- Create: `src/judge/deepseek-judge.adapter.ts`
- Create: `src/judge/deepseek-judge.adapter.spec.ts`
- Create: `src/judge/judge.module.ts`
- Modify: `.env.example` (bloco `DeepSeek LLM judge (Fase 2)`)

**Interfaces:**
- Consumes: `DealJudge`, `JudgeInput`, `JudgeVerdict` (Task 3), `ConfigService`.
- Produces: `class DeepSeekJudgeAdapter implements DealJudge` — **lança** em qualquer falha (caller é fail-closed); `JudgeModule` exportando `DEAL_JUDGE` (factory: key presente → DeepSeek, ausente → NoopJudge) e `JudgeVerdictCache`.

- [ ] **Step 1: Teste do adapter (falhando)**

`src/judge/deepseek-judge.adapter.spec.ts`:

```ts
import { ConfigService } from '@nestjs/config';
import { DeepSeekJudgeAdapter } from './deepseek-judge.adapter';
import type { JudgeInput } from './judge.port';

const input: JudgeInput = {
  title: 'Fone XYZ',
  priceCents: 8990,
  originalPriceCents: 14990,
  discountPercent: 40,
  condition: 'new',
  score: 82,
  level: 'good',
  reasons: ['Desconto de 40%'],
  penalties: [],
  priceRaiseSuspicious: false,
  analytics: {
    median30d: 11000,
    min30d: 9000,
    min14d: 9500,
    min7d: 9800,
    distinctDays: 12,
    trend: 'falling',
  },
  seller: { trust: 'high', isVerifiedStore: true, displayName: 'Loja' },
  volumeTier: 'high',
};

function makeAdapter(overrides: Record<string, string> = {}) {
  const values: Record<string, string> = {
    DEEPSEEK_API_KEY: 'sk-test',
    ...overrides,
  };
  const config = {
    get: (key: string, def?: string) => values[key] ?? def,
  } as unknown as ConfigService;
  return new DeepSeekJudgeAdapter(config);
}

function mockFetchOnce(body: unknown, ok = true, status = 200) {
  (global.fetch as jest.Mock).mockResolvedValueOnce({
    ok,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  });
}

describe('DeepSeekJudgeAdapter', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  it('parses a valid verdict from JSON content', async () => {
    mockFetchOnce({
      choices: [
        {
          message: {
            content:
              '{"approve": true, "confidence": 0.85, "reason": "preço abaixo da mediana"}',
          },
        },
      ],
    });
    const verdict = await makeAdapter().judge(input);
    expect(verdict).toEqual({
      approve: true,
      confidence: 0.85,
      reason: 'preço abaixo da mediana',
    });
    const call = (global.fetch as jest.Mock).mock.calls[0];
    expect(call[0]).toBe('https://api.deepseek.com/chat/completions');
    const payload = JSON.parse(call[1].body);
    expect(payload.response_format).toEqual({ type: 'json_object' });
    expect(payload.temperature).toBe(0);
  });

  it('throws on HTTP error status', async () => {
    mockFetchOnce({ error: 'rate limited' }, false, 429);
    await expect(makeAdapter().judge(input)).rejects.toThrow('status=429');
  });

  it('throws on invalid JSON content', async () => {
    mockFetchOnce({
      choices: [{ message: { content: 'não é json' } }],
    });
    await expect(makeAdapter().judge(input)).rejects.toThrow();
  });

  it('throws on malformed verdict shape', async () => {
    mockFetchOnce({
      choices: [{ message: { content: '{"approve": "sim"}' } }],
    });
    await expect(makeAdapter().judge(input)).rejects.toThrow('invalid verdict');
  });

  it('clamps confidence into 0..1', async () => {
    mockFetchOnce({
      choices: [
        { message: { content: '{"approve": true, "confidence": 3, "reason": "x"}' } },
      ],
    });
    const verdict = await makeAdapter().judge(input);
    expect(verdict.confidence).toBe(1);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx jest src/judge/deepseek-judge.adapter.spec.ts --silent`
Expected: FAIL — `Cannot find module './deepseek-judge.adapter'`

- [ ] **Step 3: Implementar adapter**

`src/judge/deepseek-judge.adapter.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { DealJudge, JudgeInput, JudgeVerdict } from './judge.port';

interface ChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
}

/**
 * Gray-zone curation judge on DeepSeek's OpenAI-compatible API.
 * Throws on ANY failure (HTTP, timeout, bad JSON, bad shape) — the gate is
 * fail-closed and records `judge_error` without posting.
 */
@Injectable()
export class DeepSeekJudgeAdapter implements DealJudge {
  private readonly logger = new Logger(DeepSeekJudgeAdapter.name);
  private readonly apiKey: string;
  private readonly model: string;
  private readonly endpoint: string;
  private readonly timeoutMs: number;

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get<string>('DEEPSEEK_API_KEY') ?? '';
    this.model = this.config.get<string>('DEEPSEEK_MODEL') ?? 'deepseek-chat';
    this.endpoint =
      this.config.get<string>('DEEPSEEK_ENDPOINT') ??
      'https://api.deepseek.com/chat/completions';
    this.timeoutMs = Number(
      this.config.get<string>('DEEPSEEK_TIMEOUT_MS') ?? '8000',
    );
  }

  async judge(input: JudgeInput): Promise<JudgeVerdict> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let res: Response;
    try {
      res = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: this.systemPrompt() },
            { role: 'user', content: JSON.stringify(input) },
          ],
          response_format: { type: 'json_object' },
          temperature: 0,
          max_tokens: 200,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`status=${res.status} body=${body.slice(0, 200)}`);
    }

    const data = (await res.json()) as ChatResponse;
    if (data.error?.message) throw new Error(data.error.message);
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('no content in response');

    const parsed = JSON.parse(content) as Partial<JudgeVerdict>;
    if (
      typeof parsed.approve !== 'boolean' ||
      typeof parsed.confidence !== 'number' ||
      typeof parsed.reason !== 'string'
    ) {
      throw new Error(`invalid verdict shape: ${content.slice(0, 120)}`);
    }
    return {
      approve: parsed.approve,
      confidence: Math.min(1, Math.max(0, parsed.confidence)),
      reason: parsed.reason.slice(0, 300),
    };
  }

  private systemPrompt(): string {
    return [
      'Você é um curador cético de ofertas de e-commerce no Brasil.',
      'Recebe um JSON com sinais de um deal (preço, histórico, vendedor,',
      'score heurístico) e decide se ele é uma oferta REAL que vale publicar',
      'num grupo de promoções, ou provável fake/armadilha.',
      'Rejeite quando: desconto ancorado só num "preço original" sem apoio',
      'do histórico; indício de preço inflado antes do desconto; vendedor',
      'de reputação baixa ou desconhecida em item caro; produto usado ou',
      'recondicionado sem desconto excepcional; qualquer sinal incoerente.',
      'Aprove quando o preço atual é claramente bom contra mediana/mínimos',
      'e o vendedor é confiável.',
      'Responda APENAS JSON: {"approve": boolean, "confidence": number',
      'entre 0 e 1, "reason": "uma frase curta em pt-BR"}.',
    ].join(' ');
  }
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx jest src/judge/deepseek-judge.adapter.spec.ts --silent`
Expected: PASS

- [ ] **Step 5: JudgeModule**

`src/judge/judge.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DeepSeekJudgeAdapter } from './deepseek-judge.adapter';
import { DEAL_JUDGE } from './judge.port';
import { NoopJudge } from './noop-judge.adapter';
import { JudgeVerdictCache } from './verdict-cache';

@Module({
  providers: [
    NoopJudge,
    DeepSeekJudgeAdapter,
    JudgeVerdictCache,
    {
      provide: DEAL_JUDGE,
      useFactory: (
        config: ConfigService,
        deepseek: DeepSeekJudgeAdapter,
        noop: NoopJudge,
      ) => ((config.get<string>('DEEPSEEK_API_KEY') ?? '') ? deepseek : noop),
      inject: [ConfigService, DeepSeekJudgeAdapter, NoopJudge],
    },
  ],
  exports: [DEAL_JUDGE, JudgeVerdictCache],
})
export class JudgeModule {}
```

- [ ] **Step 6: Env docs**

Em `.env.example`, dentro do bloco `DeepSeek LLM judge (Fase 2)` (já tem `DEEPSEEK_API_KEY=`), adicionar:

```
# OpenAI-compatible chat model id. Swap for the v4-flash id when desired.
DEEPSEEK_MODEL=deepseek-chat
DEEPSEEK_TIMEOUT_MS=8000

# Gray-zone gate: approve only if verdict.confidence >= this.
JUDGE_MIN_CONFIDENCE=0.6
# Cost ceiling per scheduler tick; excess gray-zone deals wait for next tick.
JUDGE_MAX_CALLS_PER_TICK=10
```

- [ ] **Step 7: Build + commit**

Run: `npm run build`
Expected: compila sem erro.

```bash
git add src/judge/ .env.example
git commit -m "feat(judge): DeepSeek adapter (fail-closed) + JudgeModule factory"
```

---

### Task 5: Variant util, counters e CurationGateService

**Files:**
- Create: `src/shared/variant.ts`
- Create: `src/shared/variant.spec.ts`
- Modify: `src/metrics/counters.service.ts` (adicionar 3 counters após `dedupSkip`)
- Create: `src/curation/curation-gate.service.ts`
- Create: `src/curation/curation-gate.service.spec.ts`
- Modify: `src/curation/curation.module.ts`

**Interfaces:**
- Consumes: `CurationService` (`historyDays`, `isFakeDiscount`, `getAnalytics`), `DedupService.wasRecentlyPosted(key, days)`, `DEAL_JUDGE`/`JudgeVerdictCache`/`buildJudgeInput` (Tasks 3-4), `CURATION_DECISION_REPO` (Task 2), `CountersService`, `dayString` (Task 2).
- Produces:
  - `type CopyVariant = 'A' | 'B'`; `pickVariant(catalogId: string): CopyVariant`
  - `CountersService.judgeApprove/judgeReject/judgeError: Counter<string>`
  - `class CurationGateService`:
    - `screenRaw(raw: RawDeal): Promise<boolean>` — dedup + fake_discount (grava decisões; move o `counters.dedupSkip.inc()` do pipeline pra cá)
    - `recordPrescoreCut(raws: RawDeal[]): Promise<void>`
    - `recordScoreReject(sd: ScoredDeal): Promise<void>`
    - `selectForDispatch(scored: ScoredDeal[], max: number): Promise<Array<{ scored: ScoredDeal; variant: CopyVariant }>>`
    - `recordPosted(sd: ScoredDeal, variant: CopyVariant): Promise<void>`
  - `CurationModule` exporta `CurationGateService`.

- [ ] **Step 1: Teste do pickVariant (falhando)**

`src/shared/variant.spec.ts`:

```ts
import { pickVariant } from './variant';

describe('pickVariant', () => {
  it('is deterministic for the same catalogId', () => {
    expect(pickVariant('ml:MLB123')).toBe(pickVariant('ml:MLB123'));
  });

  it('produces both variants across ids', () => {
    const ids = Array.from({ length: 50 }, (_, i) => `ml:MLB${i}`);
    const set = new Set(ids.map(pickVariant));
    expect(set).toEqual(new Set(['A', 'B']));
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx jest src/shared/variant.spec.ts --silent`
Expected: FAIL — `Cannot find module './variant'`

- [ ] **Step 3: Implementar variant util**

`src/shared/variant.ts`:

```ts
export type CopyVariant = 'A' | 'B';

/** Deterministic split: same deal gets the same copy on WA and Telegram. */
export function pickVariant(catalogId: string): CopyVariant {
  let h = 0;
  for (let i = 0; i < catalogId.length; i++) {
    h = (h * 31 + catalogId.charCodeAt(i)) | 0;
  }
  return (h & 1) === 0 ? 'A' : 'B';
}
```

Run: `npx jest src/shared/variant.spec.ts --silent` → PASS

- [ ] **Step 4: Counters**

Em `src/metrics/counters.service.ts`: declarar após `dedupSkip`:

```ts
  public readonly judgeApprove: Counter<string>;
  public readonly judgeReject: Counter<string>;
  public readonly judgeError: Counter<string>;
```

E no constructor, após o bloco do `dedupSkip`:

```ts
    this.judgeApprove = new Counter({
      name: 'curation_judge_approve_total',
      help: 'Gray-zone deals approved by the LLM judge',
      registers: [this.register],
    });

    this.judgeReject = new Counter({
      name: 'curation_judge_reject_total',
      help: 'Gray-zone deals rejected by the LLM judge',
      registers: [this.register],
    });

    this.judgeError = new Counter({
      name: 'curation_judge_error_total',
      help: 'Judge calls that failed (fail-closed: deal not posted)',
      registers: [this.register],
    });
```

- [ ] **Step 5: Teste do gate (falhando)**

`src/curation/curation-gate.service.spec.ts`:

```ts
import type { ScoredDeal } from '../deal-score/types';
import type { RawDeal } from '../sources/source.port';
import { CurationGateService } from './curation-gate.service';
import type { DecisionUpsert } from './curation-decision.repo';

function makeRaw(id: string, priceCents = 10000): RawDeal {
  return {
    key: { source: 'ml', externalId: id },
    title: `Produto ${id}`,
    priceCents,
    originalPriceCents: priceCents * 2,
    discountPercent: 50,
    thumbnail: '',
    permalink: `https://ml/${id}`,
    feedId: 'f1',
  };
}

function makeScored(
  id: string,
  score: number,
  factors: Record<string, number> = {},
): ScoredDeal {
  const raw = makeRaw(id);
  return {
    deal: {
      key: raw.key,
      source: 'ml',
      raw,
      seller: null,
      condition: 'new',
      signals: {
        freeShipping: false,
        installmentsNoInterest: false,
        volumeTier: 'none',
        isVerifiedStore: false,
      },
      extras: {},
    },
    score,
    rawScore: score,
    level: score >= 90 ? 'top' : 'good',
    reasons: [],
    penalties: [],
    factors,
  };
}

const emptyAnalytics = {
  median7d: null,
  median14d: null,
  median30d: null,
  min7d: null,
  min14d: null,
  min30d: null,
  distinctDays: 0,
  lastObservedBefore: null,
  trend: 'unknown' as const,
};

function makeDeps(overrides: Record<string, string> = {}) {
  const values: Record<string, string> = {
    TZ: 'America/Sao_Paulo',
    ...overrides,
  };
  const config = {
    get: (key: string, def?: string) => values[key] ?? def,
  };
  const curation = {
    historyDays: jest.fn().mockReturnValue(30), // com histórico por default
    isFakeDiscount: jest.fn().mockReturnValue(false),
    getAnalytics: jest.fn().mockReturnValue(emptyAnalytics),
  };
  const dedup = { wasRecentlyPosted: jest.fn().mockResolvedValue(false) };
  const judge = {
    judge: jest
      .fn()
      .mockResolvedValue({ approve: true, confidence: 0.9, reason: 'ok' }),
  };
  const decisions: { upserts: DecisionUpsert[] } & Record<string, any> = {
    upserts: [],
    upsert: jest.fn().mockImplementation(async (d: DecisionUpsert) => {
      decisions.upserts.push(d);
    }),
    pruneOlderThan: jest.fn().mockResolvedValue(0),
  };
  const counters = {
    dedupSkip: { inc: jest.fn() },
    judgeApprove: { inc: jest.fn() },
    judgeReject: { inc: jest.fn() },
    judgeError: { inc: jest.fn() },
  };
  const cache = { get: jest.fn().mockReturnValue(null), set: jest.fn() };
  return { config, curation, dedup, judge, decisions, counters, cache };
}

function makeGate(d: ReturnType<typeof makeDeps>) {
  return new CurationGateService(
    d.config as any,
    d.curation as any,
    d.dedup as any,
    d.judge as any,
    d.decisions as any,
    d.cache as any,
    d.counters as any,
  );
}

describe('CurationGateService.screenRaw', () => {
  it('rejects dedup hits, bumps counter, records decision', async () => {
    const d = makeDeps();
    d.dedup.wasRecentlyPosted.mockResolvedValue(true);
    const gate = makeGate(d);

    const ok = await gate.screenRaw(makeRaw('MLB1'));

    expect(ok).toBe(false);
    expect(d.counters.dedupSkip.inc).toHaveBeenCalled();
    expect(d.decisions.upserts[0]).toMatchObject({
      catalogId: 'ml:MLB1',
      stage: 'dedup',
      outcome: 'rejected',
    });
  });

  it('rejects fake discounts and records decision', async () => {
    const d = makeDeps();
    d.curation.isFakeDiscount.mockReturnValue(true);
    const gate = makeGate(d);

    expect(await gate.screenRaw(makeRaw('MLB2'))).toBe(false);
    expect(d.decisions.upserts[0]).toMatchObject({
      catalogId: 'ml:MLB2',
      stage: 'fake_discount',
    });
  });

  it('passes clean deals without recording', async () => {
    const d = makeDeps();
    const gate = makeGate(d);

    expect(await gate.screenRaw(makeRaw('MLB3'))).toBe(true);
    expect(d.decisions.upserts).toHaveLength(0);
  });

  it('survives decision write failures', async () => {
    const d = makeDeps();
    d.dedup.wasRecentlyPosted.mockResolvedValue(true);
    d.decisions.upsert.mockRejectedValue(new Error('db down'));
    const gate = makeGate(d);

    await expect(gate.screenRaw(makeRaw('MLB4'))).resolves.toBe(false);
  });
});

describe('CurationGateService.selectForDispatch', () => {
  it('hard-blocks price-raise regardless of score', async () => {
    const d = makeDeps();
    const gate = makeGate(d);

    const out = await gate.selectForDispatch(
      [makeScored('MLB1', 95, { price_raise_before_discount: -30 })],
      3,
    );

    expect(out).toHaveLength(0);
    expect(d.decisions.upserts[0]).toMatchObject({
      stage: 'price_raise',
      outcome: 'rejected',
    });
    expect(d.judge.judge).not.toHaveBeenCalled();
  });

  it('auto-approves score >= TOP with history, no judge call', async () => {
    const d = makeDeps();
    const gate = makeGate(d);

    const out = await gate.selectForDispatch([makeScored('MLB1', 92)], 3);

    expect(out).toHaveLength(1);
    expect(out[0].variant).toMatch(/^[AB]$/);
    expect(d.judge.judge).not.toHaveBeenCalled();
  });

  it('sends gray zone (75-89) to the judge and honors approval', async () => {
    const d = makeDeps();
    const gate = makeGate(d);

    const out = await gate.selectForDispatch([makeScored('MLB1', 80)], 3);

    expect(d.judge.judge).toHaveBeenCalledTimes(1);
    expect(out).toHaveLength(1);
    expect(d.counters.judgeApprove.inc).toHaveBeenCalled();
    expect(d.decisions.upserts[0]).toMatchObject({
      stage: 'judge',
      outcome: 'approved',
    });
  });

  it('sends no-history deals to the judge even with score >= TOP', async () => {
    const d = makeDeps();
    d.curation.historyDays.mockReturnValue(2);
    const gate = makeGate(d);

    await gate.selectForDispatch([makeScored('MLB1', 95)], 3);

    expect(d.judge.judge).toHaveBeenCalledTimes(1);
  });

  it('rejects when judge rejects or confidence is low', async () => {
    const d = makeDeps();
    d.judge.judge.mockResolvedValue({
      approve: true,
      confidence: 0.3,
      reason: 'incerto',
    });
    const gate = makeGate(d);

    const out = await gate.selectForDispatch([makeScored('MLB1', 80)], 3);

    expect(out).toHaveLength(0);
    expect(d.counters.judgeReject.inc).toHaveBeenCalled();
    expect(d.decisions.upserts[0]).toMatchObject({
      stage: 'judge',
      outcome: 'rejected',
    });
  });

  it('fail-closed on judge error', async () => {
    const d = makeDeps();
    d.judge.judge.mockRejectedValue(new Error('timeout'));
    const gate = makeGate(d);

    const out = await gate.selectForDispatch([makeScored('MLB1', 80)], 3);

    expect(out).toHaveLength(0);
    expect(d.counters.judgeError.inc).toHaveBeenCalled();
    expect(d.decisions.upserts[0]).toMatchObject({ stage: 'judge_error' });
  });

  it('caps judge calls per tick and records judge_budget', async () => {
    const d = makeDeps({ JUDGE_MAX_CALLS_PER_TICK: '1' });
    d.judge.judge.mockResolvedValue({
      approve: false,
      confidence: 1,
      reason: 'não',
    });
    const gate = makeGate(d);

    await gate.selectForDispatch(
      [makeScored('MLB1', 80), makeScored('MLB2', 79)],
      3,
    );

    expect(d.judge.judge).toHaveBeenCalledTimes(1);
    expect(
      d.decisions.upserts.find((u) => u.stage === 'judge_budget'),
    ).toMatchObject({ catalogId: 'ml:MLB2' });
  });

  it('uses cached verdicts without consuming judge budget', async () => {
    const d = makeDeps();
    d.cache.get.mockReturnValue({ approve: true, confidence: 0.9, reason: 'ok' });
    const gate = makeGate(d);

    const out = await gate.selectForDispatch([makeScored('MLB1', 80)], 3);

    expect(out).toHaveLength(1);
    expect(d.judge.judge).not.toHaveBeenCalled();
  });

  it('stops at max approved deals', async () => {
    const d = makeDeps();
    const gate = makeGate(d);

    const out = await gate.selectForDispatch(
      [makeScored('MLB1', 95), makeScored('MLB2', 94), makeScored('MLB3', 93)],
      2,
    );

    expect(out).toHaveLength(2);
  });

  it('forces variant A when COPY_AB_ENABLED=false', async () => {
    const d = makeDeps({ COPY_AB_ENABLED: 'false' });
    const gate = makeGate(d);

    const out = await gate.selectForDispatch(
      [makeScored('MLB1', 95), makeScored('MLB2', 94)],
      2,
    );

    expect(out.map((o) => o.variant)).toEqual(['A', 'A']);
  });
});

describe('CurationGateService.recordPosted / recordScoreReject', () => {
  it('records posted with variant and score', async () => {
    const d = makeDeps();
    const gate = makeGate(d);
    await gate.recordPosted(makeScored('MLB1', 92), 'B');
    expect(d.decisions.upserts[0]).toMatchObject({
      stage: 'posted',
      outcome: 'posted',
      variant: 'B',
      score: 92,
    });
  });

  it('records score_min rejections with reasons', async () => {
    const d = makeDeps();
    const gate = makeGate(d);
    const sd = makeScored('MLB1', 60);
    sd.penalties = [{ code: 'x', weight: -25, message: 'histórico limitado' }];
    await gate.recordScoreReject(sd);
    expect(d.decisions.upserts[0]).toMatchObject({
      stage: 'score_min',
      outcome: 'rejected',
      score: 60,
    });
  });
});
```

- [ ] **Step 6: Rodar e ver falhar**

Run: `npx jest src/curation/curation-gate.service.spec.ts --silent`
Expected: FAIL — `Cannot find module './curation-gate.service'`

- [ ] **Step 7: Implementar gate**

`src/curation/curation-gate.service.ts`:

```ts
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ScoredDeal } from '../deal-score/types';
import { DedupService } from '../dedup/dedup.service';
import { buildJudgeInput } from '../judge/judge-input';
import { DEAL_JUDGE } from '../judge/judge.port';
import type { DealJudge, JudgeVerdict } from '../judge/judge.port';
import { JudgeVerdictCache } from '../judge/verdict-cache';
import { CountersService } from '../metrics/counters.service';
import { dayString } from '../shared/day';
import { CopyVariant, pickVariant } from '../shared/variant';
import { keyToString, RawDeal } from '../sources/source.port';
import { CURATION_DECISION_REPO } from './curation-decision.repo';
import type {
  CurationDecisionRepo,
  DecisionUpsert,
} from './curation-decision.repo';
import { CurationService } from './curation.service';

const DECISION_RETENTION_DAYS = 60;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Single owner of every publish/reject decision (Fase 2). Each exit path
 * writes a CurationDecision row (upsert per catalogId+stage+day). The LLM
 * judge runs only here, only on the dispatch path, and is fail-closed.
 */
@Injectable()
export class CurationGateService implements OnModuleInit {
  private readonly logger = new Logger(CurationGateService.name);
  private readonly tz: string;
  private readonly dedupWindowDays: number;
  private readonly scoreTop: number;
  private readonly minHistoryDays: number;
  private readonly minConfidence: number;
  private readonly maxJudgeCallsPerTick: number;
  private readonly copyAbEnabled: boolean;

  constructor(
    private readonly config: ConfigService,
    private readonly curation: CurationService,
    private readonly dedup: DedupService,
    @Inject(DEAL_JUDGE) private readonly judge: DealJudge,
    @Inject(CURATION_DECISION_REPO)
    private readonly decisions: CurationDecisionRepo,
    private readonly verdictCache: JudgeVerdictCache,
    private readonly counters: CountersService,
  ) {
    const num = (k: string, def: number) =>
      Number(this.config.get<string>(k, String(def)));
    this.tz = this.config.get<string>('TZ') ?? 'America/Sao_Paulo';
    this.dedupWindowDays = num('DEDUP_WINDOW_DAYS', 7);
    this.scoreTop = num('DEAL_SCORE_TOP', 90);
    this.minHistoryDays = num('CURATION_MIN_HISTORY_DAYS', 7);
    this.minConfidence = num('JUDGE_MIN_CONFIDENCE', 0.6);
    this.maxJudgeCallsPerTick = num('JUDGE_MAX_CALLS_PER_TICK', 10);
    this.copyAbEnabled =
      (this.config.get<string>('COPY_AB_ENABLED') ?? 'true') !== 'false';
  }

  async onModuleInit(): Promise<void> {
    const cutoff = new Date(Date.now() - DECISION_RETENTION_DAYS * DAY_MS);
    try {
      const pruned = await this.decisions.pruneOlderThan(cutoff);
      if (pruned > 0) {
        this.logger.log(`Decision GC: pruned ${pruned} stale rows`);
      }
    } catch (err) {
      this.logger.warn(`Decision GC failed: ${(err as Error).message}`);
    }
  }

  /** Early screen on raw feed items: dedup + fake-discount. */
  async screenRaw(raw: RawDeal): Promise<boolean> {
    const keyStr = keyToString(raw.key);
    if (await this.dedup.wasRecentlyPosted(keyStr, this.dedupWindowDays)) {
      this.counters.dedupSkip.inc();
      await this.record({
        catalogId: keyStr,
        stage: 'dedup',
        outcome: 'rejected',
        priceCents: raw.priceCents,
      });
      return false;
    }
    if (this.curation.isFakeDiscount(keyStr, raw.priceCents)) {
      await this.record({
        catalogId: keyStr,
        stage: 'fake_discount',
        outcome: 'rejected',
        priceCents: raw.priceCents,
      });
      return false;
    }
    return true;
  }

  async recordPrescoreCut(raws: RawDeal[]): Promise<void> {
    for (const raw of raws) {
      await this.record({
        catalogId: keyToString(raw.key),
        stage: 'prescore_cut',
        outcome: 'rejected',
        priceCents: raw.priceCents,
      });
    }
  }

  async recordScoreReject(sd: ScoredDeal): Promise<void> {
    await this.record({
      catalogId: keyToString(sd.deal.key),
      stage: 'score_min',
      outcome: 'rejected',
      score: sd.score,
      priceCents: sd.deal.raw.priceCents,
      reasons: [...sd.reasons, ...sd.penalties],
    });
  }

  /**
   * Dispatch gate: hard price-raise block, auto-approve for high-confidence
   * deals, LLM judge for the gray zone (no history OR score below TOP).
   * Returns at most `max` approved deals, each with its copy variant.
   */
  async selectForDispatch(
    scored: ScoredDeal[],
    max: number,
  ): Promise<Array<{ scored: ScoredDeal; variant: CopyVariant }>> {
    const sorted = [...scored].sort((a, b) => b.score - a.score);
    const approved: Array<{ scored: ScoredDeal; variant: CopyVariant }> = [];
    let judgeCalls = 0;

    for (const sd of sorted) {
      if (approved.length >= max) break;
      const keyStr = keyToString(sd.deal.key);
      const priceCents = sd.deal.raw.priceCents;

      if ('price_raise_before_discount' in sd.factors) {
        await this.record({
          catalogId: keyStr,
          stage: 'price_raise',
          outcome: 'rejected',
          score: sd.score,
          priceCents,
          reasons: sd.penalties,
        });
        continue;
      }

      const noHistory =
        this.curation.historyDays(keyStr) < this.minHistoryDays;
      const grayZone = noHistory || sd.score < this.scoreTop;

      if (grayZone) {
        let verdict: JudgeVerdict | null = this.verdictCache.get(
          keyStr,
          priceCents,
        );
        if (!verdict) {
          if (judgeCalls >= this.maxJudgeCallsPerTick) {
            await this.record({
              catalogId: keyStr,
              stage: 'judge_budget',
              outcome: 'rejected',
              score: sd.score,
              priceCents,
            });
            continue;
          }
          judgeCalls++;
          try {
            verdict = await this.judge.judge(
              buildJudgeInput(sd, this.curation.getAnalytics(keyStr)),
            );
            this.verdictCache.set(keyStr, priceCents, verdict);
          } catch (err) {
            this.counters.judgeError.inc();
            await this.record({
              catalogId: keyStr,
              stage: 'judge_error',
              outcome: 'rejected',
              score: sd.score,
              priceCents,
              judgeVerdict: { error: (err as Error).message },
            });
            continue;
          }
        }

        const ok = verdict.approve && verdict.confidence >= this.minConfidence;
        if (!ok) {
          this.counters.judgeReject.inc();
          await this.record({
            catalogId: keyStr,
            stage: 'judge',
            outcome: 'rejected',
            score: sd.score,
            priceCents,
            judgeVerdict: verdict,
          });
          continue;
        }
        this.counters.judgeApprove.inc();
        await this.record({
          catalogId: keyStr,
          stage: 'judge',
          outcome: 'approved',
          score: sd.score,
          priceCents,
          judgeVerdict: verdict,
        });
      }

      approved.push({ scored: sd, variant: this.variantFor(keyStr) });
    }

    return approved;
  }

  async recordPosted(sd: ScoredDeal, variant: CopyVariant): Promise<void> {
    await this.record({
      catalogId: keyToString(sd.deal.key),
      stage: 'posted',
      outcome: 'posted',
      score: sd.score,
      priceCents: sd.deal.raw.priceCents,
      variant,
    });
  }

  private variantFor(catalogId: string): CopyVariant {
    return this.copyAbEnabled ? pickVariant(catalogId) : 'A';
  }

  /** Decision writes must never take the pipeline down. */
  private async record(d: Omit<DecisionUpsert, 'day'>): Promise<void> {
    try {
      await this.decisions.upsert({
        ...d,
        day: dayString(new Date(), this.tz),
      });
    } catch (err) {
      this.logger.error(
        `decision upsert failed (${d.stage}/${d.catalogId}): ${(err as Error).message}`,
      );
    }
  }
}
```

- [ ] **Step 8: Rodar e ver passar**

Run: `npx jest src/curation --silent`
Expected: PASS (gate + decision repo + curation.service existentes)

- [ ] **Step 9: Wiring no CurationModule**

`src/curation/curation.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { DedupModule } from '../dedup/dedup.module';
import { JudgeModule } from '../judge/judge.module';
import { MetricsModule } from '../metrics/metrics.module';
import {
  CURATION_DECISION_REPO,
  PrismaCurationDecisionRepo,
} from './curation-decision.repo';
import { CurationGateService } from './curation-gate.service';
import { CURATION_REPO, PrismaCurationRepo } from './curation.repo';
import { CurationService } from './curation.service';

@Module({
  imports: [DedupModule, JudgeModule, MetricsModule],
  providers: [
    PrismaCurationRepo,
    { provide: CURATION_REPO, useExisting: PrismaCurationRepo },
    PrismaCurationDecisionRepo,
    { provide: CURATION_DECISION_REPO, useExisting: PrismaCurationDecisionRepo },
    CurationService,
    CurationGateService,
  ],
  exports: [CurationService, CurationGateService],
})
export class CurationModule {}
```

Nota: se `DedupModule`/`MetricsModule` não exportarem os services necessários, adicionar aos `exports` deles (verificar `src/dedup/dedup.module.ts` e `src/metrics/metrics.module.ts`). Se importar `DedupModule` criar ciclo com algum módulo existente, usar `forwardRef` — mas cheque primeiro: hoje `PipelineModule` importa ambos sem ciclo.

- [ ] **Step 10: Build + commit**

Run: `npm run build`
Expected: compila sem erro.

```bash
git add src/shared/variant.ts src/shared/variant.spec.ts src/metrics/counters.service.ts src/curation/
git commit -m "feat(curation): CurationGateService — decisões auditadas + juiz na zona cinza"
```

---

### Task 6: Integração no PipelineService + variant no job

**Files:**
- Modify: `src/queue/queue.types.ts`
- Modify: `src/pipeline/pipeline.service.ts`

**Interfaces:**
- Consumes: `CurationGateService` (Task 5).
- Produces: `SendDealJob.variant?: 'A' | 'B'`; `PipelineService` sem dedup/fake-discount inline (gate cuida); `enqueueScored` passa por `selectForDispatch` e grava `posted`.

- [ ] **Step 1: SendDealJob.variant**

Em `src/queue/queue.types.ts`, adicionar ao `SendDealJob` (após `catalogKey`):

```ts
  /** Copy A/B variant. Optional: jobs enqueued pre-Fase-2 default to 'A'. */
  variant?: 'A' | 'B';
```

- [ ] **Step 2: PipelineService — usar o gate**

Em `src/pipeline/pipeline.service.ts`:

a) Import + injeção: adicionar `import { CurationGateService } from '../curation/curation-gate.service';` e injetar `private readonly gate: CurationGateService` no constructor. Remover as injeções agora órfãs de `DedupService` e `CountersService` (e seus imports) — o gate cuida de ambos.

b) Loop de survivors em `scorePipeline` (substituir o bloco atual das linhas ~88-98):

```ts
    const survivors: RawDeal[] = [];
    for (const raw of rawDeals) {
      const keyStr = keyToString(raw.key);
      await this.curation.record(keyStr, raw.priceCents);
      if (!(await this.gate.screenRaw(raw))) continue;
      survivors.push(raw);
    }
```

(`windowDays` some do método — o gate lê `DEDUP_WINDOW_DAYS` sozinho.)

c) Prescore cut (substituir o bloco `preScored`):

```ts
    const preScoredAll = survivors
      .map((r) => ({ raw: r, pre: this.prescore(r) }))
      .sort((a, b) => b.pre - a.pre);
    const preScored = preScoredAll.slice(0, enrichTopN).map((x) => x.raw);
    await this.gate.recordPrescoreCut(
      preScoredAll.slice(enrichTopN).map((x) => x.raw),
    );
```

d) Score rejects (após `const passing = ...`):

```ts
    for (const s of scored) {
      if (s.score < scoreMin) await this.gate.recordScoreReject(s);
    }
```

e) `enqueueScored` — substituir o topo do método (linhas do `sorted`/early-return) e o loop:

```ts
    const selected = await this.gate.selectForDispatch(scored, max);
    if (selected.length === 0) {
      return { enqueued: 0, targets: 0, topScore: null };
    }
```

(resolução de `activeTargets` fica como está) e o loop de enqueue vira:

```ts
    let enqueued = 0;
    let topScore: number | null = null;
    for (const { scored: sd, variant } of selected) {
      if (topScore === null) topScore = sd.score;
      const catalogKey = keyToString(sd.deal.key);
      let dealEnqueued = false;
      for (const target of activeTargets) {
        const jobId = `${catalogKey}:${target.jid}`;
        try {
          await this.sendQueue.add(
            'send-deal',
            {
              targetJid: target.jid,
              channel: target.channel,
              catalogKey,
              scored: sd,
              variant,
            },
            { jobId },
          );
          enqueued++;
          dealEnqueued = true;
        } catch (err) {
          this.logger.error(
            `enqueue ${jobId} failed: ${(err as Error).message}`,
          );
        }
      }
      if (dealEnqueued) await this.gate.recordPosted(sd, variant);
    }
```

Atualizar a linha de log final para `deals=${selected.length}`.

- [ ] **Step 3: Build + suíte inteira**

Run: `npm run build && npx jest --silent`
Expected: build ok; todos os specs verdes (scheduler.service.spec mocka PipelineService, não é afetado).

- [ ] **Step 4: Commit**

```bash
git add src/queue/queue.types.ts src/pipeline/pipeline.service.ts
git commit -m "feat(pipeline): rotear decisões pelo CurationGateService + variant no job"
```

---

### Task 7: Copy A/B — templates B, formatter e worker

**Files:**
- Create: `src/pipeline/templates/variants.ts`
- Modify: `src/pipeline/formatter.service.ts` (`formatScored`)
- Create/extend: `src/pipeline/formatter-variant.spec.ts`
- Modify: `src/worker/send-deal.worker.ts`
- Modify: `src/worker/send-deal.worker.spec.ts`
- Modify: `.env.example` (flag)

**Interfaces:**
- Consumes: `ScoredCaptionTemplate`, `templatesByLevel` (`templates/index.ts`), `CopyVariant` (Task 5), `SendDealJob.variant` (Task 6).
- Produces: `variantBByLevel: Record<'good' | 'top' | 'super', ScoredCaptionTemplate>`; `FormatterService.formatScored(scored, variant?: CopyVariant)`; worker grava `SentMessage.variant`.

- [ ] **Step 1: Templates variante B**

`src/pipeline/templates/variants.ts`:

```ts
// Variante B do copy A/B (Fase 2): âncora "De/Por" explícita + CTA direto,
// contra a variante A (templates atuais, hook-first). Mesma assinatura.
import type { ScoredDeal } from '../../deal-score/types';
import type { ScoredCaptionTemplate } from './index';

function dePorBlock(
  sd: ScoredDeal,
  formatBRL: (n: number) => string,
): string[] {
  const raw = sd.deal.raw;
  const price = raw.priceCents / 100;
  const original =
    raw.originalPriceCents != null ? raw.originalPriceCents / 100 : null;
  const lines: string[] = [];
  if (original != null && original > price) {
    lines.push(`❌ De: ~${formatBRL(original)}~`);
    lines.push(`✅ Por: *${formatBRL(price)}* (-${raw.discountPercent}%)`);
  } else {
    lines.push(`✅ *${formatBRL(price)}* (-${raw.discountPercent}%)`);
  }
  return lines;
}

const goodB: ScoredCaptionTemplate = (sd, formatBRL, link, hook) => {
  const lines: string[] = [];
  if (hook) lines.push(hook, '');
  lines.push(`📦 ${sd.deal.raw.title}`, '');
  lines.push(...dePorBlock(sd, formatBRL));
  if (sd.deal.signals.freeShipping) lines.push('🚚 Frete grátis');
  lines.push('', `👉 Garante aqui: ${link}`);
  return lines.join('\n');
};

const topB: ScoredCaptionTemplate = (sd, formatBRL, link, hook) => {
  const lines: string[] = ['🔥 ACHADO DO DIA'];
  if (hook) lines.push(hook);
  lines.push('', `📦 ${sd.deal.raw.title}`, '');
  lines.push(...dePorBlock(sd, formatBRL));
  if (sd.deal.signals.freeShipping) lines.push('🚚 Frete grátis');
  if (sd.deal.signals.isVerifiedStore) lines.push('🏬 Loja oficial');
  lines.push('', `👉 Corre: ${link}`);
  return lines.join('\n');
};

const superB: ScoredCaptionTemplate = (sd, formatBRL, link, hook) => {
  const lines: string[] = ['🚨 RARO DE VER 🚨'];
  if (hook) lines.push(hook);
  lines.push('', `📦 ${sd.deal.raw.title}`, '');
  lines.push(...dePorBlock(sd, formatBRL));
  if (sd.deal.signals.freeShipping) lines.push('🚚 Frete grátis');
  if (sd.deal.signals.isVerifiedStore) lines.push('🏬 Loja oficial');
  lines.push('', '⏳ Preço assim não dura.', `👉 ${link}`);
  return lines.join('\n');
};

export const variantBByLevel: Record<
  'good' | 'top' | 'super',
  ScoredCaptionTemplate
> = { good: goodB, top: topB, super: superB };
```

- [ ] **Step 2: Teste do formatter (falhando)**

`src/pipeline/formatter-variant.spec.ts`:

```ts
import { FormatterService } from './formatter.service';
import type { ScoredDeal } from '../deal-score/types';

function makeScored(level: 'good' | 'top' | 'super' = 'good'): ScoredDeal {
  return {
    deal: {
      key: { source: 'ml', externalId: 'MLB1' },
      source: 'ml',
      raw: {
        key: { source: 'ml', externalId: 'MLB1' },
        title: 'Produto X',
        priceCents: 8990,
        originalPriceCents: 14990,
        discountPercent: 40,
        thumbnail: 'https://t/-I.jpg',
        permalink: 'https://ml/p',
        feedId: 'f1',
      },
      seller: null,
      condition: 'new',
      signals: {
        freeShipping: true,
        installmentsNoInterest: false,
        volumeTier: 'none',
        isVerifiedStore: false,
      },
      extras: {},
    },
    score: 80,
    rawScore: 80,
    level,
    reasons: [],
    penalties: [],
    factors: {},
  } as ScoredDeal;
}

function makeFormatter(): FormatterService {
  const affiliate = { resolve: jest.fn().mockResolvedValue('https://aff/x') };
  const headline = { generate: jest.fn().mockResolvedValue('HOOK TESTE 🔥') };
  return new FormatterService(affiliate as any, headline as any);
}

describe('FormatterService.formatScored variants', () => {
  it('defaults to variant A (current template)', async () => {
    const f = makeFormatter();
    const { caption } = await f.formatScored(makeScored());
    expect(caption).not.toContain('❌ De:');
  });

  it('renders De/Por block on variant B', async () => {
    const f = makeFormatter();
    const { caption } = await f.formatScored(makeScored(), 'B');
    expect(caption).toContain('❌ De:');
    expect(caption).toContain('✅ Por:');
    expect(caption).toContain('https://aff/x');
  });

  it('keeps the disclaimer on both variants', async () => {
    const f = makeFormatter();
    const a = await f.formatScored(makeScored(), 'A');
    const b = await f.formatScored(makeScored(), 'B');
    expect(a.caption).toContain('Link de afiliado');
    expect(b.caption).toContain('Link de afiliado');
  });
});
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `npx jest src/pipeline/formatter-variant.spec.ts --silent`
Expected: FAIL — `formatScored` não aceita segundo argumento / `variants` não existe.

- [ ] **Step 4: Formatter aceita variante**

Em `src/pipeline/formatter.service.ts`:

a) Imports: `import { variantBByLevel } from './templates/variants';` e `import type { CopyVariant } from '../shared/variant';`

b) Assinatura e seleção de template em `formatScored`:

```ts
  async formatScored(
    scored: ScoredDeal,
    variant: CopyVariant = 'A',
  ): Promise<{ caption: string; imageUrl: string }> {
```

e trocar a seleção `const tmpl = ...` por:

```ts
    const level =
      scored.level === 'super' || scored.level === 'top'
        ? scored.level
        : 'good';
    const byLevel = variant === 'B' ? variantBByLevel : templatesByLevel;
    const tmpl = byLevel[level];
```

- [ ] **Step 5: Rodar e ver passar**

Run: `npx jest src/pipeline --silent`
Expected: PASS (novo spec + formatter.service.spec existente intacto)

- [ ] **Step 6: Worker propaga variante (teste primeiro)**

Em `src/worker/send-deal.worker.spec.ts`: no `makeJob`, adicionar `variant: 'B'` ao `data`, e no primeiro teste substituir a asserção do `sentMessage.create` por:

```ts
    expect(d.formatter.formatScored).toHaveBeenCalledWith(
      expect.anything(),
      'B',
    );
    expect(d.prisma.sentMessage.create).toHaveBeenCalledWith({
      data: {
        catalogId: 'ml:MLB1',
        targetJid: '-100555',
        caption: 'cap',
        variant: 'B',
      },
    });
```

Adicionar teste de default:

```ts
  it('defaults variant to A for legacy jobs', async () => {
    const d = makeDeps();
    const worker = makeWorker(d);
    const job = makeJob('telegram');
    delete job.data.variant;

    await (worker as any).process(job);

    expect(d.formatter.formatScored).toHaveBeenCalledWith(
      expect.anything(),
      'A',
    );
  });
```

Run: `npx jest src/worker --silent` → FAIL (worker ainda não passa variant)

- [ ] **Step 7: Implementar no worker**

Em `src/worker/send-deal.worker.ts`, no `process()`:

```ts
    const variant = job.data.variant ?? 'A';
    const publisher = this.publishers.get(channel);
    const { caption, imageUrl } = await this.formatter.formatScored(
      scored,
      variant,
    );
```

e no audit insert:

```ts
        data: { catalogId: keyStr, targetJid, caption, variant },
```

Run: `npx jest src/worker --silent` → PASS

- [ ] **Step 8: Env flag**

`.env.example`, no bloco DeepSeek/Fase 2 (após `JUDGE_MAX_CALLS_PER_TICK`):

```
# Copy A/B: 'false' forces variant A everywhere (instant rollback, no deploy).
COPY_AB_ENABLED=true
```

- [ ] **Step 9: Commit**

```bash
git add src/pipeline/templates/variants.ts src/pipeline/formatter.service.ts src/pipeline/formatter-variant.spec.ts src/worker/ .env.example
git commit -m "feat(copy): variante B De/Por + variant fim-a-fim até SentMessage"
```

---

### Task 8: Verificação final e env real

**Files:**
- Modify: `.env` (local, não commitado)

- [ ] **Step 1: Suíte completa + build**

Run: `npx jest --silent && npm run build`
Expected: tudo verde, build limpo.

- [ ] **Step 2: Aplicar migration no Postgres do compose**

Run:
```bash
docker compose up -d postgres
DATABASE_URL="postgresql://wppbot:changeme@localhost:5433/wppbot?schema=public" npx prisma migrate deploy
```
Expected: `1 migration applied` (ou "already applied" em re-runs).

- [ ] **Step 3: Env real**

Adicionar ao `.env` (a `DEEPSEEK_API_KEY` já está lá):

```
DEEPSEEK_MODEL=deepseek-chat
DEEPSEEK_TIMEOUT_MS=8000
JUDGE_MIN_CONFIDENCE=0.6
JUDGE_MAX_CALLS_PER_TICK=10
COPY_AB_ENABLED=true
```

Lembrete operacional: container do compose só relê env com `docker compose up -d --force-recreate` (restart NÃO recarrega env_file).

- [ ] **Step 4: Smoke real (opcional, requer app de pé)**

Com `SCHEDULER_DISPATCH_ENABLED=false` (warmup atual), subir o app e verificar no log o boot do gate (`Decision GC`) e, após um tick, linhas em `CurationDecision`:

```bash
DATABASE_URL="postgresql://wppbot:changeme@localhost:5433/wppbot?schema=public" npx prisma studio
```
Expected: tabela `CurationDecision` populando com stages `dedup`/`fake_discount`/`score_min` (juiz só entra quando dispatch ligar).

- [ ] **Step 5: Commit final (se sobrou algo) e encerrar branch/PR conforme fluxo do repo**

```bash
git status --short
```
Expected: working tree limpo (`.env` é gitignored).
