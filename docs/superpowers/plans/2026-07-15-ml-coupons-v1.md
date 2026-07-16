# ML Coupons v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the operator manually register ML coupons that the bot auto-attaches to matching deals, showing an accurate final price when safe (per-deal) or a code-only CTA otherwise.

**Architecture:** A pure `coupon-math` core (gate + price math, no I/O) decides PRICE vs CTA vs skip. A `CouponService` queries a new Prisma `Coupon` table by the deal's ML seller id / MLB id and returns one `CouponView`. The pipeline resolves a `couponView` per approved deal at `enqueueScored` (mirroring `priceView`), carries it on the send job, and the formatter renders one extra line under the price (mirroring the Pix/installments injection). Scoring/curation is untouched (format-only).

**Tech Stack:** NestJS, Prisma 6.19.3 (pinned), BullMQ, Jest, class-validator, TypeScript (strict, `tsconfig.build.json` must stay clean).

## Global Constraints

- Prisma pinned to **6.19.3** — do not upgrade; do not add `url` config that triggers a Prisma 7 refactor.
- ML is the only coupon source in v1 — coupons only resolve for deals where `deal.key.source === 'ml'`.
- Money is always **integer cents**; render via `FormatterService.formatBRL(n)` which takes **reais** (`cents / 100`).
- Never claim a price that could be wrong: `firstBuy` or `perUser` coupons render **nothing**; below-minimum coupons render **code-only CTA**; PIX is never stacked into the coupon final price.
- `.env` is git-tracked but holds secrets — **never** stage `.env` in any commit.
- Prod typecheck must stay clean: `npx tsc -p tsconfig.build.json --noEmit`.
- Full suite baseline is **254 passing** — keep it green.

---

## File Structure

- Create `src/coupon/coupon.types.ts` — `Coupon`, `CouponScope`, `CouponType`, `CouponView` types.
- Create `src/coupon/coupon-math.ts` (+ `.spec.ts`) — pure `applyCoupon()` + `computeCouponView()` (the gate).
- Create `src/coupon/coupon.repository.ts` — Prisma access (`findMatching`, `create`).
- Create `src/coupon/coupon.service.ts` (+ `.spec.ts`) — `resolveForDeal()`: query + pick best + gate.
- Create `src/coupon/dto/create-coupon.dto.ts` — validated request body.
- Create `src/coupon/coupon.controller.ts` — `POST /coupons` (ApiKeyGuard).
- Create `src/coupon/coupon.module.ts` — wires repo/service/controller; exports `CouponService`.
- Modify `prisma/schema.prisma` — add `Coupon` model (+ generated migration).
- Modify `src/queue/queue.types.ts` — add `couponView?` to `SendDealJob` + `DigestDealEntry`.
- Modify `src/pipeline/pipeline.service.ts` — inject `CouponService`, resolve per deal, attach to jobs.
- Modify `src/pipeline/formatter.service.ts` (+ specs) — render coupon line in `formatScored` + `digestBlock`.
- Modify `src/worker/send-deal.worker.ts` (+ spec) — pass `couponView`, re-check `validUntil` at send.
- Modify `src/app.module.ts` (or `pipeline.module.ts`) — import `CouponModule`.

---

### Task 1: Coupon types + pure math/gate

Highest-value, zero-I/O core. Everything else consumes these types + functions.

**Files:**

- Create: `src/coupon/coupon.types.ts`
- Create: `src/coupon/coupon-math.ts`
- Test: `src/coupon/coupon-math.spec.ts`

**Interfaces:**

- Produces:
  - `type CouponScope = 'SELLER' | 'PRODUCT'`
  - `type CouponType = 'PERCENT' | 'FIXED'`
  - `interface Coupon { id: string; code: string; scope: CouponScope; targetId: string; type: CouponType; value: number; capCents: number | null; minCents: number | null; firstBuy: boolean; perUser: boolean; validUntil: Date; active: boolean; affiliateSafe: boolean }`
  - `interface CouponView { code: string; mode: 'PRICE' | 'CTA'; finalCents: number | null; discountLabel: string; minCents: number | null; validUntil: string }`
  - `applyCoupon(priceCents: number, coupon: Coupon): number` — final price in cents, clamped ≥ 0.
  - `computeCouponView(coupon: Coupon, priceCents: number, now: Date): CouponView | null` — the gate.

- [ ] **Step 1: Write the failing test** — `src/coupon/coupon-math.spec.ts`

```ts
import { applyCoupon, computeCouponView } from './coupon-math';
import type { Coupon } from './coupon.types';

const base: Coupon = {
  id: 'c1',
  code: 'ABC',
  scope: 'SELLER',
  targetId: 's1',
  type: 'PERCENT',
  value: 10,
  capCents: null,
  minCents: null,
  firstBuy: false,
  perUser: false,
  validUntil: new Date('2999-01-01'),
  active: true,
  affiliateSafe: true,
};
const now = new Date('2026-07-15T00:00:00Z');

describe('applyCoupon', () => {
  it('percent off', () => {
    expect(applyCoupon(10000, { ...base, type: 'PERCENT', value: 10 })).toBe(
      9000,
    );
  });
  it('percent capped at capCents', () => {
    expect(
      applyCoupon(100000, {
        ...base,
        type: 'PERCENT',
        value: 10,
        capCents: 5000,
      }),
    ).toBe(95000);
  });
  it('fixed off in cents', () => {
    expect(applyCoupon(10000, { ...base, type: 'FIXED', value: 2000 })).toBe(
      8000,
    );
  });
  it('never goes below zero', () => {
    expect(applyCoupon(1000, { ...base, type: 'FIXED', value: 5000 })).toBe(0);
  });
});

describe('computeCouponView gate', () => {
  it('inactive -> null', () => {
    expect(
      computeCouponView({ ...base, active: false }, 10000, now),
    ).toBeNull();
  });
  it('expired -> null', () => {
    expect(
      computeCouponView(
        { ...base, validUntil: new Date('2020-01-01') },
        10000,
        now,
      ),
    ).toBeNull();
  });
  it('firstBuy -> null (never render)', () => {
    expect(
      computeCouponView({ ...base, firstBuy: true }, 10000, now),
    ).toBeNull();
  });
  it('perUser -> null (never render)', () => {
    expect(
      computeCouponView({ ...base, perUser: true }, 10000, now),
    ).toBeNull();
  });
  it('applies -> PRICE with finalCents', () => {
    const v = computeCouponView(
      { ...base, type: 'FIXED', value: 2000 },
      10000,
      now,
    );
    expect(v).toMatchObject({ mode: 'PRICE', finalCents: 8000, code: 'ABC' });
  });
  it('below minimum -> CTA, no finalCents', () => {
    const v = computeCouponView({ ...base, minCents: 20000 }, 10000, now);
    expect(v).toMatchObject({ mode: 'CTA', finalCents: null, minCents: 20000 });
  });
  it('at/above minimum -> PRICE', () => {
    const v = computeCouponView(
      { ...base, minCents: 5000, type: 'FIXED', value: 1000 },
      10000,
      now,
    );
    expect(v).toMatchObject({ mode: 'PRICE', finalCents: 9000 });
  });
  it('discountLabel percent', () => {
    expect(
      computeCouponView({ ...base, type: 'PERCENT', value: 15 }, 10000, now)
        ?.discountLabel,
    ).toBe('-15%');
  });
  it('discountLabel fixed', () => {
    expect(
      computeCouponView({ ...base, type: 'FIXED', value: 2000 }, 10000, now)
        ?.discountLabel,
    ).toBe('-R$ 20');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/coupon/coupon-math.spec.ts`
Expected: FAIL — "Cannot find module './coupon-math'".

- [ ] **Step 3: Write `src/coupon/coupon.types.ts`**

```ts
export type CouponScope = 'SELLER' | 'PRODUCT';
export type CouponType = 'PERCENT' | 'FIXED';

/** A manually-registered ML coupon (ml-coupons-v1). Money in integer cents. */
export interface Coupon {
  id: string;
  code: string;
  scope: CouponScope;
  /** SELLER -> ML seller id; PRODUCT -> MLB item id (deal.key.externalId). */
  targetId: string;
  type: CouponType;
  /** PERCENT: whole percent (1-100). FIXED: discount in cents. */
  value: number;
  /** PERCENT only: max discount in cents ("10% até R$50"). null = uncapped. */
  capCents: number | null;
  /** Minimum purchase in cents for the coupon to apply. null = no minimum. */
  minCents: number | null;
  firstBuy: boolean;
  perUser: boolean;
  validUntil: Date;
  active: boolean;
  affiliateSafe: boolean;
}

/** What the formatter needs to render one coupon line. */
export interface CouponView {
  code: string;
  /** PRICE = show final price; CTA = code-only (below minimum). */
  mode: 'PRICE' | 'CTA';
  /** Final price in cents when mode === 'PRICE'; null for CTA. */
  finalCents: number | null;
  /** e.g. "-15%" or "-R$ 20". */
  discountLabel: string;
  /** Minimum in cents for CTA "acima de R$X"; null when no minimum. */
  minCents: number | null;
  /** ISO date for "válido até". */
  validUntil: string;
}
```

- [ ] **Step 4: Write `src/coupon/coupon-math.ts`**

```ts
import type { Coupon, CouponView } from './coupon.types';

/** Final price in cents after the coupon, clamped to >= 0. */
export function applyCoupon(priceCents: number, coupon: Coupon): number {
  let discount: number;
  if (coupon.type === 'PERCENT') {
    discount = Math.round((priceCents * coupon.value) / 100);
    if (coupon.capCents != null) discount = Math.min(discount, coupon.capCents);
  } else {
    discount = coupon.value;
  }
  return Math.max(0, priceCents - discount);
}

function discountLabel(coupon: Coupon): string {
  if (coupon.type === 'PERCENT') return `-${coupon.value}%`;
  // FIXED: value is cents -> whole reais label, no decimals for round values.
  const reais = coupon.value / 100;
  const n = Number.isInteger(reais)
    ? String(reais)
    : reais.toFixed(2).replace('.', ',');
  return `-R$ ${n}`;
}

/**
 * Per-deal gate. Returns the coupon line to render, or null to render nothing.
 * - inactive / expired / firstBuy / perUser -> null
 * - scope matched + priceCents >= minCents -> PRICE (with finalCents)
 * - below minimum -> CTA (code-only)
 */
export function computeCouponView(
  coupon: Coupon,
  priceCents: number,
  now: Date,
): CouponView | null {
  if (!coupon.active) return null;
  if (coupon.validUntil.getTime() <= now.getTime()) return null;
  if (coupon.firstBuy || coupon.perUser) return null;

  const min = coupon.minCents ?? 0;
  const label = discountLabel(coupon);
  const validUntil = coupon.validUntil.toISOString();

  if (priceCents >= min) {
    return {
      code: coupon.code,
      mode: 'PRICE',
      finalCents: applyCoupon(priceCents, coupon),
      discountLabel: label,
      minCents: coupon.minCents,
      validUntil,
    };
  }
  return {
    code: coupon.code,
    mode: 'CTA',
    finalCents: null,
    discountLabel: label,
    minCents: coupon.minCents,
    validUntil,
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx jest src/coupon/coupon-math.spec.ts`
Expected: PASS (all cases).

- [ ] **Step 6: Commit**

```bash
git add src/coupon/coupon.types.ts src/coupon/coupon-math.ts src/coupon/coupon-math.spec.ts
git commit -m "feat(coupon): pure coupon math + per-deal gate"
```

---

### Task 2: Prisma Coupon model + repository

**Files:**

- Modify: `prisma/schema.prisma` (append after `AffiliateLink`)
- Create: `src/coupon/coupon.repository.ts`

**Interfaces:**

- Consumes: `Coupon` (Task 1), `PrismaService` (`src/db/prisma.service.ts`).
- Produces:
  - `class CouponRepository { findMatching(sellerId: string | null, productId: string, now: Date): Promise<Coupon[]>; create(data: Omit<Coupon, 'id'>): Promise<Coupon> }`
  - Rows map to the `Coupon` type 1:1 (Prisma `Coupon` model fields match).

- [ ] **Step 1: Add the model to `prisma/schema.prisma`**

```prisma
// Manually-registered ML coupons (ml-coupons-v1). scope/type/targetId are
// strings (not enums) so a new scope doesn't require a migration — same
// rationale as WaTarget.channel. Money in integer cents.
model Coupon {
  id            String   @id @default(cuid())
  code          String
  scope         String   // 'SELLER' | 'PRODUCT'
  targetId      String
  type          String   // 'PERCENT' | 'FIXED'
  value         Int
  capCents      Int?
  minCents      Int?
  firstBuy      Boolean  @default(false)
  perUser       Boolean  @default(false)
  validUntil    DateTime
  active        Boolean  @default(true)
  affiliateSafe Boolean  @default(true)
  createdAt     DateTime @default(now())

  @@index([scope, targetId, active])
}
```

- [ ] **Step 2: Generate the migration + client**

Run: `npm run prisma:migrate:dev -- --name add_coupon`
Expected: new folder under `prisma/migrations/*_add_coupon/` and client regenerated. (Requires DB reachable — host pg on **5433**, `DATABASE_URL` from `.env`.)

- [ ] **Step 3: Write `src/coupon/coupon.repository.ts`**

```ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../db/prisma.service';
import type { Coupon, CouponScope, CouponType } from './coupon.types';

function toDomain(row: any): Coupon {
  return {
    id: row.id,
    code: row.code,
    scope: row.scope as CouponScope,
    targetId: row.targetId,
    type: row.type as CouponType,
    value: row.value,
    capCents: row.capCents,
    minCents: row.minCents,
    firstBuy: row.firstBuy,
    perUser: row.perUser,
    validUntil: row.validUntil,
    active: row.active,
    affiliateSafe: row.affiliateSafe,
  };
}

@Injectable()
export class CouponRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Active, unexpired coupons matching this deal's seller or product. */
  async findMatching(
    sellerId: string | null,
    productId: string,
    now: Date,
  ): Promise<Coupon[]> {
    const or: Array<{ scope: string; targetId: string }> = [
      { scope: 'PRODUCT', targetId: productId },
    ];
    if (sellerId) or.push({ scope: 'SELLER', targetId: sellerId });
    const rows = await (this.prisma as any).coupon.findMany({
      where: { active: true, validUntil: { gt: now }, OR: or },
    });
    return rows.map(toDomain);
  }

  async create(data: Omit<Coupon, 'id'>): Promise<Coupon> {
    const row = await (this.prisma as any).coupon.create({ data });
    return toDomain(row);
  }
}
```

- [ ] **Step 4: Verify build (no unit test — thin DB wrapper)**

Run: `npx tsc -p tsconfig.build.json --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/coupon/coupon.repository.ts
git commit -m "feat(coupon): Coupon prisma model + repository"
```

---

### Task 3: CouponService.resolveForDeal (pick best + gate)

**Files:**

- Create: `src/coupon/coupon.service.ts`
- Test: `src/coupon/coupon.service.spec.ts`

**Interfaces:**

- Consumes: `CouponRepository` (Task 2), `computeCouponView` (Task 1), `EnrichedDeal` (`src/sources/source.port.ts`).
- Produces:
  - `class CouponService { resolveForDeal(deal: EnrichedDeal, priceCents: number, now?: Date): Promise<CouponView | null> }`
  - Selection rule: only `deal.key.source === 'ml'`; run the gate on each match; among rendering views prefer PRODUCT scope over SELLER; among the same scope prefer the lowest `finalCents` (PRICE beats CTA). Returns one `CouponView` or null.

- [ ] **Step 1: Write the failing test** — `src/coupon/coupon.service.spec.ts`

```ts
import { CouponService } from './coupon.service';
import type { Coupon } from './coupon.types';
import type { EnrichedDeal } from '../sources/source.port';

const now = new Date('2026-07-15T00:00:00Z');
const mlDeal = (sellerId: string | null, mlb: string): EnrichedDeal =>
  ({
    key: { source: 'ml', externalId: mlb },
    source: 'ml',
    raw: {} as any,
    seller: sellerId ? ({ externalSellerId: sellerId } as any) : null,
    condition: 'new',
    signals: {
      freeShipping: false,
      installmentsNoInterest: false,
      volumeTier: 'none',
      isVerifiedStore: false,
    },
    extras: {},
  }) as EnrichedDeal;

const coupon = (over: Partial<Coupon>): Coupon => ({
  id: 'c',
  code: 'X',
  scope: 'SELLER',
  targetId: 's1',
  type: 'FIXED',
  value: 1000,
  capCents: null,
  minCents: null,
  firstBuy: false,
  perUser: false,
  validUntil: new Date('2999-01-01'),
  active: true,
  affiliateSafe: true,
  ...over,
});

function svc(matches: Coupon[]): CouponService {
  const repo = { findMatching: jest.fn().mockResolvedValue(matches) } as any;
  return new CouponService(repo);
}

describe('CouponService.resolveForDeal', () => {
  it('skips non-ML deals without hitting the repo', async () => {
    const repo = { findMatching: jest.fn() } as any;
    const s = new CouponService(repo);
    const deal = {
      ...mlDeal('s1', 'MLB1'),
      key: { source: 'shopee', externalId: '1' },
      source: 'shopee',
    } as EnrichedDeal;
    expect(await s.resolveForDeal(deal, 10000, now)).toBeNull();
    expect(repo.findMatching).not.toHaveBeenCalled();
  });

  it('returns PRICE view for a matching seller coupon', async () => {
    const v = await svc([
      coupon({ type: 'FIXED', value: 2000 }),
    ]).resolveForDeal(mlDeal('s1', 'MLB1'), 10000, now);
    expect(v).toMatchObject({ mode: 'PRICE', finalCents: 8000 });
  });

  it('PRODUCT scope wins over SELLER scope', async () => {
    const v = await svc([
      coupon({
        scope: 'SELLER',
        targetId: 's1',
        type: 'FIXED',
        value: 1000,
        code: 'SELL',
      }),
      coupon({
        scope: 'PRODUCT',
        targetId: 'MLB1',
        type: 'FIXED',
        value: 500,
        code: 'PROD',
      }),
    ]).resolveForDeal(mlDeal('s1', 'MLB1'), 10000, now);
    expect(v?.code).toBe('PROD');
  });

  it('among same scope, best (lowest final) wins', async () => {
    const v = await svc([
      coupon({ code: 'A', type: 'FIXED', value: 1000 }),
      coupon({ code: 'B', type: 'FIXED', value: 3000 }),
    ]).resolveForDeal(mlDeal('s1', 'MLB1'), 10000, now);
    expect(v?.code).toBe('B'); // 7000 < 9000
  });

  it('returns null when all matches gate out', async () => {
    const v = await svc([coupon({ firstBuy: true })]).resolveForDeal(
      mlDeal('s1', 'MLB1'),
      10000,
      now,
    );
    expect(v).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/coupon/coupon.service.spec.ts`
Expected: FAIL — "Cannot find module './coupon.service'".

- [ ] **Step 3: Write `src/coupon/coupon.service.ts`**

```ts
import { Injectable } from '@nestjs/common';
import type { EnrichedDeal } from '../sources/source.port';
import { computeCouponView } from './coupon-math';
import type { Coupon, CouponView } from './coupon.types';
import { CouponRepository } from './coupon.repository';

@Injectable()
export class CouponService {
  constructor(private readonly repo: CouponRepository) {}

  /** One coupon line for this deal, or null. ML-only in v1. */
  async resolveForDeal(
    deal: EnrichedDeal,
    priceCents: number,
    now: Date = new Date(),
  ): Promise<CouponView | null> {
    if (deal.key.source !== 'ml') return null;

    const sellerId = deal.seller?.externalSellerId ?? null;
    const productId = deal.key.externalId;
    const matches = await this.repo.findMatching(sellerId, productId, now);
    if (matches.length === 0) return null;

    const rank = (c: Coupon, v: CouponView): [number, number] => {
      const scopeRank = c.scope === 'PRODUCT' ? 1 : 0; // product wins
      const priceRank = v.mode === 'PRICE' ? -(v.finalCents ?? 0) : -Infinity;
      return [scopeRank, priceRank]; // higher is better
    };

    let best: CouponView | null = null;
    let bestKey: [number, number] = [-1, -Infinity];
    for (const c of matches) {
      const v = computeCouponView(c, priceCents, now);
      if (!v) continue;
      const k = rank(c, v);
      if (k[0] > bestKey[0] || (k[0] === bestKey[0] && k[1] > bestKey[1])) {
        best = v;
        bestKey = k;
      }
    }
    return best;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/coupon/coupon.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/coupon/coupon.service.ts src/coupon/coupon.service.spec.ts
git commit -m "feat(coupon): CouponService.resolveForDeal with scope/best selection"
```

---

### Task 4: DTO + controller + module wiring

**Files:**

- Create: `src/coupon/dto/create-coupon.dto.ts`
- Create: `src/coupon/coupon.controller.ts`
- Create: `src/coupon/coupon.module.ts`
- Modify: `src/app.module.ts` (add `CouponModule` to `imports`)

**Interfaces:**

- Consumes: `CouponService`/`CouponRepository` (Tasks 2-3), `ApiKeyGuard` (`src/auth/api-key.guard.ts`), `PrismaModule`/`PrismaService`.
- Produces: `POST /coupons` accepting `CreateCouponDto`, returning the created `Coupon`. `CouponModule` exports `CouponService`.

- [ ] **Step 1: Write `src/coupon/dto/create-coupon.dto.ts`**

```ts
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
} from 'class-validator';

export class CreateCouponDto {
  @IsString()
  @MinLength(2)
  code!: string;

  @IsIn(['SELLER', 'PRODUCT'])
  scope!: 'SELLER' | 'PRODUCT';

  /** SELLER -> ML seller id; PRODUCT -> MLB item id. */
  @IsString()
  @MinLength(1)
  targetId!: string;

  @IsIn(['PERCENT', 'FIXED'])
  type!: 'PERCENT' | 'FIXED';

  /** PERCENT: 1-100. FIXED: discount in cents. */
  @IsInt()
  @Min(1)
  value!: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  capCents?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  minCents?: number;

  @IsOptional()
  @IsBoolean()
  firstBuy?: boolean;

  @IsOptional()
  @IsBoolean()
  perUser?: boolean;

  @IsISO8601()
  validUntil!: string;

  @IsOptional()
  @IsBoolean()
  affiliateSafe?: boolean;
}
```

- [ ] **Step 2: Write `src/coupon/coupon.controller.ts`**

```ts
import {
  Body,
  Controller,
  Logger,
  Post,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { CouponRepository } from './coupon.repository';
import { CreateCouponDto } from './dto/create-coupon.dto';

@Controller('coupons')
@UseGuards(ApiKeyGuard)
export class CouponController {
  private readonly logger = new Logger(CouponController.name);

  constructor(private readonly repo: CouponRepository) {}

  @Post()
  async create(
    @Body(new ValidationPipe({ transform: true, whitelist: true }))
    body: CreateCouponDto,
  ) {
    if (body.firstBuy || body.perUser) {
      this.logger.warn(
        `coupon ${body.code} is firstBuy/perUser — it will NEVER render in a post (suppressed by the gate).`,
      );
    }
    if (body.type === 'PERCENT' && body.value > 100) {
      this.logger.warn(
        `coupon ${body.code} PERCENT value > 100 — likely a mistake.`,
      );
    }
    return this.repo.create({
      code: body.code,
      scope: body.scope,
      targetId: body.targetId,
      type: body.type,
      value: body.value,
      capCents: body.capCents ?? null,
      minCents: body.minCents ?? null,
      firstBuy: body.firstBuy ?? false,
      perUser: body.perUser ?? false,
      validUntil: new Date(body.validUntil),
      active: true,
      affiliateSafe: body.affiliateSafe ?? true,
    });
  }
}
```

- [ ] **Step 3: Write `src/coupon/coupon.module.ts`**

```ts
import { Module } from '@nestjs/common';
import { PrismaModule } from '../db/prisma.module';
import { CouponController } from './coupon.controller';
import { CouponRepository } from './coupon.repository';
import { CouponService } from './coupon.service';

@Module({
  imports: [PrismaModule],
  controllers: [CouponController],
  providers: [CouponRepository, CouponService],
  exports: [CouponService],
})
export class CouponModule {}
```

> NOTE: confirm the Prisma module export name. If the project exposes `PrismaService` via a global/`DbModule` instead of `PrismaModule`, import that module here and drop `imports`. Check `src/db/` before writing.

- [ ] **Step 4: Register in `src/app.module.ts`**

Add `import { CouponModule } from './coupon/coupon.module';` and add `CouponModule` to the `imports` array of `@Module`.

- [ ] **Step 5: Verify build + boot-time DI**

Run: `npx tsc -p tsconfig.build.json --noEmit`
Expected: no errors. (Full DI is exercised in Task 5 where the pipeline consumes `CouponService`.)

- [ ] **Step 6: Commit**

```bash
git add src/coupon/dto/create-coupon.dto.ts src/coupon/coupon.controller.ts src/coupon/coupon.module.ts src/app.module.ts
git commit -m "feat(coupon): POST /coupons endpoint + module wiring"
```

---

### Task 5: Queue types + pipeline plumb (resolve at enqueue)

**Files:**

- Modify: `src/queue/queue.types.ts`
- Modify: `src/pipeline/pipeline.service.ts`
- Modify: `src/pipeline/pipeline.service.spec.ts` (constructor arg count)

**Interfaces:**

- Consumes: `CouponService.resolveForDeal` (Task 3), `CouponView` (Task 1).
- Produces: `SendDealJob.couponView?: CouponView`, `DigestDealEntry.couponView?: CouponView`; pipeline injects `CouponService` as a new constructor dependency (added **last** so existing positional mocks shift predictably).

- [ ] **Step 1: Add `couponView?` to `src/queue/queue.types.ts`**

Add `import type { CouponView } from '../coupon/coupon.types';` at top, then add to both `SendDealJob` and `DigestDealEntry`:

```ts
  /** Matched ML coupon line (ml-coupons-v1). Absent = no coupon for this deal. */
  couponView?: CouponView;
```

- [ ] **Step 2: Inject `CouponService` into `PipelineService`**

In `src/pipeline/pipeline.service.ts`, add import:

```ts
import { CouponService } from '../coupon/coupon.service';
import type { CouponView } from '../coupon/coupon.types';
```

Add as the **last** constructor parameter (after the `priceScraper` inject):

```ts
    @Inject(PRICE_SCRAPER_PORT)
    private readonly priceScraper: PriceScraperPort,
    private readonly coupons: CouponService,
  ) {}
```

- [ ] **Step 3: Resolve coupon per selected deal in `enqueueScored`**

Right after the `priceViews` population loop (the `for (const { scored: sd } of selected)` block that ends near line 218), add a sibling map. `applyPriceView` has already mutated `sd.deal.raw.priceCents` to the scraped price, so resolve the coupon against that corrected price:

```ts
// Resolve one matching coupon per approved deal (format-only). Uses the
// corrected (post-scrape) priceCents so the gate's minimum test and the
// final-price math match the number shown to the user.
const couponViews = new Map<string, CouponView>();
for (const { scored: sd } of selected) {
  try {
    const cv = await this.coupons.resolveForDeal(
      sd.deal,
      sd.deal.raw.priceCents,
    );
    if (cv) couponViews.set(keyToString(sd.deal.key), cv);
  } catch (err) {
    this.logger.warn(
      `coupon resolve failed for ${keyToString(sd.deal.key)}: ${(err as Error).message}`,
    );
  }
}
```

- [ ] **Step 4: Attach `couponView` to both job shapes**

In `addSingle`, add to the `sendQueue.add('send-deal', {...})` payload (next to `priceView`):

```ts
            couponView: couponViews.get(catalogKey),
```

In the digest `sendQueue.add('send-digest', {...})` payload, add to each mapped deal entry (next to `priceView`):

```ts
                couponView: couponViews.get(keyToString(sd.deal.key)),
```

- [ ] **Step 5: Fix the pipeline spec constructor**

In `src/pipeline/pipeline.service.spec.ts`, find where `new PipelineService(...)` is constructed and append a `CouponService` mock as the final argument:

```ts
      { resolveForDeal: jest.fn().mockResolvedValue(null) } as any,
```

(It is the 12th constructor arg — after the price-scraper mock.)

- [ ] **Step 6: Run pipeline tests + build**

Run: `npx jest src/pipeline/pipeline.service.spec.ts && npx tsc -p tsconfig.build.json --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/queue/queue.types.ts src/pipeline/pipeline.service.ts src/pipeline/pipeline.service.spec.ts
git commit -m "feat(coupon): plumb couponView through pipeline enqueue"
```

---

### Task 6: Formatter renders the coupon line

**Files:**

- Modify: `src/pipeline/formatter.service.ts`
- Modify: `src/pipeline/formatter.service.spec.ts`

**Interfaces:**

- Consumes: `CouponView` (Task 1).
- Produces: `formatScored(scored, variant?, trustBadge?, priceView?, couponView?)` and `digestBlock(sd, variant, link, priceView?, couponView?)` gain a trailing optional `couponView`. New private `couponLine(couponView?): string | null`.

- [ ] **Step 1: Write the failing tests** — add to `src/pipeline/formatter.service.spec.ts`

```ts
// Uses the existing formatter test harness in this file (affiliate + headline mocks).
describe('coupon line', () => {
  it('PRICE mode shows final price + code', async () => {
    const { caption } = await formatter.formatScored(
      scoredFixture,
      'A',
      undefined,
      undefined,
      {
        code: 'ABC',
        mode: 'PRICE',
        finalCents: 8000,
        discountLabel: '-R$ 20',
        minCents: null,
        validUntil: '2999-01-01T00:00:00.000Z',
      },
    );
    expect(caption).toContain('🎟️');
    expect(caption).toContain('ABC');
    expect(caption).toContain('R$'); // R$ 80,00 final
  });

  it('CTA mode shows code + threshold, no final price claim', async () => {
    const { caption } = await formatter.formatScored(
      scoredFixture,
      'A',
      undefined,
      undefined,
      {
        code: 'XYZ',
        mode: 'CTA',
        finalCents: null,
        discountLabel: '-R$ 20',
        minCents: 10000,
        validUntil: '2999-01-01T00:00:00.000Z',
      },
    );
    expect(caption).toContain('🎟️');
    expect(caption).toContain('XYZ');
    expect(caption).toContain('acima de');
  });

  it('no couponView -> no coupon line', async () => {
    const { caption } = await formatter.formatScored(scoredFixture, 'A');
    expect(caption).not.toContain('🎟️');
  });
});
```

> NOTE: reuse this file's existing `formatter` instance and a scored fixture (named `scoredFixture` here — rename to whatever the file already defines). If no reusable fixture exists, lift the one from the nearest existing `formatScored` test in this file.

- [ ] **Step 2: Run to verify failure**

Run: `npx jest src/pipeline/formatter.service.spec.ts -t "coupon line"`
Expected: FAIL — extra arg ignored / no `🎟️` in caption.

- [ ] **Step 3: Add the coupon line + thread the param**

Add import at top: `import type { CouponView } from '../coupon/coupon.types';`

Add signature param to `formatScored` (trailing):

```ts
    priceView?: PriceView,
    couponView?: CouponView,
  ): Promise<{ caption: string; imageUrl: string }> {
```

Change the body assembly so the coupon line is appended right after the price extras. Replace the `injectPriceExtras(...)` assignment with:

```ts
let body = this.injectPriceExtras(
  tmpl(scored, formatBRL, link, hook, trustLine),
  priceView,
);
const cLine = this.couponLine(couponView);
if (cLine) body = this.appendCouponLine(body, cLine);
```

Add the two private helpers (place next to `priceExtraLines`):

```ts
  /** One coupon line for the caption, or null. */
  private couponLine(cv?: CouponView): string | null {
    if (!cv) return null;
    const until = this.formatUntil(cv.validUntil);
    if (cv.mode === 'PRICE' && cv.finalCents != null) {
      return `🎟️ Com cupom *${cv.code}*: ${this.formatBRL(cv.finalCents / 100)} (válido até ${until})`;
    }
    // CTA (below minimum)
    const min = cv.minCents != null ? ` (acima de ${this.formatBRL(cv.minCents / 100)})` : '';
    return `🎟️ Cupom *${cv.code}* ${cv.discountLabel}${min} — válido até ${until}`;
  }

  /** Insert the coupon line right under the price block (after Pix/installments). */
  private appendCouponLine(body: string, line: string): string {
    const lines = body.split('\n');
    let idx = lines.findIndex((l) => /NO PIX|sem juros/.test(l));
    if (idx === -1) idx = lines.findIndex((l) => /\(-\d+%\)/.test(l));
    if (idx === -1) idx = lines.findIndex((l) => /R\$/.test(l));
    if (idx === -1) return [body, line].join('\n');
    lines.splice(idx + 1, 0, line);
    return lines.join('\n');
  }

  private formatUntil(iso: string): string {
    const d = new Date(iso);
    return d.toLocaleDateString('pt-BR', {
      day: '2-digit', month: '2-digit',
      timeZone: process.env.TZ ?? 'America/Sao_Paulo',
    });
  }
```

Thread the param through `digestBlock` too — add `couponView?: CouponView` as its trailing param, and after `lines.push(...this.priceExtraLines(priceView));` add:

```ts
const cLine = this.couponLine(couponView);
if (cLine) lines.push(cLine);
```

Then in `formatDigest`, pass it: change the `blocks` map to
`this.digestBlock(e.scored, e.variant, links[i], e.priceView, e.couponView)`
and add `couponView?: CouponView;` to the `entries` array element type.

- [ ] **Step 4: Run to verify pass**

Run: `npx jest src/pipeline/formatter.service.spec.ts`
Expected: PASS (new + existing).

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/formatter.service.ts src/pipeline/formatter.service.spec.ts
git commit -m "feat(coupon): render coupon line in single + digest captions"
```

---

### Task 7: Worker passes couponView + re-checks validUntil at send

**Files:**

- Modify: `src/worker/send-deal.worker.ts`
- Modify: `src/worker/send-deal.worker.spec.ts`

**Interfaces:**

- Consumes: `SendDealJob.couponView` (Task 5), `formatScored(... couponView)` (Task 6).
- Produces: worker forwards `job.data.couponView` to the formatter, but drops it (passes `undefined`) when `couponView.validUntil <= now` so a queued job can't post an expired code.

- [ ] **Step 1: Write the failing test** — add to `src/worker/send-deal.worker.spec.ts`

```ts
describe('coupon expiry at send', () => {
  it('forwards a still-valid couponView to the formatter', async () => {
    const cv = {
      code: 'ABC',
      mode: 'PRICE',
      finalCents: 8000,
      discountLabel: '-R$ 20',
      minCents: null,
      validUntil: '2999-01-01T00:00:00.000Z',
    };
    await processJob({ ...baseJob, couponView: cv }); // baseJob = existing single-deal fixture in this file
    expect(formatScoredMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      cv,
    );
  });

  it('drops an expired couponView (passes undefined)', async () => {
    const cv = {
      code: 'OLD',
      mode: 'PRICE',
      finalCents: 8000,
      discountLabel: '-R$ 20',
      minCents: null,
      validUntil: '2000-01-01T00:00:00.000Z',
    };
    await processJob({ ...baseJob, couponView: cv });
    expect(formatScoredMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      undefined,
    );
  });
});
```

> NOTE: match the existing spec's harness — reuse its `formatScored` mock name and job fixture; `processJob` here stands for however this file invokes the worker processor.

- [ ] **Step 2: Run to verify failure**

Run: `npx jest src/worker/send-deal.worker.spec.ts -t "coupon expiry"`
Expected: FAIL — formatter called without the 5th arg.

- [ ] **Step 3: Forward couponView with an expiry guard**

In `src/worker/send-deal.worker.ts`, where it calls `formatScored(...)` for a single deal, compute a guarded value and pass it as the trailing arg:

```ts
const couponView =
  job.data.couponView &&
  new Date(job.data.couponView.validUntil).getTime() > Date.now()
    ? job.data.couponView
    : undefined;

const { caption, imageUrl } = await this.formatter.formatScored(
  job.data.scored,
  job.data.variant,
  job.data.trustBadge,
  job.data.priceView,
  couponView,
);
```

For the digest path (`send-digest`), map the same guard per entry when building the `entries` passed to `formatDigest`:

```ts
        couponView:
          d.couponView && new Date(d.couponView.validUntil).getTime() > Date.now()
            ? d.couponView
            : undefined,
```

- [ ] **Step 4: Run to verify pass**

Run: `npx jest src/worker/send-deal.worker.spec.ts`
Expected: PASS.

- [ ] **Step 5: Full suite + prod typecheck**

Run: `npm test && npx tsc -p tsconfig.build.json --noEmit`
Expected: all green (≥ 254 + new tests), no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/worker/send-deal.worker.ts src/worker/send-deal.worker.spec.ts
git commit -m "feat(coupon): worker forwards couponView, drops expired at send"
```

---

## Manual verification (after Task 7)

1. Rebuild + recreate the container (env change rule): `docker compose up -d --force-recreate app`.
2. Register a test coupon (from inside container, against `localhost:3000`):
   ```bash
   curl -s -XPOST localhost:3000/coupons -H "x-api-key: $API_KEY" -H 'content-type: application/json' \
     -d '{"code":"TESTE10","scope":"SELLER","targetId":"<ML_SELLER_ID_OF_A_LIVE_DEAL>","type":"PERCENT","value":10,"validUntil":"2026-08-01T00:00:00Z"}'
   ```
3. Force a post (feed is deduped by default — temporarily set `DEDUP_WINDOW_DAYS=0`, force-recreate, then `POST /pipeline/trigger`), inspect `SentMessage.caption` in DB for the `🎟️` line, then restore `DEDUP_WINDOW_DAYS=14`.
4. Confirm a below-minimum coupon renders the CTA line, and a `firstBuy` coupon renders nothing.

## Open items / assumptions to confirm during build

- Prisma module name in Task 4 (`PrismaModule` vs a global `DbModule`) — check `src/db/` before wiring.
- `sd.deal.seller` is populated for ML deals at enqueue (post ml-items-403 fix). If null, SELLER-scoped coupons silently won't match — log a debug count if this shows up.
- `affiliateSafe` is captured but unused in v1 (no UI surfaces it) — that's intentional; it exists for a future "skip/flag risky coupons" step.
