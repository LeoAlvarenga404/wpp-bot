# Composer de Deal Manual — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Uma tab "Novo deal" no painel onde o operador cola um link ML (inclusive `meli.la` encurtado) ou monta um deal do zero, edita imagem/texto/preço/cupom/link com preview ao vivo, e escolhe "Pra fila" ou "Dispara já".

**Architecture:** O `resolve` deixa de criar card e passa a devolver campos pra preencher o form. Um endpoint `preview` stateless renderiza a caption exata. Um submit unificado cria o card e, com `dispatch`, aprova urgent no mesmo request. Cupom viaja como `sd.curatorEdits.coupon` no snapshot — a mecânica de edição (issue #6) já leva isso até o envio; só falta o render do card honrar. Short link é expandido via redirect HTTP antes de extrair o id.

**Tech Stack:** NestJS + TypeScript (backend), Jest (testes), React 19 + Vite + Tailwind v4 (painel `web/`), Prisma/BullMQ downstream (intocados).

## Global Constraints

- Runtime: NestJS, Node (container `node` user). Testes: Jest (`npm test`).
- Painel: React + Vite, Tailwind v4 (`@import 'tailwindcss'`), tema dark stone (`bg-stone-950 text-stone-100`). Sem libs novas.
- Cupom manual = `CuratorCouponEdit { code: string; finalCents?: number }` (`web/src/types.ts:47`, `src/shared/curator-edits.ts`).
- Deal manual = score sentinela `MANUAL_DEAL_SCORE = 100`, `deal.extras.manual = true`, auditado em stage `approval_manual` (já implementado — não mexer).
- Nenhum card fantasma: resolve/submit que falha NÃO deixa card (invariante da issue #8).
- Sem storage/upload: imagem é sempre uma URL.
- Copy do painel em pt-BR.

---

## File Structure

**Backend:**
- `src/curation/manual/url-expander.ts` — CRIAR. `expandShortUrl` + token DI `SHORT_URL_EXPANDER`.
- `src/curation/manual/ml-manual-resolver.ts` — MODIFICAR. Expande short link antes do `extractMlId`.
- `src/curation/dto/create-manual-deal.dto.ts` — CRIAR. Submit unificado (campos + `dispatch`, `permalink` opcional).
- `src/curation/dto/preview-manual.dto.ts` — CRIAR. Mesmos campos, sem `dispatch`.
- `src/curation/dto/create-generic-manual.dto.ts` — REMOVER (folded no submit).
- `src/curation/manual/manual-deal.service.ts` — MODIFICAR. `resolveUrl`→prefill; `preview`; `submit`; helper `fieldsToScored`. Remove `createGeneric`.
- `src/curation/approval-queue.service.ts` — MODIFICAR. `resolveCoupon` honra `curatorEdits.coupon`; novo público `renderManualPreview`.
- `src/curation/approval.controller.ts` — MODIFICAR. Rotas resolve/preview/submit; remove `/manual/generic`.
- `src/curation/approval.module.ts` — MODIFICAR. Provider do expander.

**Frontend (`web/`):**
- `web/src/components/ManualComposer.tsx` — CRIAR. Split form + preview + ações.
- `web/src/api.ts` — MODIFICAR. `resolveManual`, `previewManual`, `submitManual`.
- `web/src/types.ts` — MODIFICAR. Tipos do composer.
- `web/src/App.tsx` — MODIFICAR. Tab "Novo deal" + container largo no modo compose.

---

## Task 1: Short-link expander

**Files:**
- Create: `src/curation/manual/url-expander.ts`
- Test: `src/curation/manual/url-expander.spec.ts`

**Interfaces:**
- Consumes: nada.
- Produces:
  - `export const SHORT_URL_EXPANDER: symbol`
  - `export interface ShortUrlExpander { expand(url: string): Promise<string> }`
  - `export function isShortMeliUrl(url: string): boolean`
  - `export class HttpShortUrlExpander implements ShortUrlExpander` — segue redirect via `fetch`, timeout 5s, falha → devolve `url` original.

- [ ] **Step 1: Write the failing test**

```typescript
// src/curation/manual/url-expander.spec.ts
import {
  HttpShortUrlExpander,
  isShortMeliUrl,
} from './url-expander';

describe('isShortMeliUrl', () => {
  it('recognizes meli.la short links', () => {
    expect(isShortMeliUrl('https://meli.la/x9Kq2')).toBe(true);
  });
  it('ignores full product links', () => {
    expect(isShortMeliUrl('https://www.mercadolivre.com.br/p/MLB123')).toBe(
      false,
    );
  });
});

describe('HttpShortUrlExpander', () => {
  const finalUrl = 'https://www.mercadolivre.com.br/p/MLB123?ref=x';

  it('returns the final URL after following the redirect', async () => {
    const fetchFn = jest.fn().mockResolvedValue({
      url: finalUrl,
      ok: true,
    } as Response);
    const exp = new HttpShortUrlExpander(fetchFn, 5000);
    await expect(exp.expand('https://meli.la/x9Kq2')).resolves.toBe(finalUrl);
  });

  it('falls back to the original URL when fetch throws', async () => {
    const fetchFn = jest.fn().mockRejectedValue(new Error('network'));
    const exp = new HttpShortUrlExpander(fetchFn, 5000);
    await expect(exp.expand('https://meli.la/x9Kq2')).resolves.toBe(
      'https://meli.la/x9Kq2',
    );
  });

  it('falls back to the original URL when the response has no url', async () => {
    const fetchFn = jest.fn().mockResolvedValue({ url: '', ok: true } as Response);
    const exp = new HttpShortUrlExpander(fetchFn, 5000);
    await expect(exp.expand('https://meli.la/x9Kq2')).resolves.toBe(
      'https://meli.la/x9Kq2',
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/curation/manual/url-expander.spec.ts`
Expected: FAIL — `Cannot find module './url-expander'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/curation/manual/url-expander.ts
export const SHORT_URL_EXPANDER = Symbol('SHORT_URL_EXPANDER');

export interface ShortUrlExpander {
  /** Follow redirects and return the final URL. Never throws — on any
   *  failure returns the input unchanged so the caller degrades cleanly. */
  expand(url: string): Promise<string>;
}

/** Short-link hosts we expand before extracting a product id. */
export function isShortMeliUrl(url: string): boolean {
  return /(^|\/\/)([a-z0-9.-]*\.)?meli\.la\//i.test(url);
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export class HttpShortUrlExpander implements ShortUrlExpander {
  constructor(
    private readonly fetchFn: FetchFn = fetch,
    private readonly timeoutMs = 5000,
  ) {}

  async expand(url: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      // `fetch` follows redirects by default; res.url is the final URL.
      const res = await this.fetchFn(url, {
        redirect: 'follow',
        signal: controller.signal,
      });
      return res.url && res.url.length > 0 ? res.url : url;
    } catch {
      return url;
    } finally {
      clearTimeout(timer);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/curation/manual/url-expander.spec.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/curation/manual/url-expander.ts src/curation/manual/url-expander.spec.ts
git commit -m "feat(manual): short-link expander (meli.la redirect follow)"
```

---

## Task 2: ML resolver expands short links

**Files:**
- Modify: `src/curation/manual/ml-manual-resolver.ts`
- Test: `src/curation/manual/ml-manual-resolver.spec.ts` (existing — add cases)

**Interfaces:**
- Consumes: `ShortUrlExpander` (Task 1), `SHORT_URL_EXPANDER`, `isShortMeliUrl`; `PRODUCT_SCRAPER_PORT` / `ProductScraperPort` (existing).
- Produces: `MlManualResolver` unchanged public shape (`canResolve`, `resolve`), now expands short links internally. Constructor gains a second injected dep `SHORT_URL_EXPANDER`.

- [ ] **Step 1: Write the failing test**

Append to `src/curation/manual/ml-manual-resolver.spec.ts`. If the file mints the resolver without an expander, update the existing `beforeEach`/factory to pass a stub expander too.

```typescript
// add near the existing MlManualResolver tests
describe('MlManualResolver short links', () => {
  const view = {
    title: 'Fone JBL',
    thumbnail: 'https://http2.mlstatic.com/x.jpg',
    priceCents: 17900,
    originalPriceCents: 29900,
    discountPercent: 40,
    installments: { noInterest: true, count: 10, valueCents: 1790 },
  };

  it('expands a meli.la link, then resolves with the expanded id + url', async () => {
    const scraper = { scrapeProductView: jest.fn().mockResolvedValue(view) };
    const expander = {
      expand: jest
        .fn()
        .mockResolvedValue('https://www.mercadolivre.com.br/p/MLB123'),
    };
    const resolver = new MlManualResolver(scraper as never, expander as never);

    const out = await resolver.resolve('https://meli.la/x9Kq2');

    expect(expander.expand).toHaveBeenCalledWith('https://meli.la/x9Kq2');
    expect(out.key.externalId).toBe('MLB123');
    expect(out.permalink).toBe('https://www.mercadolivre.com.br/p/MLB123');
    expect(scraper.scrapeProductView).toHaveBeenCalledWith(
      'https://www.mercadolivre.com.br/p/MLB123',
    );
  });

  it('does NOT expand a link that already carries an MLB id', async () => {
    const scraper = { scrapeProductView: jest.fn().mockResolvedValue(view) };
    const expander = { expand: jest.fn() };
    const resolver = new MlManualResolver(scraper as never, expander as never);

    await resolver.resolve('https://www.mercadolivre.com.br/p/MLB999');

    expect(expander.expand).not.toHaveBeenCalled();
  });

  it('throws invalid_url when expansion still yields no id', async () => {
    const scraper = { scrapeProductView: jest.fn() };
    const expander = {
      expand: jest.fn().mockResolvedValue('https://mercadolivre.com.br/ofertas'),
    };
    const resolver = new MlManualResolver(scraper as never, expander as never);

    await expect(resolver.resolve('https://meli.la/nope')).rejects.toMatchObject(
      { code: 'invalid_url' },
    );
    expect(scraper.scrapeProductView).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/curation/manual/ml-manual-resolver.spec.ts`
Expected: FAIL — `MlManualResolver` constructor takes 1 arg / `expand` not called.

- [ ] **Step 3: Write minimal implementation**

Edit `src/curation/manual/ml-manual-resolver.ts`:

```typescript
import { Inject, Injectable } from '@nestjs/common';
import {
  PRODUCT_SCRAPER_PORT,
  type ProductScraperPort,
} from '../../pricing/product-scraper.port';
import {
  SHORT_URL_EXPANDER,
  isShortMeliUrl,
  type ShortUrlExpander,
} from './url-expander';
import {
  ManualResolveError,
  type ManualDealResolver,
  type ResolvedManualDeal,
} from './manual-resolver.port';

// extractMlId unchanged — keep the existing exported function.

@Injectable()
export class MlManualResolver implements ManualDealResolver {
  readonly source = 'ml' as const;

  constructor(
    @Inject(PRODUCT_SCRAPER_PORT)
    private readonly scraper: ProductScraperPort,
    @Inject(SHORT_URL_EXPANDER)
    private readonly expander: ShortUrlExpander,
  ) {}

  canResolve(url: string): boolean {
    return /mercadolivre\.com|mercadolibre\.com|meli\.la/i.test(url);
  }

  async resolve(url: string): Promise<ResolvedManualDeal> {
    let target = url;
    let externalId = extractMlId(target);
    if (!externalId && isShortMeliUrl(target)) {
      target = await this.expander.expand(target);
      externalId = extractMlId(target);
    }
    if (!externalId) {
      throw new ManualResolveError(
        'invalid_url',
        'URL sem código do produto (MLB…). Cole o link direto do anúncio.',
      );
    }

    const view = await this.scraper.scrapeProductView(target);
    if (!view || typeof view.priceCents !== 'number') {
      throw new ManualResolveError(
        'scrape_failed',
        'Não consegui ler a página do produto — verifique o link ou tente de novo.',
      );
    }

    return {
      key: { source: 'ml', externalId },
      source: 'ml',
      title: view.title,
      priceCents: view.priceCents,
      originalPriceCents: view.originalPriceCents,
      discountPercent: view.discountPercent ?? 0,
      thumbnail: view.thumbnail,
      permalink: target,
      installmentsNoInterest: view.installments?.noInterest ?? false,
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/curation/manual/ml-manual-resolver.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/curation/manual/ml-manual-resolver.ts src/curation/manual/ml-manual-resolver.spec.ts
git commit -m "feat(manual): resolve meli.la short links via expander"
```

---

## Task 3: Coupon in snapshot + stateless render

**Files:**
- Modify: `src/curation/approval-queue.service.ts` (`resolveCoupon` ~line 419; add `renderManualPreview`)
- Test: `src/curation/approval-queue.service.spec.ts` (existing — add cases)

**Interfaces:**
- Consumes: `couponViewFromCuratorEdit` (already imported), `ScoredDeal`, `renderCaption` (private), `resolveCoupon` (private).
- Produces:
  - `resolveCoupon(sd)` now returns the curator coupon view when `sd.curatorEdits?.coupon` is set, else the automatic resolver result.
  - `async renderManualPreview(sd: ScoredDeal): Promise<{ caption: string; imageUrl: string }>` — public; renders exactly what a manual card/dispatch would show.

- [ ] **Step 1: Write the failing test**

Add to `src/curation/approval-queue.service.spec.ts` (reuse the existing service factory/mocks in the file):

```typescript
it('renderManualPreview renders the curator coupon from the snapshot', async () => {
  // build a synthetic manual ScoredDeal (à-vista R$100) with a coupon edit
  const sd = manualScoredDeal({ priceCents: 10000 }); // helper already used in file, or inline toScoredDeal
  sd.curatorEdits = { coupon: { code: 'JBL20', finalCents: 8000 } };

  const out = await service.renderManualPreview(sd);

  expect(out.caption).toContain('JBL20');
});
```

If the spec file has no `manualScoredDeal` helper, build the deal inline with `toScoredDeal` from `./manual/manual-resolver.port`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/curation/approval-queue.service.spec.ts -t renderManualPreview`
Expected: FAIL — `service.renderManualPreview is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `src/curation/approval-queue.service.ts`, change `resolveCoupon` to prefer the curator coupon:

```typescript
  /** Coupon line is best-effort — a coupon lookup failure never hides a card.
   *  A curator-set coupon (manual composer / card edit) wins over the
   *  automatic resolver so the panel and the send path agree. */
  private async resolveCoupon(sd: ScoredDeal): Promise<CouponView | undefined> {
    const edit = sd.curatorEdits?.coupon;
    if (edit) {
      return couponViewFromCuratorEdit(edit, sd.deal.raw.priceCents, this.now());
    }
    try {
      return (
        (await this.coupons.resolveForDeal(
          sd.deal,
          sd.deal.raw.priceCents,
          this.now(),
        )) ?? undefined
      );
    } catch (err) {
      this.logger.warn(
        `coupon resolve failed (${keyToString(sd.deal.key)}): ${(err as Error).message}`,
      );
      return undefined;
    }
  }
```

Add the public render method (place next to `preview`):

```typescript
  /**
   * Stateless render for the manual composer's live preview: no row, no
   * decision — renders the exact caption a manual card/dispatch would show
   * from a synthetic ScoredDeal (coupon honored via curatorEdits).
   */
  async renderManualPreview(
    sd: ScoredDeal,
  ): Promise<{ caption: string; imageUrl: string }> {
    return this.renderCaption(sd, await this.resolveCoupon(sd));
  }
```

Confirm `couponViewFromCuratorEdit` is imported (it is — line ~22). Confirm `ScoredDeal.curatorEdits` typing exists on the type (it's set by `applyEdits`); if the type lacks it, add `curatorEdits?: CuratorEdits` to the `ScoredDeal` type in `src/deal-score/types.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/curation/approval-queue.service.spec.ts`
Expected: PASS (new test + existing green).

- [ ] **Step 5: Commit**

```bash
git add src/curation/approval-queue.service.ts src/curation/approval-queue.service.spec.ts src/deal-score/types.ts
git commit -m "feat(approval): curator coupon in snapshot + stateless manual render"
```

---

## Task 4: Composer DTOs

**Files:**
- Create: `src/curation/dto/create-manual-deal.dto.ts`
- Create: `src/curation/dto/preview-manual.dto.ts`
- Delete: `src/curation/dto/create-generic-manual.dto.ts`
- Test: `src/curation/dto/create-manual-deal.dto.spec.ts`

**Interfaces:**
- Produces:
  - `CreateManualDealDto { store; title; priceCents; originalPriceCents?; installmentsNoInterest?; coupon?: {code; finalCents?}; thumbnail; permalink?; dispatch? }`
  - `PreviewManualDto` = same fields minus `dispatch`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/curation/dto/create-manual-deal.dto.spec.ts
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateManualDealDto } from './create-manual-deal.dto';

async function errs(obj: unknown) {
  return validate(plainToInstance(CreateManualDealDto, obj));
}

describe('CreateManualDealDto', () => {
  const base = {
    store: 'ml',
    title: 'Fone JBL',
    priceCents: 17900,
    thumbnail: 'https://http2.mlstatic.com/x.jpg',
  };

  it('accepts a minimal deal without a link', async () => {
    expect(await errs(base)).toHaveLength(0);
  });

  it('accepts a full deal with coupon, link and dispatch', async () => {
    expect(
      await errs({
        ...base,
        originalPriceCents: 29900,
        installmentsNoInterest: true,
        coupon: { code: 'JBL20', finalCents: 15000 },
        permalink: 'https://www.mercadolivre.com.br/p/MLB1',
        dispatch: true,
      }),
    ).toHaveLength(0);
  });

  it('rejects a non-positive price', async () => {
    expect((await errs({ ...base, priceCents: 0 })).length).toBeGreaterThan(0);
  });

  it('rejects a thumbnail that is not an http url', async () => {
    expect(
      (await errs({ ...base, thumbnail: 'not-a-url' })).length,
    ).toBeGreaterThan(0);
  });

  it('rejects a permalink that is present but not an http url', async () => {
    expect(
      (await errs({ ...base, permalink: 'ftp://x' })).length,
    ).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/curation/dto/create-manual-deal.dto.spec.ts`
Expected: FAIL — `Cannot find module './create-manual-deal.dto'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/curation/dto/create-manual-deal.dto.ts
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  IsUrl,
  ValidateNested,
} from 'class-validator';

export class ManualCouponDto {
  @IsString({ message: 'coupon.code deve ser uma string' })
  code!: string;

  @IsOptional()
  @IsInt({ message: 'coupon.finalCents deve ser um número inteiro' })
  @IsPositive({ message: 'coupon.finalCents deve ser maior que zero' })
  finalCents?: number;
}

export class CreateManualDealDto {
  @IsString({ message: 'store deve ser uma string' })
  store!: string;

  @IsString({ message: 'title deve ser uma string' })
  title!: string;

  @IsInt({ message: 'priceCents deve ser um número inteiro' })
  @IsPositive({ message: 'priceCents deve ser maior que zero' })
  priceCents!: number;

  @IsOptional()
  @IsInt({ message: 'originalPriceCents deve ser um número inteiro' })
  @IsPositive({ message: 'originalPriceCents deve ser maior que zero' })
  originalPriceCents?: number;

  @IsOptional()
  @IsBoolean({ message: 'installmentsNoInterest deve ser boolean' })
  installmentsNoInterest?: boolean;

  @IsOptional()
  @ValidateNested()
  @Type(() => ManualCouponDto)
  coupon?: ManualCouponDto;

  @IsString({ message: 'thumbnail deve ser uma string' })
  @IsUrl(
    { require_protocol: true },
    { message: 'thumbnail deve ser um link http(s) válido' },
  )
  thumbnail!: string;

  @IsOptional()
  @IsUrl(
    { require_protocol: true },
    { message: 'permalink deve ser um link http(s) válido' },
  )
  permalink?: string;

  @IsOptional()
  @IsBoolean({ message: 'dispatch deve ser boolean' })
  dispatch?: boolean;
}
```

```typescript
// src/curation/dto/preview-manual.dto.ts
import { OmitType } from '@nestjs/mapped-types';
import { CreateManualDealDto } from './create-manual-deal.dto';

/** Same body as the submit, minus dispatch — the live-preview render. */
export class PreviewManualDto extends OmitType(CreateManualDealDto, [
  'dispatch',
] as const) {}
```

Then delete the old DTO:

```bash
git rm src/curation/dto/create-generic-manual.dto.ts
```

If `@nestjs/mapped-types` is not already a dependency, define `PreviewManualDto` by copying the fields explicitly instead of `OmitType` (check `package.json` first: `grep mapped-types package.json`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/curation/dto/create-manual-deal.dto.spec.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/curation/dto/create-manual-deal.dto.ts src/curation/dto/preview-manual.dto.ts src/curation/dto/create-manual-deal.dto.spec.ts
git rm src/curation/dto/create-generic-manual.dto.ts
git commit -m "feat(manual): composer DTOs (create + preview), drop generic dto"
```

---

## Task 5: ManualDealService — resolve prefill, preview, submit

**Files:**
- Modify: `src/curation/manual/manual-deal.service.ts`
- Test: `src/curation/manual/manual-deal.service.spec.ts` (existing — rewrite)

**Interfaces:**
- Consumes: `MANUAL_RESOLVERS`, `ApprovalQueueService` (`createManual`, `approve`, `renderManualPreview`), `toScoredDeal`, `extractMlId` (from `./ml-manual-resolver`), `CreateManualDealDto`, `PreviewManualDto`.
- Produces:
  - `resolveUrl(url: string): Promise<ResolvedManualView>` where
    `ResolvedManualView = Omit<ResolvedManualDeal, 'key'>`. **No card created.**
  - `preview(dto: PreviewManualDto): Promise<{ caption: string; imageUrl: string }>`
  - `submit(dto: CreateManualDealDto): Promise<PendingSummary | DispatchResult>`
    where `DispatchResult = { id: string; catalogId: string; enqueued: number; targets: number }`.
  - private `fieldsToScored(dto): ScoredDeal` — builds the synthetic ScoredDeal (derives externalId + discount, sets `curatorEdits.coupon`).

- [ ] **Step 1: Write the failing test**

Rewrite `src/curation/manual/manual-deal.service.spec.ts`:

```typescript
import { ManualDealService } from './manual-deal.service';
import { toScoredDeal } from './manual-resolver.port';

const resolved = {
  key: { source: 'ml', externalId: 'MLB123' },
  source: 'ml' as const,
  title: 'Fone JBL',
  priceCents: 17900,
  originalPriceCents: 29900,
  discountPercent: 40,
  thumbnail: 'https://http2.mlstatic.com/x.jpg',
  permalink: 'https://www.mercadolivre.com.br/p/MLB123',
  installmentsNoInterest: true,
};

function make() {
  const resolver = {
    canResolve: jest.fn().mockReturnValue(true),
    resolve: jest.fn().mockResolvedValue(resolved),
    source: 'ml',
  };
  const queue = {
    createManual: jest
      .fn()
      .mockResolvedValue({ id: 'card1', catalogId: 'ml:MLB123' }),
    approve: jest.fn().mockResolvedValue({
      id: 'card1',
      catalogId: 'ml:MLB123',
      enqueued: 1,
      targets: 2,
    }),
    renderManualPreview: jest
      .fn()
      .mockResolvedValue({ caption: 'cap JBL20', imageUrl: 'img' }),
  };
  const service = new ManualDealService([resolver] as never, queue as never);
  return { service, resolver, queue };
}

const base = {
  store: 'ml',
  title: 'Fone JBL',
  priceCents: 17900,
  thumbnail: 'https://http2.mlstatic.com/x.jpg',
};

describe('resolveUrl', () => {
  it('returns prefill fields and creates NO card', async () => {
    const { service, queue } = make();
    const out = await service.resolveUrl('https://meli.la/x');
    expect(out.title).toBe('Fone JBL');
    expect(out.permalink).toBe('https://www.mercadolivre.com.br/p/MLB123');
    expect(queue.createManual).not.toHaveBeenCalled();
  });
});

describe('preview', () => {
  it('renders via renderManualPreview with the coupon applied', async () => {
    const { service, queue } = make();
    const out = await service.preview({
      ...base,
      coupon: { code: 'JBL20', finalCents: 15000 },
    } as never);
    expect(out.caption).toContain('JBL20');
    const sd = queue.renderManualPreview.mock.calls[0][0];
    expect(sd.curatorEdits.coupon).toEqual({ code: 'JBL20', finalCents: 15000 });
  });
});

describe('submit', () => {
  it('dispatch=false creates a pending card only', async () => {
    const { service, queue } = make();
    await service.submit({ ...base, permalink: resolved.permalink } as never);
    expect(queue.createManual).toHaveBeenCalledTimes(1);
    expect(queue.approve).not.toHaveBeenCalled();
  });

  it('dispatch=true creates the card then approves urgent', async () => {
    const { service, queue } = make();
    const out = await service.submit({
      ...base,
      permalink: resolved.permalink,
      dispatch: true,
    } as never);
    expect(queue.approve).toHaveBeenCalledWith('card1', undefined, {
      urgent: true,
    });
    expect(out).toMatchObject({ enqueued: 1, targets: 2 });
  });

  it('derives the ML catalog id from the permalink so dedup aligns', async () => {
    const { service, queue } = make();
    await service.submit({ ...base, permalink: resolved.permalink } as never);
    const sd = queue.createManual.mock.calls[0][0];
    expect(sd.deal.key).toEqual({ source: 'ml', externalId: 'MLB123' });
  });

  it('hashes a permalink-less manual deal into a stable id', async () => {
    const { service, queue } = make();
    await service.submit({ ...base, store: 'outro' } as never);
    const sd = queue.createManual.mock.calls[0][0];
    expect(sd.deal.key.source).toBe('outro');
    expect(sd.deal.key.externalId).toHaveLength(12);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/curation/manual/manual-deal.service.spec.ts`
Expected: FAIL — `service.preview`/`submit` not functions / `resolveUrl` returns a card.

- [ ] **Step 3: Write minimal implementation**

Rewrite `src/curation/manual/manual-deal.service.ts`:

```typescript
import { createHash } from 'crypto';
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  ApprovalQueueService,
  type PendingSummary,
} from '../approval-queue.service';
import {
  MANUAL_RESOLVERS,
  ManualResolveError,
  toScoredDeal,
  type ManualDealResolver,
  type ResolvedManualDeal,
} from './manual-resolver.port';
import { extractMlId } from './ml-manual-resolver';
import { CreateManualDealDto } from '../dto/create-manual-deal.dto';
import { PreviewManualDto } from '../dto/preview-manual.dto';
import type { ScoredDeal } from '../../deal-score/types';
import type { SourceId } from '../../sources/source.port';

export type ResolvedManualView = Omit<ResolvedManualDeal, 'key'>;
export interface DispatchResult {
  id: string;
  catalogId: string;
  enqueued: number;
  targets: number;
}

@Injectable()
export class ManualDealService {
  private readonly logger = new Logger(ManualDealService.name);

  constructor(
    @Inject(MANUAL_RESOLVERS)
    private readonly resolvers: ManualDealResolver[],
    private readonly approvalQueue: ApprovalQueueService,
  ) {}

  /** Resolve a pasted URL into prefill fields. Creates NO card. */
  async resolveUrl(url: string): Promise<ResolvedManualView> {
    const resolver = this.resolvers.find((r) => r.canResolve(url));
    if (!resolver) {
      throw new BadRequestException({
        code: 'unsupported_url',
        message:
          'Nenhuma loja reconhece essa URL. Preencha os campos manualmente.',
      });
    }
    let resolved: ResolvedManualDeal;
    try {
      resolved = await resolver.resolve(url);
    } catch (err) {
      if (err instanceof ManualResolveError) {
        this.logger.warn(`manual resolve ${err.code} for ${url}: ${err.message}`);
        const body = { code: err.code, message: err.message };
        throw err.code === 'invalid_url'
          ? new BadRequestException(body)
          : new UnprocessableEntityException(body);
      }
      throw err;
    }
    const { key: _key, ...view } = resolved;
    return view;
  }

  /** Stateless caption render for the live preview. */
  async preview(
    dto: PreviewManualDto,
  ): Promise<{ caption: string; imageUrl: string }> {
    return this.approvalQueue.renderManualPreview(this.fieldsToScored(dto));
  }

  /** Create a pending card; dispatch=true approves it urgent in the same call. */
  async submit(
    dto: CreateManualDealDto,
  ): Promise<PendingSummary | DispatchResult> {
    const sd = this.fieldsToScored(dto);
    const card = await this.approvalQueue.createManual(sd);
    if (dto.dispatch === true) {
      return this.approvalQueue.approve(card.id, undefined, { urgent: true });
    }
    return card;
  }

  private fieldsToScored(dto: CreateManualDealDto | PreviewManualDto): ScoredDeal {
    const source = dto.store as SourceId;
    const externalId = this.deriveId(source, dto.permalink, dto.title);

    let discountPercent = 0;
    if (dto.originalPriceCents && dto.originalPriceCents > dto.priceCents) {
      discountPercent = Math.round(
        ((dto.originalPriceCents - dto.priceCents) / dto.originalPriceCents) *
          100,
      );
    }

    const resolved: ResolvedManualDeal = {
      key: { source, externalId },
      source,
      title: dto.title,
      priceCents: dto.priceCents,
      originalPriceCents: dto.originalPriceCents ?? null,
      discountPercent,
      thumbnail: dto.thumbnail,
      permalink: dto.permalink ?? '',
      installmentsNoInterest: dto.installmentsNoInterest ?? false,
    };

    const sd = toScoredDeal(resolved);
    if (dto.coupon) {
      sd.curatorEdits = {
        coupon: { code: dto.coupon.code, finalCents: dto.coupon.finalCents },
      };
    }
    return sd;
  }

  /** ML: catalog id from the link so dedup aligns with pipeline deals.
   *  Otherwise a stable 12-char md5 of the link (or title when link-less). */
  private deriveId(
    source: SourceId,
    permalink: string | undefined,
    title: string,
  ): string {
    if (source === 'ml' && permalink) {
      const mlb = extractMlId(permalink);
      if (mlb) return mlb;
    }
    return createHash('md5')
      .update(permalink || title)
      .digest('hex')
      .substring(0, 12);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/curation/manual/manual-deal.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/curation/manual/manual-deal.service.ts src/curation/manual/manual-deal.service.spec.ts
git commit -m "feat(manual): resolve prefill + stateless preview + unified submit"
```

---

## Task 6: Controller routes + module wiring

**Files:**
- Modify: `src/curation/approval.controller.ts`
- Modify: `src/curation/approval.module.ts`
- Test: `test/*.e2e-spec.ts` — add `test/manual-composer.e2e-spec.ts` (follow the pattern of an existing e2e spec in `test/`)

**Interfaces:**
- Consumes: `ManualDealService` (`resolveUrl`, `preview`, `submit`), `HttpShortUrlExpander` + `SHORT_URL_EXPANDER` (Task 1).
- Produces routes:
  - `POST /approval/manual/resolve` `{ url }` → `ResolvedManualView`
  - `POST /approval/manual/preview` `PreviewManualDto` → `{ caption, imageUrl }`
  - `POST /approval/manual` `CreateManualDealDto` → `PendingSummary | DispatchResult`
  - removes `POST /approval/manual/generic`.

- [ ] **Step 1: Write the failing test**

Create `test/manual-composer.e2e-spec.ts` mirroring the bootstrap of an existing e2e spec (import `AppModule`, `Test.createTestingModule`, `ValidationPipe`, api-key header). Assert:

```typescript
it('POST /approval/manual/preview renders a caption without creating a card', async () => {
  const res = await request(app.getHttpServer())
    .post('/approval/manual/preview')
    .set('x-api-key', KEY)
    .send({
      store: 'outro',
      title: 'Produto Teste',
      priceCents: 9900,
      thumbnail: 'https://example.com/x.jpg',
      coupon: { code: 'TESTE10' },
    })
    .expect(201);
  expect(res.body.caption).toContain('TESTE10');

  const pending = await request(app.getHttpServer())
    .get('/approval/pending')
    .set('x-api-key', KEY)
    .expect(200);
  expect(pending.body.pending).toHaveLength(0);
});

it('POST /approval/manual (dispatch=false) creates a pending card', async () => {
  await request(app.getHttpServer())
    .post('/approval/manual')
    .set('x-api-key', KEY)
    .send({
      store: 'outro',
      title: 'Produto Fila',
      priceCents: 9900,
      thumbnail: 'https://example.com/x.jpg',
    })
    .expect(201);
  const pending = await request(app.getHttpServer())
    .get('/approval/pending')
    .set('x-api-key', KEY)
    .expect(200);
  expect(pending.body.pending.length).toBeGreaterThan(0);
});
```

(Use whatever DB/mocking setup the existing e2e specs use. If e2e needs infra not available in CI, mark this spec `describe.skip` with a `// TODO enable with test DB` and rely on the unit tests from Tasks 1-5 — note this in the commit.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest --config test/jest-e2e.json test/manual-composer.e2e-spec.ts`
Expected: FAIL — routes 404 / DI missing `SHORT_URL_EXPANDER`.

- [ ] **Step 3: Write minimal implementation**

`src/curation/approval.controller.ts` — replace the manual routes:

```typescript
import { ResolveManualDto } from './dto/resolve-manual.dto';
import { CreateManualDealDto } from './dto/create-manual-deal.dto';
import { PreviewManualDto } from './dto/preview-manual.dto';
// (drop CreateGenericManualDto import)

  /** Resolve a pasted URL into prefill fields — creates no card. */
  @Post('manual/resolve')
  async resolveManual(@Body() body: ResolveManualDto) {
    return this.manualDeals.resolveUrl(body.url);
  }

  /** Live caption preview for the composer — renders, never decides. */
  @Post('manual/preview')
  async previewManual(@Body() body: PreviewManualDto) {
    return this.manualDeals.preview(body);
  }

  /** Submit a composed deal: queue, or dispatch=true to send now (urgent). */
  @Post('manual')
  async submitManual(@Body() body: CreateManualDealDto) {
    return this.manualDeals.submit(body);
  }
```

Remove the old `@Post('manual/generic')` handler.

`src/curation/approval.module.ts` — add the expander provider:

```typescript
import {
  HttpShortUrlExpander,
  SHORT_URL_EXPANDER,
} from './manual/url-expander';

// in providers:
    { provide: SHORT_URL_EXPANDER, useFactory: () => new HttpShortUrlExpander() },
    MlManualResolver,
    {
      provide: MANUAL_RESOLVERS,
      inject: [MlManualResolver],
      useFactory: (ml: MlManualResolver) => [ml],
    },
    ManualDealService,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest --config test/jest-e2e.json test/manual-composer.e2e-spec.ts`
Expected: PASS (or skipped-with-note per Step 1).
Then full backend suite: `npm test` → all green.

- [ ] **Step 5: Commit**

```bash
git add src/curation/approval.controller.ts src/curation/approval.module.ts test/manual-composer.e2e-spec.ts
git commit -m "feat(approval): composer routes (resolve/preview/submit) + expander wiring"
```

---

## Task 7: Panel API client + types

**Files:**
- Modify: `web/src/api.ts`
- Modify: `web/src/types.ts`

**Interfaces:**
- Produces (types):
  - `ManualCoupon { code: string; finalCents?: number }`
  - `ResolvedManualView { source: string; title: string; priceCents: number; originalPriceCents: number | null; discountPercent: number; thumbnail: string; permalink: string; installmentsNoInterest: boolean }`
  - `ManualFields { store: string; title: string; priceCents: number; originalPriceCents?: number; installmentsNoInterest?: boolean; coupon?: ManualCoupon; thumbnail: string; permalink?: string }`
  - `SubmitResult = { id: string; catalogId: string; enqueued: number; targets: number } | PendingDeal`
- Produces (api fns): `resolveManual`, `previewManual`, `submitManual`.

- [ ] **Step 1: Add types**

In `web/src/types.ts` append:

```typescript
export interface ManualCoupon {
  code: string;
  finalCents?: number;
}

export interface ResolvedManualView {
  source: string;
  title: string;
  priceCents: number;
  originalPriceCents: number | null;
  discountPercent: number;
  thumbnail: string;
  permalink: string;
  installmentsNoInterest: boolean;
}

export interface ManualFields {
  store: string;
  title: string;
  priceCents: number;
  originalPriceCents?: number;
  installmentsNoInterest?: boolean;
  coupon?: ManualCoupon;
  thumbnail: string;
  permalink?: string;
}
```

- [ ] **Step 2: Add api functions**

In `web/src/api.ts` append (reusing the existing `request` helper, which already maps 400/422 bodies through the `!res.ok` path — extend it to surface the backend `message`):

First, make non-401/404/409 errors carry the backend message so the composer can show "link inválido / página ilegível":

```typescript
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      message?: string;
      code?: string;
    } | null;
    throw new Error(body?.message ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
```

Then the functions:

```typescript
import type {
  ManualFields,
  ResolvedManualView,
} from './types';

export async function resolveManual(
  url: string,
): Promise<ResolvedManualView> {
  return request<ResolvedManualView>('/approval/manual/resolve', {
    method: 'POST',
    json: { url },
  });
}

export async function previewManual(
  fields: ManualFields,
): Promise<{ caption: string; imageUrl: string }> {
  return request('/approval/manual/preview', { method: 'POST', json: fields });
}

export async function submitManual(
  fields: ManualFields,
  dispatch: boolean,
): Promise<{ id: string; catalogId: string; enqueued?: number; targets?: number }> {
  return request('/approval/manual', {
    method: 'POST',
    json: { ...fields, dispatch },
  });
}
```

(Consolidate the `import type` line with the existing one at the top of the file rather than adding a duplicate.)

- [ ] **Step 3: Typecheck**

Run: `cd web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add web/src/api.ts web/src/types.ts
git commit -m "feat(web): composer api client + types"
```

---

## Task 8: ManualComposer component

**Files:**
- Create: `web/src/components/ManualComposer.tsx`

**Interfaces:**
- Consumes: `resolveManual`, `previewManual`, `submitManual` (Task 7), `CaptionPreview` (`web/src/components/CaptionPreview.tsx`), `RecentlyPostedError` / `confirmRepost` (`web/src/api.ts`).
- Produces: `export function ManualComposer({ onUnauthorized, onDone }: { onUnauthorized: () => void; onDone: (msg: string) => void }): JSX.Element`.

- [ ] **Step 1: Implement the component**

```tsx
// web/src/components/ManualComposer.tsx
import { useEffect, useRef, useState } from 'react';
import {
  previewManual,
  resolveManual,
  submitManual,
  UnauthorizedError,
} from '../api';
import type { ManualFields } from '../types';
import { CaptionPreview } from './CaptionPreview';

const EMPTY: ManualFields = {
  store: 'ml',
  title: '',
  priceCents: 0,
  originalPriceCents: undefined,
  installmentsNoInterest: false,
  coupon: undefined,
  thumbnail: '',
  permalink: '',
};

function reais(cents: number): string {
  return (cents / 100).toFixed(2).replace('.', ',');
}
function cents(v: string): number {
  const n = Math.round(parseFloat(v.replace(',', '.')) * 100);
  return Number.isFinite(n) ? n : 0;
}

export function ManualComposer({
  onUnauthorized,
  onDone,
}: {
  onUnauthorized: () => void;
  onDone: (msg: string) => void;
}) {
  const [url, setUrl] = useState('');
  const [f, setF] = useState<ManualFields>(EMPTY);
  const [couponCode, setCouponCode] = useState('');
  const [couponFinal, setCouponFinal] = useState('');
  const [resolving, setResolving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ caption: string; imageUrl: string }>(
    { caption: '', imageUrl: '' },
  );
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const set = <K extends keyof ManualFields>(k: K, v: ManualFields[K]) =>
    setF((prev) => ({ ...prev, [k]: v }));

  // assemble coupon into fields
  const fields: ManualFields = {
    ...f,
    coupon: couponCode.trim()
      ? {
          code: couponCode.trim(),
          finalCents: couponFinal ? cents(couponFinal) : undefined,
        }
      : undefined,
  };

  const canSend = f.title.trim() !== '' && f.priceCents > 0 && f.thumbnail.trim() !== '';

  // debounced live preview
  useEffect(() => {
    if (!canSend) {
      setPreview({ caption: '', imageUrl: '' });
      return;
    }
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => {
      previewManual(fields)
        .then(setPreview)
        .catch((e) => {
          if (e instanceof UnauthorizedError) onUnauthorized();
        });
    }, 400);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    f.title,
    f.priceCents,
    f.originalPriceCents,
    f.installmentsNoInterest,
    f.thumbnail,
    f.permalink,
    f.store,
    couponCode,
    couponFinal,
  ]);

  async function onResolve() {
    if (!url.trim()) return;
    setResolving(true);
    setError(null);
    try {
      const v = await resolveManual(url.trim());
      setF({
        store: v.source,
        title: v.title,
        priceCents: v.priceCents,
        originalPriceCents: v.originalPriceCents ?? undefined,
        installmentsNoInterest: v.installmentsNoInterest,
        thumbnail: v.thumbnail,
        permalink: v.permalink,
      });
    } catch (e) {
      if (e instanceof UnauthorizedError) return onUnauthorized();
      setError((e as Error).message);
    } finally {
      setResolving(false);
    }
  }

  async function onSubmit(dispatch: boolean) {
    if (!canSend) {
      setError('Preencha título, preço e imagem.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await submitManual(fields, dispatch);
      if (dispatch && res.enqueued === 0) {
        onDone('Enviado, mas nada foi pra fila (dedup ou sem alvo). Veja a Fila.');
      } else if (dispatch) {
        onDone(`Disparado para ${res.targets ?? 0} canal(is).`);
      } else {
        onDone('Adicionado à fila.');
      }
      setF(EMPTY);
      setUrl('');
      setCouponCode('');
      setCouponFinal('');
    } catch (e) {
      if (e instanceof UnauthorizedError) return onUnauthorized();
      // recently_posted (409) surfaces as GoneError message; card já ficou na fila
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const inp =
    'w-full rounded-md border border-stone-700 bg-stone-900 px-2 py-1.5 text-sm text-stone-100 placeholder-stone-500 focus:border-stone-400 focus:outline-none';
  const lbl = 'mb-1 block text-xs font-medium text-stone-400';

  return (
    <div className="flex flex-col gap-4 md:flex-row">
      {/* form */}
      <div className="flex-1">
        <label className={lbl}>Colar link (opcional)</label>
        <div className="mb-4 flex gap-2">
          <input
            className={inp}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="meli.la/… ou link do anúncio"
          />
          <button
            type="button"
            disabled={resolving || !url.trim()}
            onClick={() => void onResolve()}
            className="shrink-0 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-40"
          >
            {resolving ? '…' : 'Resolver'}
          </button>
        </div>

        <div className="mb-3">
          <label className={lbl}>Título</label>
          <input className={inp} value={f.title} onChange={(e) => set('title', e.target.value)} />
        </div>

        <div className="mb-3 grid grid-cols-2 gap-2">
          <div>
            <label className={lbl}>De (R$)</label>
            <input
              className={inp}
              value={f.originalPriceCents ? reais(f.originalPriceCents) : ''}
              onChange={(e) =>
                set('originalPriceCents', e.target.value ? cents(e.target.value) : undefined)
              }
            />
          </div>
          <div>
            <label className={lbl}>Por PIX (R$)</label>
            <input
              className={inp}
              value={f.priceCents ? reais(f.priceCents) : ''}
              onChange={(e) => set('priceCents', cents(e.target.value))}
            />
          </div>
        </div>

        <label className="mb-3 flex items-center gap-2 text-sm text-stone-300">
          <input
            type="checkbox"
            checked={!!f.installmentsNoInterest}
            onChange={(e) => set('installmentsNoInterest', e.target.checked)}
          />
          Parcela sem juros
        </label>

        <div className="mb-3 grid grid-cols-2 gap-2">
          <div>
            <label className={lbl}>Cupom (código)</label>
            <input className={inp} value={couponCode} onChange={(e) => setCouponCode(e.target.value)} />
          </div>
          <div>
            <label className={lbl}>Preço c/ cupom (R$)</label>
            <input className={inp} value={couponFinal} onChange={(e) => setCouponFinal(e.target.value)} />
          </div>
        </div>

        <div className="mb-3">
          <label className={lbl}>Imagem (URL)</label>
          <input className={inp} value={f.thumbnail} onChange={(e) => set('thumbnail', e.target.value)} />
        </div>

        <div className="mb-4">
          <label className={lbl}>Link (opcional)</label>
          <input className={inp} value={f.permalink ?? ''} onChange={(e) => set('permalink', e.target.value)} />
        </div>

        {error && <p className="mb-3 text-sm text-red-400">{error}</p>}

        <div className="flex gap-2">
          <button
            type="button"
            disabled={busy || !canSend}
            onClick={() => void onSubmit(false)}
            className="flex-1 rounded-md border border-stone-600 px-3 py-2 text-sm font-semibold text-stone-100 disabled:opacity-40"
          >
            ➕ Pra fila
          </button>
          <button
            type="button"
            disabled={busy || !canSend}
            onClick={() => void onSubmit(true)}
            className="flex-1 rounded-md bg-green-700 px-3 py-2 text-sm font-semibold text-white disabled:opacity-40"
          >
            ⚡ Dispara já
          </button>
        </div>
      </div>

      {/* live preview */}
      <div className="flex-1">
        <label className={lbl}>Preview ao vivo</label>
        {preview.caption ? (
          <CaptionPreview caption={preview.caption} imageUrl={preview.imageUrl} />
        ) : (
          <p className="rounded-lg border border-dashed border-stone-700 px-3 py-16 text-center text-sm text-stone-500">
            Preencha título, preço e imagem pra ver o preview.
          </p>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add web/src/components/ManualComposer.tsx
git commit -m "feat(web): ManualComposer — split form + live preview + queue/dispatch"
```

---

## Task 9: Wire "Novo deal" tab into App

**Files:**
- Modify: `web/src/App.tsx`

**Interfaces:**
- Consumes: `ManualComposer` (Task 8), existing `showToast`, `setStatus`, `refresh`.

- [ ] **Step 1: Add the tab**

1. Extend the tab union and add the nav button:

```tsx
const [tab, setTab] = useState<'pending' | 'compose' | 'history' | 'config'>('pending');
```

Add after the "Fila" button (line ~125), before "Histórico":

```tsx
            <button
              className={`text-lg font-bold ${tab === 'compose' ? 'text-stone-100' : 'text-stone-500'}`}
              onClick={() => setTab('compose')}
            >
              Novo deal
            </button>
```

2. Import at top: `import { ManualComposer } from './components/ManualComposer';`

3. Widen the main container when composing (the composer needs the split width):

```tsx
      <main
        className={`mx-auto flex flex-col gap-4 px-3 py-4 pb-10 ${
          tab === 'compose' ? 'max-w-3xl' : 'max-w-md'
        }`}
      >
```

4. Add the branch in the render chain (before the `tab === 'history'` check):

```tsx
        {tab === 'compose' ? (
          <ManualComposer
            onUnauthorized={() => setStatus('unauthorized')}
            onDone={(msg) => {
              showToast(msg);
              void refresh();
            }}
          />
        ) : tab === 'history' ? (
          <HistoryPanel onUnauthorized={() => setStatus('unauthorized')} />
        ) : tab === 'config' ? (
```

(Make sure the header container `max-w-md` on line ~118 also widens with the same conditional, so the nav aligns with `main`.)

- [ ] **Step 2: Typecheck + build**

Run: `cd web && npx tsc --noEmit && npm run build`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add web/src/App.tsx
git commit -m "feat(web): Novo deal tab wiring composer into the panel"
```

---

## Task 10: Full verification

- [ ] **Step 1: Backend suite**

Run: `npm test`
Expected: all green (Tasks 1-6 specs + existing).

- [ ] **Step 2: Web build**

Run: `cd web && npm run build`
Expected: succeeds, no type errors.

- [ ] **Step 3: Live e2e (manual, per spec "Verificação")**

After `docker compose up -d --build` + migrate deploy (if needed):
- Colar `meli.la` curto → form preenchido; editar imagem/preço/cupom → preview atualiza.
- ⚡ Dispara já → post nos 2 alvos (grupo WA teste + Telegram), com edições.
- ➕ Pra fila → card em pending com as edições (cupom visível).
- Post sem link (store "outro") → dispara/fila normal.
- Link inválido → erro limpo, sem card.
- Deal repetido no dispatch → 409, card fica pendente.

- [ ] **Step 4: Finish the branch**

Use `superpowers:finishing-a-development-branch` to open the PR against `main`.

---

## Self-Review

**Spec coverage:**
- Short link expand → Task 1+2 ✓
- resolve returns prefill (no card) → Task 5 ✓
- stateless preview endpoint → Task 3 (render) + 5 (service) + 6 (route) ✓
- unified submit + dispatch → Task 5+6 ✓
- link opcional / post manual → Task 5 (`deriveId` hash) + DTO (`permalink?`) ✓
- imagem via URL → DTO `thumbnail` IsUrl + composer field ✓
- texto estruturado → composer fields → template render ✓
- cupom manual em fila E dispatch → Task 3 (`resolveCoupon` honra curatorEdits) + Task 5 (`fieldsToScored` seta coupon) ✓
- dedup 409 → card fica pendente → submit dispatch calls approve sem override; 409 propaga, card já criado ✓
- painel split + tab → Task 8+9 ✓
- reuso toScoredDeal/renderCaption/approve/CaptionPreview ✓

**Placeholder scan:** e2e spec (Task 6) has a conditional skip path documented — acceptable (unit coverage from Tasks 1-5 carries the logic). No other TODOs.

**Type consistency:** `ResolvedManualView` = `Omit<ResolvedManualDeal,'key'>` (backend) mirrored in `web/src/types.ts`. `DispatchResult`/`SubmitResult` `{id,catalogId,enqueued,targets}` consistent across Task 5/6/7/8. `fieldsToScored` used by both `preview` and `submit`. `extractMlId` reused from `ml-manual-resolver`.
