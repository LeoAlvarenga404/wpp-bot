# Template "Ofertas na Tela" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reproduce the reference deals group's flat caption format in our bot — one template for ML + Shopee, ML FULL badge, honest PIX price line, coupon code only, no affiliate disclaimer.

**Architecture:** Add a FULL signal (`logistic_type === 'fulfillment'`) plumbed from the ML API into `EnrichedDeal.signals`. Replace the 6 level/AB scored templates with a single `ofertasTemplate` pure function. Rewire `FormatterService.formatScored`/`formatDigest` to use it and drop the disclaimer. The A/B `variant` plumbing stays but the formatter ignores it (no-op).

**Tech Stack:** TypeScript, NestJS, Jest.

## Global Constraints

- Money is always integer cents internally; render prices as **integer reais** with `Math.floor(cents / 100)` and `toLocaleString('pt-BR')` (thousand separator, no cents). Floor never overstates the price.
- Price line emoji is `✅` (green). `no PIX` only when `priceView.pixPriceCents != null`; otherwise `à vista`.
- Store hashtag: `ml` → `#MercadoLivre`, `shopee` → `#Shopee`.
- Link label: `ml` → `Link:`, `shopee` → `Link do produto:`.
- No affiliate disclaimer on scored/digest captions.
- `isFull` is an **optional** boolean on `DealItem` and `EnrichedDeal.signals` (deviation from spec, which said required — optional avoids touching ~13 existing fixtures; behavior identical since `undefined` is falsy). Shopee never sets it.
- Hook is uppercased with `toLocaleUpperCase('pt-BR')`; hook emoji by level: `good` → `🔥`, `top` → `🔥🔥`, `super` → `🚨`, default `🔥`.
- FULL badge line text: `⚡ FULL`.
- `formatItem` (legacy `fireTemplate`) is dead in prod; leave it and its tests untouched (out of scope).

---

### Task 1: Plumb the ML FULL signal

**Files:**
- Modify: `src/mercado-livre/types.ts` (add `isFull?: boolean` to `DealItem`)
- Modify: `src/mercado-livre/ml.service.ts:78-89` (`tryBuildDeal` returns `isFull`)
- Modify: `src/sources/source.port.ts:37-42` (add `isFull?: boolean` to `signals`)
- Modify: `src/sources/mercado-livre/mapping.ts:65-98` (`toEnrichedDeal` takes `isFull`, sets `signals.isFull`)
- Modify: `src/sources/mercado-livre/ml-source.service.ts:88-90` (pass `dealItems[i].isFull`)
- Test: `src/sources/mercado-livre/mapping.spec.ts`

**Interfaces:**
- Produces: `DealItem.isFull?: boolean`; `EnrichedDeal.signals.isFull?: boolean`; `toEnrichedDeal(raw, seller, item, freeShipping, isFull?)` — 5th positional arg `isFull: boolean = false`.

- [ ] **Step 1: Write the failing test**

Add to `src/sources/mercado-livre/mapping.spec.ts` (inside the top-level `describe`, reuse existing import of `toEnrichedDeal` and the fixtures already used there):

```ts
describe('toEnrichedDeal isFull', () => {
  const raw = {
    key: { source: 'ml' as const, externalId: 'MLB1' },
    title: 'T',
    priceCents: 10000,
    originalPriceCents: 20000,
    discountPercent: 50,
    thumbnail: '',
    permalink: 'p',
    feedId: 'F',
  };

  it('sets signals.isFull=true when isFull arg is true', () => {
    const e = toEnrichedDeal(raw, null, null, true, true);
    expect(e.signals.isFull).toBe(true);
  });

  it('defaults signals.isFull to false when arg omitted', () => {
    const e = toEnrichedDeal(raw, null, null, true);
    expect(e.signals.isFull).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/sources/mercado-livre/mapping.spec.ts -t isFull`
Expected: FAIL — `toEnrichedDeal` currently takes 4 args; `signals.isFull` is `undefined`.

- [ ] **Step 3: Write minimal implementation**

In `src/mercado-livre/types.ts`, add to the `DealItem` interface:

```ts
  discountPercent: number;
  /** ML fulfillment (logistic_type === 'fulfillment'). */
  isFull?: boolean;
```

In `src/sources/source.port.ts`, add to the `signals` object type inside `EnrichedDeal`:

```ts
  signals: {
    freeShipping: boolean;
    installmentsNoInterest: boolean;
    volumeTier: 'high' | 'mid' | 'low' | 'none';
    isVerifiedStore: boolean;
    /** ML fulfillment. Absent/false for Shopee and API-fallback deals. */
    isFull?: boolean;
  };
```

In `src/sources/mercado-livre/mapping.ts`, change `toEnrichedDeal` signature and body:

```ts
export function toEnrichedDeal(
  raw: RawDeal,
  seller: SellerInfo | null,
  item: ItemDetails | null,
  freeShipping: boolean,
  isFull = false,
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
      isFull,
    },
    extras: {
```

In `src/mercado-livre/ml.service.ts`, inside `tryBuildDeal` return object (after `discountPercent`):

```ts
        freeShipping: !!best.shipping?.free_shipping,
        permalink: `https://www.mercadolivre.com.br/p/${catalogId}`,
        discountPercent,
        isFull: best.shipping?.logistic_type === 'fulfillment',
      };
```

In `src/sources/mercado-livre/ml-source.service.ts`, update the enrich map call:

```ts
    return enrichedML.map((e, i) =>
      toEnrichedDeal(
        raws[i],
        e.seller,
        e.item,
        dealItems[i].freeShipping,
        dealItems[i].isFull ?? false,
      ),
    );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/sources/mercado-livre/mapping.spec.ts -t isFull`
Expected: PASS.

- [ ] **Step 5: Run the full mapping + ml source specs (regression)**

Run: `npx jest src/sources/mercado-livre`
Expected: PASS (existing tests unaffected — `isFull` optional).

- [ ] **Step 6: Commit**

```bash
git add src/mercado-livre/types.ts src/mercado-livre/ml.service.ts src/sources/source.port.ts src/sources/mercado-livre/mapping.ts src/sources/mercado-livre/ml-source.service.ts src/sources/mercado-livre/mapping.spec.ts
git commit -m "feat(deal): plumb ML FULL (logistic_type=fulfillment) into signals"
```

---

### Task 2: Create the `ofertasTemplate` pure function + helpers

**Files:**
- Create: `src/pipeline/templates/template-ofertas.ts`
- Test: `src/pipeline/templates/template-ofertas.spec.ts`

**Interfaces:**
- Consumes: `ScoredDeal` (`src/deal-score/types`), `PriceView` (`src/pricing/price-view`), `CouponView` (`src/coupon/coupon.types`), `signals.isFull` from Task 1.
- Produces:
  - `sourceHashtag(source: 'ml' | 'shopee'): string`
  - `linkLabel(source: 'ml' | 'shopee'): string`
  - `ofertasTemplate(input: OfertasTemplateInput): string` where
    `OfertasTemplateInput = { sd: ScoredDeal; link: string; hook: string; priceView?: PriceView; couponView?: CouponView }`
  - Returns the caption body WITHOUT any disclaimer.

- [ ] **Step 1: Write the failing test**

Create `src/pipeline/templates/template-ofertas.spec.ts`:

```ts
import { ofertasTemplate, sourceHashtag, linkLabel } from './template-ofertas';
import type { ScoredDeal, DealLevel } from '../../deal-score/types';

function makeScored(
  over: {
    source?: 'ml' | 'shopee';
    level?: DealLevel;
    priceCents?: number;
    isFull?: boolean;
    title?: string;
  } = {},
): ScoredDeal {
  const source = over.source ?? 'ml';
  const key = { source, externalId: 'X1' };
  return {
    deal: {
      key,
      source,
      raw: {
        key,
        title: over.title ?? 'Echo Dot 5',
        priceCents: over.priceCents ?? 8700,
        originalPriceCents: 20000,
        discountPercent: 56,
        thumbnail: '',
        permalink: 'p',
        feedId: 'F',
      },
      seller: null,
      condition: 'new',
      signals: {
        freeShipping: true,
        installmentsNoInterest: false,
        volumeTier: 'mid',
        isVerifiedStore: false,
        isFull: over.isFull ?? false,
      },
      extras: {},
    },
    score: 90,
    rawScore: 90,
    level: over.level ?? 'good',
    reasons: [],
    penalties: [],
    factors: {},
  };
}

describe('sourceHashtag / linkLabel', () => {
  it('maps sources to hashtags', () => {
    expect(sourceHashtag('ml')).toBe('#MercadoLivre');
    expect(sourceHashtag('shopee')).toBe('#Shopee');
  });
  it('maps sources to link labels', () => {
    expect(linkLabel('ml')).toBe('Link:');
    expect(linkLabel('shopee')).toBe('Link do produto:');
  });
});

describe('ofertasTemplate', () => {
  it('renders ML layout: hashtag, uppercased hook, title, price à vista, link', () => {
    const out = ofertasTemplate({
      sd: makeScored({ source: 'ml', priceCents: 8700 }),
      link: 'https://meli.la/ABC',
      hook: 'que preço é esse',
    });
    const lines = out.split('\n');
    expect(lines[0]).toBe('#MercadoLivre');
    expect(out).toContain('QUE PREÇO É ESSE 🔥');
    expect(out).toContain('➡️ Echo Dot 5');
    expect(out).toContain('✅ R$ 87 à vista');
    expect(out).toContain('🛒 Link: https://meli.la/ABC');
    expect(out).not.toMatch(/Link de afiliado/);
  });

  it('shows "no PIX" with the pix price when priceView has one', () => {
    const out = ofertasTemplate({
      sd: makeScored({ priceCents: 10000 }),
      link: 'l',
      hook: 'x',
      priceView: {
        priceCents: 10000,
        originalPriceCents: 20000,
        discountPercent: 50,
        pixPriceCents: 8780,
        installments: null,
        scrapedAt: '2026-07-15T20:00:00.000Z',
      },
    });
    expect(out).toContain('✅ R$ 87 no PIX');
    expect(out).not.toContain('à vista');
  });

  it('renders ⚡ FULL only when signals.isFull', () => {
    const withFull = ofertasTemplate({ sd: makeScored({ isFull: true }), link: 'l', hook: 'h' });
    const noFull = ofertasTemplate({ sd: makeScored({ isFull: false }), link: 'l', hook: 'h' });
    expect(withFull).toContain('⚡ FULL');
    expect(noFull).not.toContain('⚡ FULL');
  });

  it('renders coupon code only (no validity/price) when couponView present', () => {
    const out = ofertasTemplate({
      sd: makeScored(),
      link: 'l',
      hook: 'h',
      couponView: {
        code: 'SHOWNOCAMPO',
        mode: 'PRICE',
        finalCents: 8000,
        discountLabel: '-R$ 20',
        minCents: null,
        validUntil: '2999-01-01T00:00:00.000Z',
      },
    });
    expect(out).toContain('🎟️ Use o cupom: SHOWNOCAMPO');
    expect(out).not.toMatch(/válido até/);
    expect(out).not.toMatch(/R\$\s?80,00/);
  });

  it('omits coupon line when no couponView', () => {
    const out = ofertasTemplate({ sd: makeScored(), link: 'l', hook: 'h' });
    expect(out).not.toContain('🎟️');
  });

  it('uses Shopee hashtag + link label for shopee source', () => {
    const out = ofertasTemplate({ sd: makeScored({ source: 'shopee' }), link: 'https://s.shopee.com.br/x', hook: 'h' });
    expect(out.split('\n')[0]).toBe('#Shopee');
    expect(out).toContain('🛒 Link do produto: https://s.shopee.com.br/x');
  });

  it('picks hook emoji by level', () => {
    expect(ofertasTemplate({ sd: makeScored({ level: 'good' }), link: 'l', hook: 'h' })).toContain('H 🔥');
    expect(ofertasTemplate({ sd: makeScored({ level: 'top' }), link: 'l', hook: 'h' })).toContain('H 🔥🔥');
    expect(ofertasTemplate({ sd: makeScored({ level: 'super' }), link: 'l', hook: 'h' })).toContain('H 🚨');
  });

  it('omits the hook line entirely when hook is empty', () => {
    const out = ofertasTemplate({ sd: makeScored(), link: 'l', hook: '' });
    const lines = out.split('\n');
    expect(lines[0]).toBe('#MercadoLivre');
    // next non-empty line is the title, not a stray emoji line
    expect(lines[1]).toBe('');
    expect(lines[2]).toContain('➡️');
  });

  it('formats thousands and floors cents', () => {
    const out = ofertasTemplate({
      sd: makeScored({ priceCents: 484699 }),
      link: 'l',
      hook: 'h',
    });
    expect(out).toContain('✅ R$ 4.846 à vista');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/pipeline/templates/template-ofertas.spec.ts`
Expected: FAIL — module `./template-ofertas` not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/pipeline/templates/template-ofertas.ts`:

```ts
// src/pipeline/templates/template-ofertas.ts
//
// Single flat caption format cloning the reference deals group ("Ofertas na
// Tela"). Store hashtag, uppercased hook, ML FULL badge, green PIX/à-vista
// price line, coupon code only. No affiliate disclaimer (added elsewhere: none).

import type { ScoredDeal, DealLevel } from '../../deal-score/types';
import type { SourceId } from '../../sources/source.port';
import type { PriceView } from '../../pricing/price-view';
import type { CouponView } from '../../coupon/coupon.types';

export interface OfertasTemplateInput {
  sd: ScoredDeal;
  link: string;
  hook: string;
  priceView?: PriceView;
  couponView?: CouponView;
}

export function sourceHashtag(source: SourceId): string {
  return source === 'shopee' ? '#Shopee' : '#MercadoLivre';
}

export function linkLabel(source: SourceId): string {
  return source === 'shopee' ? 'Link do produto:' : 'Link:';
}

function hookEmoji(level: DealLevel): string {
  if (level === 'super') return '🚨';
  if (level === 'top') return '🔥🔥';
  return '🔥';
}

/** Integer reais, pt-BR thousands, cents floored: 484699 -> "R$ 4.846". */
function priceIntBRL(cents: number): string {
  return `R$ ${Math.floor(cents / 100).toLocaleString('pt-BR')}`;
}

export function ofertasTemplate(input: OfertasTemplateInput): string {
  const { sd, link, hook, priceView, couponView } = input;
  const raw = sd.deal.raw;
  const source = sd.deal.key.source;
  const lines: string[] = [];

  lines.push(sourceHashtag(source));
  if (hook) lines.push(`${hook.toLocaleUpperCase('pt-BR')} ${hookEmoji(sd.level)}`);
  lines.push('');

  lines.push(`➡️ ${raw.title}`);
  if (sd.deal.signals.isFull) lines.push('⚡ FULL');
  lines.push('');

  const pix = priceView?.pixPriceCents ?? null;
  const displayCents = pix ?? priceView?.priceCents ?? raw.priceCents;
  const priceLabel = pix != null ? 'no PIX' : 'à vista';
  lines.push(`✅ ${priceIntBRL(displayCents)} ${priceLabel}`);

  if (couponView) lines.push(`🎟️ Use o cupom: ${couponView.code}`);
  lines.push(`🛒 ${linkLabel(source)} ${link}`);

  return lines.join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/pipeline/templates/template-ofertas.spec.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/templates/template-ofertas.ts src/pipeline/templates/template-ofertas.spec.ts
git commit -m "feat(pipeline): add ofertasTemplate clone caption format"
```

---

### Task 3: Rewire `formatScored` to `ofertasTemplate` (drop disclaimer, ignore variant)

**Files:**
- Modify: `src/pipeline/formatter.service.ts` (`formatScored` body; keep signature)
- Test: `src/pipeline/formatter.service.spec.ts` (replace the `formatScored` + coupon `describe` blocks; leave the `formatItem` block untouched)

**Interfaces:**
- Consumes: `ofertasTemplate`, `sourceHashtag`, `linkLabel` from Task 2; `signals.isFull` from Task 1.
- Produces: `formatScored(scored, variant?, trustBadge?, priceView?, couponView?)` returns `{ caption, imageUrl }` where `caption` is the `ofertasTemplate` body with NO disclaimer and NO trailing extras. `variant` and `trustBadge` are accepted but ignored.

- [ ] **Step 1: Write the failing tests**

In `src/pipeline/formatter.service.spec.ts`, REPLACE the two `describe` blocks `'FormatterService.formatScored'` and `'FormatterService coupon line'` (lines 188-321) with:

```ts
describe('FormatterService.formatScored (ofertas clone)', () => {
  it('emits hashtag, uppercased hook, title, price and link — no disclaimer', async () => {
    const svc = new FormatterService(makeAffiliate(), makeHeadline('que preço'));
    const { caption } = await svc.formatScored(makeScored('good'));
    expect(caption.split('\n')[0]).toBe('#MercadoLivre');
    expect(caption).toContain('QUE PREÇO 🔥');
    expect(caption).toContain('➡️ T');
    expect(caption).toContain('🛒 Link: https://meli.la/ABC');
    expect(caption).not.toMatch(/Link de afiliado/);
    expect(caption).not.toMatch(/PROMOÇÃO/);
  });

  it('shows à vista when no priceView, no PIX when pixPriceCents present', async () => {
    const svc = new FormatterService(makeAffiliate(), makeHeadline('h'));
    const noPix = await svc.formatScored(makeScored('good'));
    expect(noPix.caption).toContain('✅ R$ 100 à vista');

    const withPix = await svc.formatScored(makeScored('good'), 'A', undefined, {
      priceCents: 10000,
      originalPriceCents: 20000,
      discountPercent: 50,
      pixPriceCents: 8780,
      installments: null,
      scrapedAt: '2026-07-15T20:00:00.000Z',
    });
    expect(withPix.caption).toContain('✅ R$ 87 no PIX');
  });

  it('renders ⚡ FULL when signals.isFull', async () => {
    const svc = new FormatterService(makeAffiliate(), makeHeadline('h'));
    const scored = makeScored('good');
    scored.deal.signals.isFull = true;
    const { caption } = await svc.formatScored(scored);
    expect(caption).toContain('⚡ FULL');
  });

  it('renders coupon code only', async () => {
    const svc = new FormatterService(makeAffiliate(), makeHeadline('h'));
    const { caption } = await svc.formatScored(makeScored('good'), 'A', undefined, undefined, {
      code: 'ABC',
      mode: 'PRICE',
      finalCents: 8000,
      discountLabel: '-R$ 20',
      minCents: null,
      validUntil: '2999-01-01T00:00:00.000Z',
    });
    expect(caption).toContain('🎟️ Use o cupom: ABC');
    expect(caption).not.toMatch(/válido até/);
  });

  it('no couponView -> no coupon line', async () => {
    const svc = new FormatterService(makeAffiliate(), makeHeadline('h'));
    const { caption } = await svc.formatScored(makeScored('good'));
    expect(caption).not.toContain('🎟️');
  });
});
```

Note: `makeScored` (lines 140-186) must have `isFull` available on signals — since `isFull` is optional, no change needed, but add `isFull: false` to its `signals` literal for clarity:

```ts
      signals: {
        freeShipping: true,
        installmentsNoInterest: true,
        volumeTier: 'mid',
        isVerifiedStore: true,
        isFull: false,
      },
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/pipeline/formatter.service.spec.ts -t "ofertas clone"`
Expected: FAIL — current `formatScored` still emits `PROMOÇÃO`/disclaimer, no `#MercadoLivre`.

- [ ] **Step 3: Rewrite `formatScored`**

In `src/pipeline/formatter.service.ts`:

1. Update imports at the top — remove the level-template imports, add the new template:

```ts
import { ofertasTemplate } from './templates/template-ofertas';
```

Remove:

```ts
import { CaptionTemplate, templates, templatesByLevel } from './templates';
import { variantBByLevel } from './templates/variants';
```

Keep the legacy `templates` import ONLY if `formatItem` still uses it. `formatItem` uses `this.templates[0]`, so keep:

```ts
import { templates } from './templates';
import type { CaptionTemplate } from './templates';
```

2. Replace the entire `formatScored` method body with:

```ts
  async formatScored(
    scored: ScoredDeal,
    _variant: CopyVariant = 'A',
    _trustBadge?: TrustBadge,
    priceView?: PriceView,
    couponView?: CouponView,
  ): Promise<{ caption: string; imageUrl: string }> {
    const raw = scored.deal.raw;
    const headlineItem = scoredDealToHeadlineItem(scored);
    const [link, hook] = await Promise.all([
      this.resolveLink(raw),
      this.headline.generate(headlineItem),
    ]);
    const caption = ofertasTemplate({
      sd: scored,
      link,
      hook,
      priceView,
      couponView,
    });
    const imageUrl = this.toHiResImage(raw.thumbnail || '');
    return { caption, imageUrl };
  }
```

(`_variant`/`_trustBadge` prefixed to mark intentionally unused; signature preserved so the worker call at `send-deal.worker.ts:150` needs no change.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/pipeline/formatter.service.spec.ts -t "ofertas clone"`
Expected: PASS.

- [ ] **Step 5: Run the whole formatter spec**

Run: `npx jest src/pipeline/formatter.service.spec.ts`
Expected: PASS — the `formatItem` block still passes (legacy path untouched). If TS complains about now-unused private methods (`injectPriceExtras`, `priceExtraLines`, `couponLine`, `appendCouponLine`, `formatUntil`), that surfaces in Task 5; leave them for now (unused-private is not a test failure).

- [ ] **Step 6: Commit**

```bash
git add src/pipeline/formatter.service.ts src/pipeline/formatter.service.spec.ts
git commit -m "feat(pipeline): formatScored uses ofertas clone, drops disclaimer + A/B"
```

---

### Task 4: Rewire `formatDigest` to the clone block (drop disclaimer)

**Files:**
- Modify: `src/pipeline/formatter.service.ts` (`formatDigest`, `digestBlock`)
- Test: `src/pipeline/formatter-digest.spec.ts` (rewrite expectations)

**Interfaces:**
- Consumes: `ofertasTemplate` from Task 2.
- Produces: `formatDigest(entries)` returns `{ caption, imageUrl }`; each entry rendered via `ofertasTemplate`, blocks joined by `\n\n➖➖➖\n\n`, header `🔥 {n} ACHADOS NUM POST SÓ`, NO disclaimer.

- [ ] **Step 1: Read the current digest spec**

Run: `cat src/pipeline/formatter-digest.spec.ts` and note which assertions reference the old block shape (`💰`, `De:`/`Por:`, disclaimer). Those get replaced in Step 3's test rewrite.

- [ ] **Step 2: Write the failing test**

Replace the body assertions in `src/pipeline/formatter-digest.spec.ts` so the suite asserts the clone shape. Representative test (keep the file's existing imports/`makeScored` helper; adapt names as needed):

```ts
it('renders one clone block per deal, joined, header, no disclaimer', async () => {
  const svc = new FormatterService(makeAffiliate(), makeHeadline('h'));
  const { caption } = await svc.formatDigest([
    { scored: makeScored('top'), variant: 'A' },
    { scored: makeScored('good'), variant: 'A' },
  ]);
  expect(caption).toContain('🔥 2 ACHADOS NUM POST SÓ');
  expect(caption).toContain('➖➖➖');
  expect(caption).toContain('➡️');
  expect(caption).toContain('🛒 Link:');
  expect(caption).not.toMatch(/Link de afiliado/);
});

it('threads couponView code into a digest block', async () => {
  const svc = new FormatterService(makeAffiliate(), makeHeadline('h'));
  const { caption } = await svc.formatDigest([
    {
      scored: makeScored('top'),
      variant: 'A',
      couponView: {
        code: 'DIGCUP',
        mode: 'PRICE',
        finalCents: 9000,
        discountLabel: '-10%',
        minCents: null,
        validUntil: '2999-01-01T00:00:00.000Z',
      },
    },
  ]);
  expect(caption).toContain('🎟️ Use o cupom: DIGCUP');
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx jest src/pipeline/formatter-digest.spec.ts`
Expected: FAIL — old digest still emits `💰`/disclaimer, not the clone block.

- [ ] **Step 4: Rewrite `formatDigest` + `digestBlock`**

In `src/pipeline/formatter.service.ts`, replace `formatDigest` and DELETE the now-unused `digestBlock` method entirely. New `formatDigest`:

```ts
  async formatDigest(
    entries: Array<{
      scored: ScoredDeal;
      variant: CopyVariant;
      priceView?: PriceView;
      couponView?: CouponView;
    }>,
  ): Promise<{ caption: string; imageUrl: string }> {
    if (entries.length === 0) {
      throw new Error('formatDigest requires at least one deal');
    }
    const [links, hooks] = await Promise.all([
      Promise.all(entries.map((e) => this.resolveLink(e.scored.deal.raw))),
      Promise.all(
        entries.map((e) =>
          this.headline.generate(scoredDealToHeadlineItem(e.scored)),
        ),
      ),
    ]);
    const blocks = entries.map((e, i) =>
      ofertasTemplate({
        sd: e.scored,
        link: links[i],
        hook: hooks[i],
        priceView: e.priceView,
        couponView: e.couponView,
      }),
    );
    const header = `🔥 ${entries.length} ACHADOS NUM POST SÓ`;
    const caption = [header, '', blocks.join('\n\n➖➖➖\n\n')].join('\n');
    const imageUrl = this.toHiResImage(
      entries[0].scored.deal.raw.thumbnail || '',
    );
    return { caption, imageUrl };
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest src/pipeline/formatter-digest.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/pipeline/formatter.service.ts src/pipeline/formatter-digest.spec.ts
git commit -m "feat(pipeline): formatDigest uses ofertas clone blocks, drops disclaimer"
```

---

### Task 5: Delete dead templates + obsolete specs; clean formatter internals

**Files:**
- Delete: `src/pipeline/templates/template-good.ts`, `template-top.ts`, `template-imperdivel.ts`, `variants.ts`
- Delete: `src/pipeline/formatter-variant.spec.ts`, `src/pipeline/formatter-trust-badge.spec.ts`
- Modify: `src/pipeline/templates/index.ts`
- Modify: `src/pipeline/formatter.service.ts` (remove now-unused private methods + imports)

**Interfaces:**
- Produces: `templates/index.ts` no longer exports `templatesByLevel` / `variantBByLevel` / `ScoredCaptionTemplate`. It keeps the legacy `templates`, `fireTemplate`, and `CaptionTemplate` exports (used by `formatItem`).

- [ ] **Step 1: Confirm no other importers**

Run: `grep -rn "templatesByLevel\|variantBByLevel\|template-good\|template-top\|template-imperdivel\|templates/variants" src`
Expected: matches ONLY in `formatter.service.ts` (already rewired in Tasks 3-4), `index.ts`, and the files being deleted. If anything else references them, stop and reassess.

- [ ] **Step 2: Delete the dead template files + obsolete specs**

```bash
git rm src/pipeline/templates/template-good.ts src/pipeline/templates/template-top.ts src/pipeline/templates/template-imperdivel.ts src/pipeline/templates/variants.ts src/pipeline/formatter-variant.spec.ts src/pipeline/formatter-trust-badge.spec.ts
```

- [ ] **Step 3: Update `templates/index.ts`**

Replace the whole file with:

```ts
// Legacy caption template kept for the fireTemplate consumer (formatItem).
export { fireTemplate } from './template-fire';
export { templates } from './legacy';
export type { CaptionTemplate } from './template-fire-types';

// Clone caption format (Ofertas na Tela).
export { ofertasTemplate, sourceHashtag, linkLabel } from './template-ofertas';
export type { OfertasTemplateInput } from './template-ofertas';
```

- [ ] **Step 4: Remove now-unused private methods from `formatter.service.ts`**

Delete these methods (no longer called after Tasks 3-4): `injectPriceExtras`, `priceExtraLines`, `couponLine`, `appendCouponLine`, `formatUntil`. Keep: `formatBRL`, `resolveLink`, `disclaimerLine` (still used by `formatItem`), `toHiResImage`, `formatItem`.

Also remove now-unused type imports if the compiler flags them (e.g. `TrustBadge` if no longer referenced — but it is still a param type on `formatScored`, so keep it).

- [ ] **Step 5: Typecheck + full test suite**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npx jest src/pipeline`
Expected: PASS (formatter, formatter-digest, template-ofertas; variant/trust-badge specs gone).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(pipeline): remove level/AB templates + dead formatter internals"
```

---

### Task 6: Full regression + verify

**Files:** none (verification only)

- [ ] **Step 1: Full test suite**

Run: `npx jest`
Expected: PASS. Likely-affected specs already updated: `mapping.spec.ts`, `formatter.service.spec.ts`, `formatter-digest.spec.ts`, `template-ofertas.spec.ts`. If any OTHER spec fails (e.g. a fixture asserting old caption text like `PROMOÇÃO`), fix its expectation to the clone format — do NOT change production code to satisfy a stale assertion.

- [ ] **Step 2: Typecheck + lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: clean.

- [ ] **Step 3: Eyeball a rendered caption**

Add a throwaway check (or use an existing manual harness) to print `formatScored` output for a `good`-level ML deal with `isFull: true` and a `pixPriceCents`. Confirm the layout matches:

```
#MercadoLivre
<HOOK> 🔥

➡️ <title>
⚡ FULL

✅ R$ <int> no PIX
🎟️ Use o cupom: <CODE>
🛒 Link: <link>
```

Delete the throwaway before finishing.

- [ ] **Step 4: Final commit (if Step 1 required spec fixes)**

```bash
git add -A
git commit -m "test: align remaining specs with ofertas clone caption"
```

---

## Self-Review

**Spec coverage:**
- Layout único ML+Shopee → Task 2 (`ofertasTemplate`), wired in Tasks 3-4. ✓
- Substitui 6 templates + A/B → Task 5 deletes them; Task 3 ignores `variant`. ✓
- Preço PIX honesto (no PIX / à vista) → Task 2 price line + Task 3 tests. ✓
- Sem disclaimer → Tasks 3 & 4 drop it. ✓
- Hashtag por source → `sourceHashtag` Task 2. ✓
- FULL → Task 1 plumbing + Task 2 render. ✓
- PIX verde `✅` → Task 2. ✓
- Cupom só-código → Task 2 + Task 3 tests. ✓
- Link label por source → `linkLabel` Task 2. ✓
- Digest clone → Task 4. ✓
- `formatItem` legacy intocado → stated in Global Constraints, Task 3 keeps `templates`/`disclaimerLine`. ✓

**Placeholder scan:** No TBD/TODO. All code steps show full code. (Task 4 Step 4 flags and removes a stray helper line explicitly.)

**Type consistency:** `toEnrichedDeal(..., isFull = false)`, `signals.isFull?`, `DealItem.isFull?`, `ofertasTemplate({ sd, link, hook, priceView?, couponView? })`, `sourceHashtag(SourceId)`, `linkLabel(SourceId)` — used consistently across Tasks 1-4. `formatScored` signature preserved (worker unaffected).
