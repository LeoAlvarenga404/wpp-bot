# Selo de Preço Monitorado — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Todo post com badge de menor preço sai com proveniência do histórico: `📉 Menor preço em 30 dias ✓ monitorado há 42 dias`.

**Architecture:** O selo é calculado no enqueue (`PipelineService.enqueueScored`) a partir do cache em memória do `CurationService`, viaja no payload do job BullMQ (`SendDealJob.trustBadge`, campo opcional) e é renderizado pelos templates via novo parâmetro opcional `trustLine`. Flag `TRUST_BADGE_ENABLED` (default `true`) desliga tudo no pipeline.

**Tech Stack:** NestJS 10, BullMQ, Jest. Spec: `docs/superpowers/specs/2026-07-15-selo-preco-monitorado-design.md`.

## Global Constraints

- Texto do selo: `{label} ✓ monitorado há {monitoredDays} dias` onde `label` é o retorno literal de `CurationService.getLowestPriceBadge` (ex.: `📉 Menor preço em 30 dias`).
- Campo novo no job é **opcional** (`trustBadge?`) — job antigo no Redis sem o campo se comporta exatamente como hoje (mesmo contrato do `variant?`).
- Sem selo → fallback na linha atual de reasons (`pickHistoryLine`) onde ela existe hoje (top/super variante A). Nada regride.
- A linha de selo é idêntica nas variantes A e B — não contamina o experimento de copy.
- `TRUST_BADGE_ENABLED` default `true`; `false` → pipeline nunca preenche o campo.
- Nenhum `@Injectable` novo. Flag lida via `ConfigService` dentro de método de service existente (lição Fase 2: constructor com números-com-default crash-loopa o Nest).
- Suite existente (201 testes) permanece verde. Rodar com `npm test`.
- **Sem nota/score numérico no post** — proposto e rejeitado pelo dono.

---

### Task 1: Tipo `TrustBadge` + renderização nos templates e formatter

**Files:**
- Modify: `src/queue/queue.types.ts`
- Modify: `src/pipeline/templates/index.ts`
- Modify: `src/pipeline/templates/template-good.ts`
- Modify: `src/pipeline/templates/template-top.ts`
- Modify: `src/pipeline/templates/template-imperdivel.ts`
- Modify: `src/pipeline/templates/variants.ts`
- Modify: `src/pipeline/formatter.service.ts:78-101`
- Test (create): `src/pipeline/formatter-trust-badge.spec.ts`

**Interfaces:**
- Consumes: `FormatterService.formatScored(scored, variant)` atual; `ScoredCaptionTemplate` atual (4 params).
- Produces:
  - `export interface TrustBadge { label: string; monitoredDays: number }` em `src/queue/queue.types.ts`.
  - `SendDealJob.trustBadge?: TrustBadge` (mesmo arquivo).
  - `FormatterService.formatScored(scored: ScoredDeal, variant: CopyVariant = 'A', trustBadge?: TrustBadge)`.
  - `ScoredCaptionTemplate = (sd, formatBRL, link, hook, trustLine?: string | null) => string`.

- [ ] **Step 1: Write the failing test**

Criar `src/pipeline/formatter-trust-badge.spec.ts`:

```typescript
import { FormatterService } from './formatter.service';
import type { ScoredDeal } from '../deal-score/types';
import type { TrustBadge } from '../queue/queue.types';

function makeScored(
  level: 'good' | 'top' | 'super' = 'top',
  reasons: { code: string; message: string }[] = [],
): ScoredDeal {
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
    score: 90,
    rawScore: 90,
    level,
    reasons,
    penalties: [],
    factors: {},
  } as ScoredDeal;
}

function makeFormatter(): FormatterService {
  const affiliate = { resolve: jest.fn().mockResolvedValue('https://aff/x') };
  const headline = { generate: jest.fn().mockResolvedValue('HOOK 🔥') };
  return new FormatterService(affiliate as any, headline as any);
}

const badge: TrustBadge = {
  label: '📉 Menor preço em 30 dias',
  monitoredDays: 42,
};
const SELO = '📉 Menor preço em 30 dias ✓ monitorado há 42 dias';

describe('formatScored trust badge', () => {
  it.each(['good', 'top', 'super'] as const)(
    'renders selo on variant A level=%s',
    async (level) => {
      const f = makeFormatter();
      const { caption } = await f.formatScored(makeScored(level), 'A', badge);
      expect(caption).toContain(SELO);
    },
  );

  it.each(['good', 'top', 'super'] as const)(
    'renders selo on variant B level=%s',
    async (level) => {
      const f = makeFormatter();
      const { caption } = await f.formatScored(makeScored(level), 'B', badge);
      expect(caption).toContain(SELO);
    },
  );

  it('falls back to reason line on top when no badge', async () => {
    const f = makeFormatter();
    const scored = makeScored('top', [
      { code: 'lowest_price_30d', message: 'Menor preço dos últimos 30 dias' },
    ]);
    const { caption } = await f.formatScored(scored, 'A');
    expect(caption).toContain('📉 Menor preço dos últimos 30 dias');
    expect(caption).not.toContain('monitorado há');
  });

  it('renders no history line without badge and without reasons', async () => {
    const f = makeFormatter();
    const { caption } = await f.formatScored(makeScored('top'), 'A');
    expect(caption).not.toContain('📉');
    expect(caption).not.toContain('monitorado há');
  });

  it('selo replaces (not duplicates) the reason line', async () => {
    const f = makeFormatter();
    const scored = makeScored('top', [
      { code: 'lowest_price_30d', message: 'Menor preço dos últimos 30 dias' },
    ]);
    const { caption } = await f.formatScored(scored, 'A', badge);
    expect(caption).toContain(SELO);
    expect(caption).not.toContain('📉 Menor preço dos últimos 30 dias');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- formatter-trust-badge`
Expected: FAIL — TS error `Expected 1-2 arguments, but got 3` (formatScored ainda não aceita `trustBadge`), e/ou `Module '"../queue/queue.types"' has no exported member 'TrustBadge'`.

- [ ] **Step 3: Implement**

`src/queue/queue.types.ts` — adicionar tipo e campo:

```typescript
import type { ScoredDeal } from '../deal-score/types';

export const SEND_DEAL_QUEUE = 'send-deal';

/** Prova de proveniência do histórico de preço, calculada no enqueue. */
export interface TrustBadge {
  /** Retorno literal de CurationService.getLowestPriceBadge. */
  label: string;
  /** CurationService.historyDays(catalogId) no momento do enqueue. */
  monitoredDays: number;
}

export interface SendDealJob {
  targetJid: string;
  /** Publisher channel. Optional so jobs already sitting in Redis
   *  (pre-upgrade) still process as WhatsApp. */
  channel?: 'wa' | 'telegram';
  /** Catalog key string (source:externalId) — also doubles as the BullMQ
   *  job id so duplicate enqueues for the same (deal, target) coalesce. */
  catalogKey: string;
  /** Copy A/B variant. Optional: jobs enqueued pre-Fase-2 default to 'A'. */
  variant?: 'A' | 'B';
  /** Selo de preço monitorado. Optional: absent = render like today. */
  trustBadge?: TrustBadge;
  scored: ScoredDeal;
}
```

`src/pipeline/templates/index.ts` — 5º parâmetro opcional:

```typescript
export type ScoredCaptionTemplate = (
  sd: ScoredDeal,
  formatBRL: (n: number) => string,
  link: string,
  hook: string,
  trustLine?: string | null,
) => string;
```

`src/pipeline/templates/template-top.ts` — selo substitui a linha de reason:

```typescript
export const topTemplate = (
  sd: ScoredDeal,
  formatBRL: (n: number) => string,
  link: string,
  hook: string,
  trustLine?: string | null,
): string => {
  const raw = sd.deal.raw;
  const price = raw.priceCents / 100;
  const lines: string[] = [];
  lines.push('🔥 PROMOÇÃO TOP');
  if (hook) lines.push(hook);
  lines.push('');
  lines.push(`📦 ${raw.title}`);
  lines.push(`💰 *${formatBRL(price)}* (-${raw.discountPercent}%)`);
  const extras: string[] = [];
  if (sd.deal.signals.installmentsNoInterest)
    extras.push(`${pickInstallments(price)} sem juros`);
  if (sd.deal.signals.freeShipping) extras.push('🚚 frete grátis');
  if (extras.length) lines.push(extras.join(' · '));
  lines.push('');
  const historyLine = trustLine ?? pickHistoryLine(sd);
  if (historyLine) lines.push(historyLine);
  lines.push('');
  lines.push(`🛒 ${link}`);
  return lines.join('\n');
};
```

(`pickHistoryLine` e `pickInstallments` ficam como estão.)

`src/pipeline/templates/template-imperdivel.ts` — mesma troca:

```typescript
export const imperdivelTemplate = (
  sd: ScoredDeal,
  formatBRL: (n: number) => string,
  link: string,
  hook: string,
  trustLine?: string | null,
): string => {
  const raw = sd.deal.raw;
  const price = raw.priceCents / 100;
  const lines: string[] = [];
  lines.push('🚨 PROMOÇÃO IMPERDÍVEL');
  if (hook) lines.push(hook);
  lines.push('');
  lines.push(`📦 ${raw.title}`);
  lines.push('');
  lines.push(`💰 *${formatBRL(price)}* (-${raw.discountPercent}%)`);
  if (sd.deal.signals.installmentsNoInterest) {
    lines.push(`💳 ${pickInstallments(price, formatBRL)} sem juros`);
  }
  if (sd.deal.signals.freeShipping) lines.push('🚚 Frete grátis');
  lines.push('');

  const historyLine = trustLine ?? pickHistoryLine(sd);
  if (historyLine) lines.push(historyLine);

  const sellerLine = pickSellerLine(sd);
  if (sellerLine) lines.push(sellerLine);

  lines.push('');
  lines.push(`🛒 ${link}`);
  return lines.join('\n');
};
```

(demais funções do arquivo intocadas.)

`src/pipeline/templates/template-good.ts` — good não tinha linha de histórico; selo entra quando existir:

```typescript
export const goodTemplate = (
  sd: ScoredDeal,
  formatBRL: (n: number) => string,
  link: string,
  hook: string,
  trustLine?: string | null,
): string => {
  const raw = sd.deal.raw;
  const price = raw.priceCents / 100;
  const lines: string[] = [];
  lines.push('💸 Promoção');
  if (hook) lines.push(hook);
  lines.push('');
  lines.push(`📦 ${raw.title}`);
  lines.push(`💰 *${formatBRL(price)}* (-${raw.discountPercent}%)`);
  if (sd.deal.signals.freeShipping) lines.push('🚚 Frete grátis');
  if (trustLine) {
    lines.push('');
    lines.push(trustLine);
  }
  lines.push('');
  lines.push(`🛒 ${link}`);
  return lines.join('\n');
};
```

`src/pipeline/templates/variants.ts` — os 3 templates B ganham o selo entre o bloco De/Por e o CTA. Padrão idêntico nos três (mostrado no `topB`; repetir em `goodB` e `superB` na mesma posição — depois das linhas de sinais, antes da linha em branco + CTA):

```typescript
const goodB: ScoredCaptionTemplate = (sd, formatBRL, link, hook, trustLine) => {
  const lines: string[] = [];
  if (hook) lines.push(hook, '');
  lines.push(`📦 ${sd.deal.raw.title}`, '');
  lines.push(...dePorBlock(sd, formatBRL));
  if (sd.deal.signals.freeShipping) lines.push('🚚 Frete grátis');
  if (trustLine) lines.push('', trustLine);
  lines.push('', `👉 Garante aqui: ${link}`);
  return lines.join('\n');
};

const topB: ScoredCaptionTemplate = (sd, formatBRL, link, hook, trustLine) => {
  const lines: string[] = ['🔥 ACHADO DO DIA'];
  if (hook) lines.push(hook);
  lines.push('', `📦 ${sd.deal.raw.title}`, '');
  lines.push(...dePorBlock(sd, formatBRL));
  if (sd.deal.signals.freeShipping) lines.push('🚚 Frete grátis');
  if (sd.deal.signals.isVerifiedStore) lines.push('🏬 Loja oficial');
  if (trustLine) lines.push('', trustLine);
  lines.push('', `👉 Corre: ${link}`);
  return lines.join('\n');
};

const superB: ScoredCaptionTemplate = (sd, formatBRL, link, hook, trustLine) => {
  const lines: string[] = ['🚨 RARO DE VER 🚨'];
  if (hook) lines.push(hook);
  lines.push('', `📦 ${sd.deal.raw.title}`, '');
  lines.push(...dePorBlock(sd, formatBRL));
  if (sd.deal.signals.freeShipping) lines.push('🚚 Frete grátis');
  if (sd.deal.signals.isVerifiedStore) lines.push('🏬 Loja oficial');
  if (trustLine) lines.push('', trustLine);
  lines.push('', '⏳ Preço assim não dura.', `👉 ${link}`);
  return lines.join('\n');
};
```

`src/pipeline/formatter.service.ts` — `formatScored` monta a linha e repassa:

```typescript
import type { TrustBadge } from '../queue/queue.types';
```

```typescript
  async formatScored(
    scored: ScoredDeal,
    variant: CopyVariant = 'A',
    trustBadge?: TrustBadge,
  ): Promise<{ caption: string; imageUrl: string }> {
    const raw = scored.deal.raw;
    const headlineItem = scoredDealToHeadlineItem(scored);
    const [link, hook] = await Promise.all([
      this.affiliate.resolve(raw.permalink),
      this.headline.generate(headlineItem),
    ]);
    const formatBRL = (n: number) => this.formatBRL(n);

    // 'rejected' level never reaches dispatch; fall back to good template defensively.
    const level =
      scored.level === 'super' || scored.level === 'top'
        ? scored.level
        : 'good';
    const byLevel = variant === 'B' ? variantBByLevel : templatesByLevel;
    const tmpl = byLevel[level];

    const trustLine = trustBadge
      ? `${trustBadge.label} ✓ monitorado há ${trustBadge.monitoredDays} dias`
      : null;

    const caption = `${tmpl(scored, formatBRL, link, hook, trustLine)}\n\n${this.disclaimerLine()}`;
    const imageUrl = this.toHiResImage(raw.thumbnail || '');
    return { caption, imageUrl };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- formatter-trust-badge`
Expected: PASS (9 testes).

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: tudo verde (201 existentes + 9 novos). Atenção especial a `formatter-variant.spec.ts` e `formatter.service.spec.ts` — não devem quebrar (parâmetro novo é opcional).

- [ ] **Step 6: Commit**

```bash
git add src/queue/queue.types.ts src/pipeline/templates/ src/pipeline/formatter.service.ts src/pipeline/formatter-trust-badge.spec.ts
git commit -m "feat(copy): selo de preco monitorado nos templates (TrustBadge + trustLine)"
```

---

### Task 2: Pipeline preenche `trustBadge` no enqueue

**Files:**
- Modify: `src/pipeline/pipeline.service.ts:172-203` (loop de `enqueueScored`)
- Test: `src/pipeline/pipeline.service.spec.ts` (describe `enqueueScored` existente)

**Interfaces:**
- Consumes: `TrustBadge` de `src/queue/queue.types.ts` (Task 1); `CurationService.getLowestPriceBadge(catalogId: string, currentPriceCents: number): string | null`; `CurationService.historyDays(catalogId: string): number` (ambos já existem, síncronos).
- Produces: jobs `send-deal` com `trustBadge?: TrustBadge` no payload quando badge disponível e `TRUST_BADGE_ENABLED !== 'false'`.

- [ ] **Step 1: Write the failing tests**

Em `src/pipeline/pipeline.service.spec.ts`:

1. No mock `curation` de `makeDeps` (linha ~87), adicionar os dois métodos:

```typescript
  const curation = {
    record: jest.fn(async () => undefined),
    isFakeDiscount: jest.fn(() => false),
    getLowestPriceBadge: jest.fn(() => null),
    historyDays: jest.fn(() => 0),
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
```

2. No fim do `describe('PipelineService.enqueueScored', ...)`, adicionar:

```typescript
  it('fills trustBadge when curation has a badge', async () => {
    const d = makeDeps({ rawDeals: [] });
    d.targets.getActiveTargets.mockResolvedValue([
      { jid: '123@g.us', name: 'g', active: true, channel: 'wa' },
    ]);
    d.curation.getLowestPriceBadge.mockReturnValue(
      '📉 Menor preço em 30 dias',
    );
    d.curation.historyDays.mockReturnValue(42);

    await d.pipeline.enqueueScored([scoredFixture()], 3);

    expect(d.curation.getLowestPriceBadge).toHaveBeenCalledWith(
      'ml:MLB1',
      10000,
    );
    expect(d.sendQueue.add).toHaveBeenCalledWith(
      'send-deal',
      expect.objectContaining({
        trustBadge: { label: '📉 Menor preço em 30 dias', monitoredDays: 42 },
      }),
      expect.anything(),
    );
  });

  it('omits trustBadge when curation returns no badge', async () => {
    const d = makeDeps({ rawDeals: [] });
    d.targets.getActiveTargets.mockResolvedValue([
      { jid: '123@g.us', name: 'g', active: true, channel: 'wa' },
    ]);

    await d.pipeline.enqueueScored([scoredFixture()], 3);

    const payload = d.sendQueue.add.mock.calls[0][1];
    expect(payload.trustBadge).toBeUndefined();
  });

  it('omits trustBadge when TRUST_BADGE_ENABLED=false', async () => {
    const d = makeDeps({ rawDeals: [] });
    d.targets.getActiveTargets.mockResolvedValue([
      { jid: '123@g.us', name: 'g', active: true, channel: 'wa' },
    ]);
    d.curation.getLowestPriceBadge.mockReturnValue(
      '📉 Menor preço em 30 dias',
    );
    d.curation.historyDays.mockReturnValue(42);
    (d.pipeline as any).config = {
      get: (k: string, def?: string) =>
        k === 'TRUST_BADGE_ENABLED' ? 'false' : def,
    };

    await d.pipeline.enqueueScored([scoredFixture()], 3);

    const payload = d.sendQueue.add.mock.calls[0][1];
    expect(payload.trustBadge).toBeUndefined();
    expect(d.curation.getLowestPriceBadge).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- pipeline.service`
Expected: FAIL — os 3 testes novos falham (`trustBadge` ausente do payload / `getLowestPriceBadge` nunca chamado). Os antigos continuam verdes.

- [ ] **Step 3: Implement**

Em `src/pipeline/pipeline.service.ts`, dentro de `enqueueScored`, no loop `for (const { scored: sd, variant } of selected)` — calcular UMA vez por deal, antes do loop de targets, e incluir no payload:

```typescript
import type { SendDealJob, TrustBadge } from '../queue/queue.types';
```

```typescript
    const trustBadgeEnabled =
      this.config.get<string>('TRUST_BADGE_ENABLED', 'true') !== 'false';

    let enqueued = 0;
    let topScore: number | null = null;
    for (const { scored: sd, variant } of selected) {
      if (topScore === null) topScore = sd.score;
      const catalogKey = keyToString(sd.deal.key);

      let trustBadge: TrustBadge | undefined;
      if (trustBadgeEnabled) {
        const label = this.curation.getLowestPriceBadge(
          catalogKey,
          sd.deal.raw.priceCents,
        );
        if (label) {
          trustBadge = {
            label,
            monitoredDays: this.curation.historyDays(catalogKey),
          };
        }
      }

      let dealEnqueued = false;
      for (const target of activeTargets) {
        // jobId = `<key>:<jid>` so re-enqueues for the same deal+target
        // coalesce while waiting in the queue.
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
              trustBadge,
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

(Resto do método intocado. `trustBadge: undefined` é removido pelo `JSON.stringify` do BullMQ — payload no Redis fica idêntico ao atual quando não há selo.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- pipeline.service`
Expected: PASS (todos, incluindo os 3 novos).

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/pipeline.service.ts src/pipeline/pipeline.service.spec.ts
git commit -m "feat(pipeline): calcula trustBadge no enqueue (flag TRUST_BADGE_ENABLED)"
```

---

### Task 3: Worker repassa `trustBadge` ao formatter

**Files:**
- Modify: `src/worker/send-deal.worker.ts:87-92`
- Test: `src/worker/send-deal.worker.spec.ts`

**Interfaces:**
- Consumes: `SendDealJob.trustBadge?` (Task 1); `formatScored(scored, variant, trustBadge?)` (Task 1).
- Produces: nada novo — wire-through.

- [ ] **Step 1: Write the failing test**

Em `src/worker/send-deal.worker.spec.ts`, adicionar ao `describe('SendDealWorker.process', ...)`:

```typescript
  it('passes trustBadge through to the formatter', async () => {
    const d = makeDeps();
    const worker = makeWorker(d);
    const job = makeJob('wa');
    job.data.trustBadge = {
      label: '📉 Menor preço em 30 dias',
      monitoredDays: 42,
    };

    await (worker as any).process(job);

    expect(d.formatter.formatScored).toHaveBeenCalledWith(
      expect.anything(),
      'B',
      { label: '📉 Menor preço em 30 dias', monitoredDays: 42 },
    );
  });
```

(Os asserts existentes `toHaveBeenCalledWith(expect.anything(), 'B')` continuam passando: chamada com terceiro argumento `undefined` é igual para o matcher do Jest.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- send-deal.worker`
Expected: FAIL — o teste novo falha (`formatScored` chamado sem o terceiro argumento).

- [ ] **Step 3: Implement**

Em `src/worker/send-deal.worker.ts`, método `process`:

```typescript
    const variant = job.data.variant ?? 'A';
    const publisher = this.publishers.get(channel);
    const { caption, imageUrl } = await this.formatter.formatScored(
      scored,
      variant,
      job.data.trustBadge,
    );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- send-deal.worker`
Expected: PASS (5 testes).

- [ ] **Step 5: Commit**

```bash
git add src/worker/send-deal.worker.ts src/worker/send-deal.worker.spec.ts
git commit -m "feat(worker): repassa trustBadge do job ao formatter"
```

---

### Task 4: Flag documentada + suite completa + smoke de boot real

**Files:**
- Modify: `.env.example` (perto de `COPY_AB_ENABLED`, linha ~175)

**Interfaces:**
- Consumes: tudo das Tasks 1-3.
- Produces: build deployável verificado.

- [ ] **Step 1: Documentar a flag em `.env.example`**

Logo abaixo de `COPY_AB_ENABLED=true` (linha ~175):

```bash
# Selo "menor preço em Xd ✓ monitorado há Nd" nos posts (calculado no enqueue).
# false = posts idênticos aos anteriores; não requer redeploy do Redis.
TRUST_BADGE_ENABLED=true
```

- [ ] **Step 2: Run the full suite**

Run: `npm test`
Expected: tudo verde (214 testes: 201 pré-existentes + 9 Task 1 + 3 Task 2 + 1 Task 3 — ajustar contagem se difere, o que importa é ZERO falha).

- [ ] **Step 3: Smoke de boot real (lição Fase 2 — unit test não pega crash-loop de DI)**

```bash
docker compose up -d --build app
```

Aguardar ~30s e verificar:

```bash
docker compose ps app
docker compose logs app --since 60s | grep -E "Nest application successfully started|ERROR"
```

Expected: status `healthy`, log contém `Nest application successfully started`, zero `ERROR` de DI/boot. WhatsApp reconecta sozinho (creds persistidas em `./auth_info`).

- [ ] **Step 4: Commit**

```bash
git add .env.example
git commit -m "docs(env): documenta TRUST_BADGE_ENABLED"
```
