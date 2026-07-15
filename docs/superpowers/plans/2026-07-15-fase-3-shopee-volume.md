# Fase 3 — Shopee + Volume por Canal + Digest WA — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Escalar o alcance do bot: headline migra para DeepSeek (LLM único), Telegram ganha teto próprio de publicação, WhatsApp agrupa ofertas em digest, e Shopee entra como segunda fonte via `DealSourcePort`.

**Architecture:** Tudo se encaixa nas portas existentes: `HeadlineGenerator` ganha adapter DeepSeek; `PipelineService.enqueueScored` passa a cortar por canal e a agrupar jobs WA em digest; `SendDealWorker` processa o novo job `send-digest`; `ShopeeSource` implementa `DealSourcePort` registrado condicionalmente no `SOURCES_TOKEN`; `CurationGateService` ganha warmup por fonte (`source_warmup`).

**Tech Stack:** NestJS 11, TypeScript, Prisma/Postgres, BullMQ/Redis, Jest, fetch nativo (Node 22), `node:crypto` (SHA256 Shopee).

**Spec:** `docs/superpowers/specs/2026-07-15-fase-3-shopee-volume-design.md`

## Global Constraints

- LLM: **só DeepSeek** (`DEEPSEEK_API_KEY`); sem chave → fallback noop. Nunca Groq.
- Sem dependência npm nova — fetch nativo e `node:crypto` bastam.
- Migrations: aditivas, hand-authored (padrão do commit `add-target-channel`), validadas com `npx prisma validate`.
- DI: factory providers com tokens `Symbol` (padrão do repo).
- Copies/logs de usuário em pt-BR; código e comentários seguem estilo do arquivo vizinho.
- Env defaults: `MAX_DEALS_PER_RUN_WA=4`, `MAX_DEALS_PER_RUN_TELEGRAM=10`, `WA_DIGEST_SIZE=4`, `JUDGE_MAX_CALLS_PER_TICK=20`, `SHOPEE_DISPATCH_ENABLED=false`.
- Rodar testes com `npx jest <pattern>`; lint com `npm run lint`; build com `npm run build`.
- Commits frequentes, mensagem conventional-commit em pt-BR (padrão do repo), rodapé `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Headline via DeepSeek (adeus Groq)

**Files:**
- Create: `src/headline/deepseek-headline.adapter.ts`
- Create: `src/headline/deepseek-headline.adapter.spec.ts`
- Modify: `src/headline/headline.module.ts`
- Delete: `src/headline/groq-headline.adapter.ts`
- Modify: `.env.example:76-84`

**Interfaces:**
- Consumes: `HeadlineGenerator` (`src/headline/headline.port.ts` — `generate(item: DealItem): Promise<string>`), `HeadlineCacheService`, `NoopHeadlineAdapter`, frames de `headline-frames.ts`.
- Produces: classe `DeepSeekHeadlineAdapter implements HeadlineGenerator`, registrada na factory de `HEADLINE_GENERATOR` quando `HEADLINE_PROVIDER=deepseek` (novo default) e `DEEPSEEK_API_KEY` presente.

- [ ] **Step 1: Write the failing test**

`src/headline/deepseek-headline.adapter.spec.ts`:

```typescript
import type { DealItem } from '../mercado-livre/types';
import { DeepSeekHeadlineAdapter } from './deepseek-headline.adapter';

function makeItem(): DealItem {
  return {
    catalogId: 'MLB1',
    itemId: 'MLB1',
    title: 'Produto X',
    thumbnail: '',
    price: 89.9,
    originalPrice: 149.9,
    sellerId: 0,
    freeShipping: false,
    permalink: 'https://ml/p',
    discountPercent: 40,
  };
}

function makeDeps(env: Record<string, string>) {
  const config = {
    get: (k: string) => env[k],
  } as any;
  const cache = { get: jest.fn(() => null), set: jest.fn() } as any;
  const fallback = { generate: jest.fn(async () => 'STATIC HOOK 🔥🔥') } as any;
  return { config, cache, fallback };
}

function okResponse(content: string) {
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
  } as any;
}

describe('DeepSeekHeadlineAdapter', () => {
  afterEach(() => jest.restoreAllMocks());

  it('returns sanitized headline and caches it', async () => {
    const d = makeDeps({ DEEPSEEK_API_KEY: 'k' });
    global.fetch = jest
      .fn()
      .mockResolvedValue(okResponse('"CORRE QUE TA BARATO 🔥🔥"'));
    const adapter = new DeepSeekHeadlineAdapter(d.config, d.cache, d.fallback);

    const out = await adapter.generate(makeItem());

    expect(out).toBe('CORRE QUE TA BARATO 🔥🔥');
    expect(d.cache.set).toHaveBeenCalledWith('MLB1', 'CORRE QUE TA BARATO 🔥🔥');
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://api.deepseek.com/chat/completions');
    expect(JSON.parse(init.body).model).toBe('deepseek-chat');
  });

  it('falls back to static pool on HTTP error', async () => {
    const d = makeDeps({ DEEPSEEK_API_KEY: 'k' });
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' });
    const adapter = new DeepSeekHeadlineAdapter(d.config, d.cache, d.fallback);

    const out = await adapter.generate(makeItem());

    expect(out).toBe('STATIC HOOK 🔥🔥');
    expect(d.fallback.generate).toHaveBeenCalled();
  });

  it('falls back without calling fetch when key is missing', async () => {
    const d = makeDeps({});
    global.fetch = jest.fn();
    const adapter = new DeepSeekHeadlineAdapter(d.config, d.cache, d.fallback);

    const out = await adapter.generate(makeItem());

    expect(out).toBe('STATIC HOOK 🔥🔥');
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest deepseek-headline -v 2>&1 | tail -20`
Expected: FAIL — `Cannot find module './deepseek-headline.adapter'`

- [ ] **Step 3: Write the adapter**

`src/headline/deepseek-headline.adapter.ts` — mesmo comportamento do adapter Groq que sai (frames, sanitize, forbidden words, retry único, cache, fallback), trocando só credencial/endpoint/modelo:

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { DealItem } from '../mercado-livre/types';
import { HeadlineCacheService } from './headline-cache.service';
import { HEADLINE_FRAMES, HeadlineFrame, pickFrame } from './headline-frames';
import { HeadlineGenerator } from './headline.port';
import { NoopHeadlineAdapter } from './noop-headline.adapter';

interface ChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
}

const FORBIDDEN_WORDS = [
  'OFERTA',
  'OFERTÃO',
  'PROMOÇÃO',
  'IMPERDÍVEL',
  'IMPERDIVEL',
  'DESCONTÃO',
  'DESCONTAO',
  'ALERTA',
];

@Injectable()
export class DeepSeekHeadlineAdapter implements HeadlineGenerator {
  private readonly logger = new Logger(DeepSeekHeadlineAdapter.name);
  private readonly apiKey: string;
  private readonly model: string;
  private readonly endpoint: string;
  private readonly temperature: number;
  private readonly topP: number;
  private readonly presencePenalty: number;
  private readonly frequencyPenalty: number;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;

  constructor(
    private readonly config: ConfigService,
    private readonly cache: HeadlineCacheService,
    private readonly fallback: NoopHeadlineAdapter,
  ) {
    this.apiKey = this.config.get<string>('DEEPSEEK_API_KEY') ?? '';
    this.model = this.config.get<string>('HEADLINE_MODEL') ?? 'deepseek-chat';
    this.endpoint =
      this.config.get<string>('DEEPSEEK_ENDPOINT') ??
      'https://api.deepseek.com/chat/completions';
    this.temperature = Number(
      this.config.get<string>('HEADLINE_TEMPERATURE') ?? '1.0',
    );
    this.topP = Number(this.config.get<string>('HEADLINE_TOP_P') ?? '0.95');
    this.presencePenalty = Number(
      this.config.get<string>('HEADLINE_PRESENCE_PENALTY') ?? '0.6',
    );
    this.frequencyPenalty = Number(
      this.config.get<string>('HEADLINE_FREQUENCY_PENALTY') ?? '0.5',
    );
    this.maxTokens = Number(
      this.config.get<string>('HEADLINE_MAX_TOKENS') ?? '80',
    );
    this.timeoutMs = Number(
      this.config.get<string>('HEADLINE_TIMEOUT_MS') ?? '8000',
    );
  }

  async generate(item: DealItem): Promise<string> {
    const cached = this.cache.get(item.catalogId);
    if (cached) return cached;

    if (!this.apiKey) {
      this.logger.warn('DEEPSEEK_API_KEY missing — using static hook pool');
      return this.fallback.generate(item);
    }

    const frame = pickFrame();
    try {
      const headline = await this.callDeepSeek(item, frame);
      let clean = this.sanitize(headline);
      if (!clean) throw new Error('empty headline');
      if (this.hasForbiddenWord(clean)) {
        this.logger.warn(
          `headline contained forbidden word, retrying once: "${clean}"`,
        );
        const retry = await this.callDeepSeek(item, frame);
        clean = this.sanitize(retry);
      }
      if (!clean) throw new Error('empty headline after retry');
      await this.cache.set(item.catalogId, clean);
      return clean;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`DeepSeek failed (${msg}) — using static hook pool`);
      return this.fallback.generate(item);
    }
  }

  private async callDeepSeek(
    item: DealItem,
    frame: HeadlineFrame,
  ): Promise<string> {
    const userPrompt = this.buildPrompt(item, frame);

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
            { role: 'user', content: userPrompt },
          ],
          temperature: this.temperature,
          top_p: this.topP,
          presence_penalty: this.presencePenalty,
          frequency_penalty: this.frequencyPenalty,
          max_tokens: this.maxTokens,
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
    return content;
  }

  private systemPrompt(): string {
    return [
      'Você é admin veterano de um grupo de WhatsApp de ofertas no Brasil.',
      'Idade ~30, fala como cria da quebrada/zona norte de SP: gíria,',
      'humor seco, intimidade com a galera. NÃO é vendedor corporativo.',
      'NÃO usa palavras de marketing chato como "OFERTA", "OFERTÃO",',
      '"PROMOÇÃO", "IMPERDÍVEL", "DESCONTÃO", "ALERTA".',
      'Cada hook que escreve soa como mensagem real de um amigo zoando.',
      'Resposta SEMPRE em uma linha só, CAPS LOCK, com 2-3 emojis no fim.',
    ].join(' ');
  }

  private buildPrompt(item: DealItem, frame: HeadlineFrame): string {
    const priceBRL = item.price.toLocaleString('pt-BR', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    });
    const originalBRL = item.originalPrice.toLocaleString('pt-BR', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    });
    const totalFrames = HEADLINE_FRAMES.length;
    const otherFrames = HEADLINE_FRAMES.filter((f) => f.name !== frame.name)
      .map((f) => f.name)
      .join(', ');

    return [
      'TAREFA: criar UMA frase de chamada (hook) pra anunciar esse produto',
      'num grupo de WhatsApp. Vai aparecer ANTES do bloco de preço/link,',
      'então NÃO repita preço/link/cupom — só vibra.',
      '',
      `PRODUTO: ${item.title}`,
      `PREÇO ATUAL: R$ ${priceBRL}`,
      `PREÇO ANTIGO: R$ ${originalBRL}`,
      `DESCONTO: ${item.discountPercent}% OFF`,
      '',
      `ESTILO OBRIGATÓRIO (1 de ${totalFrames}): ${frame.name}`,
      `Descrição do estilo: ${frame.guide}`,
      '',
      'Exemplos APENAS desse estilo (siga exatamente essa estrutura):',
      ...frame.examples.map((e) => `- ${e}`),
      '',
      'RESTRIÇÕES:',
      `- USE o estilo "${frame.name}". NÃO use os outros estilos (${otherFrames}).`,
      '- TUDO em CAPS LOCK.',
      '- Termina com 2 ou 3 emojis (😍 / 🔥 / 😱 / 💸 / 🤯 / 💪 / 👀 / ☕ / 🥩 / 🎧 / 📱 etc).',
      '- 4 a 12 palavras. Máximo 70 caracteres.',
      '- NÃO escreva: OFERTA, OFERTÃO, PROMOÇÃO, IMPERDÍVEL, DESCONTÃO, ALERTA.',
      '- NÃO use aspas, hashtag (#), link, markdown (* ou ~), nem dois-pontos no começo.',
      '- NÃO inclua preço nem cupom dentro do hook (a não ser que o estilo seja PRECO_CONTO).',
      '- NÃO copie o título inteiro do produto. Resume na vibe.',
      '- Refira-se ao produto pela categoria/uso, não pela marca completa.',
      '',
      'Devolve APENAS a frase. Sem prefixo, sem aspas, sem explicação.',
    ].join('\n');
  }

  private sanitize(raw: string): string {
    let s = raw.trim();
    s = s.replace(/^["'`]+|["'`]+$/g, '').trim();
    s = s.replace(/^[-*•]\s*/, '').trim();
    s = s.replace(/^(headline|hook|frase|resposta)\s*:\s*/i, '').trim();
    s = s.split('\n')[0].trim();
    if (s.length > 100) s = s.slice(0, 100).trim();
    return s;
  }

  private hasForbiddenWord(s: string): boolean {
    const upper = s.toUpperCase();
    return FORBIDDEN_WORDS.some((w) => upper.includes(w));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest deepseek-headline -v 2>&1 | tail -10`
Expected: PASS (3 tests)

- [ ] **Step 5: Swap the module factory and delete the Groq adapter**

`src/headline/headline.module.ts` — substituir o conteúdo inteiro:

```typescript
import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HeadlineCacheService } from './headline-cache.service';
import { HEADLINE_GENERATOR } from './headline.port';
import type { HeadlineGenerator } from './headline.port';
import { DeepSeekHeadlineAdapter } from './deepseek-headline.adapter';
import { NoopHeadlineAdapter } from './noop-headline.adapter';

@Module({
  providers: [
    HeadlineCacheService,
    NoopHeadlineAdapter,
    DeepSeekHeadlineAdapter,
    {
      provide: HEADLINE_GENERATOR,
      inject: [ConfigService, NoopHeadlineAdapter, DeepSeekHeadlineAdapter],
      useFactory: (
        config: ConfigService,
        noop: NoopHeadlineAdapter,
        deepseek: DeepSeekHeadlineAdapter,
      ): HeadlineGenerator => {
        const provider = (
          config.get<string>('HEADLINE_PROVIDER', 'deepseek') ?? 'deepseek'
        )
          .toLowerCase()
          .trim();
        const logger = new Logger('HeadlineModule');
        if (provider === 'noop') {
          logger.log('Headline provider: noop (static hook pool)');
          return noop;
        }
        if (provider === 'deepseek') {
          if (!config.get<string>('DEEPSEEK_API_KEY')) {
            logger.warn(
              'HEADLINE_PROVIDER=deepseek but DEEPSEEK_API_KEY missing — falling back to noop',
            );
            return noop;
          }
          logger.log('Headline provider: deepseek');
          return deepseek;
        }
        logger.warn(
          `Unknown HEADLINE_PROVIDER=${provider} — falling back to noop`,
        );
        return noop;
      },
    },
  ],
  exports: [HEADLINE_GENERATOR],
})
export class HeadlineModule {}
```

Depois: `git rm src/headline/groq-headline.adapter.ts`

- [ ] **Step 6: Update `.env.example`**

Substituir o bloco headline (linhas 76-84) por:

```
# HEADLINE_PROVIDER: 'deepseek' (default) or 'noop' (static hook pool, no API key).
# Falls back to noop automatically when DEEPSEEK_API_KEY is missing.
# Uses the same DEEPSEEK_API_KEY as the curation judge — one LLM provider.
HEADLINE_PROVIDER=deepseek
HEADLINE_MODEL=deepseek-chat
HEADLINE_TEMPERATURE=0.9
HEADLINE_MAX_TOKENS=60
HEADLINE_TIMEOUT_MS=8000
HEADLINE_CACHE_PATH=./data/headlines.json
HEADLINE_CACHE_DAYS=30
```

(remove `GROQ_API_KEY`; `HEADLINE_MODEL` agora nomeia o modelo DeepSeek.)

- [ ] **Step 7: Full check**

Run: `npx jest src/headline && npm run build 2>&1 | tail -5`
Expected: PASS em todos os specs de headline; build sem erro (se algo ainda importar `groq-headline.adapter`, o build acusa — corrigir o import para o novo adapter).

- [ ] **Step 8: Commit**

```bash
git add -A src/headline .env.example
git commit -m "feat(headline): migra headline de Groq para DeepSeek (LLM unico)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Teto de publicação por canal

**Files:**
- Modify: `src/pipeline/pipeline.service.ts:139-243` (`enqueueScored`, `runOnce`)
- Modify: `src/scheduler/scheduler.service.ts:74-136` (`tickBatch`, `tickLegacy`)
- Modify: `src/curation/curation-gate.service.ts:56` (default do judge budget)
- Modify: `src/pipeline/pipeline.service.spec.ts`
- Modify: `.env.example:95`

**Interfaces:**
- Consumes: `CurationGateService.selectForDispatch(scored, max)` (inalterado — devolve aprovados ordenados por score desc), `TargetsService.getActiveTargets()` (targets com `channel: 'wa' | 'telegram'`).
- Produces: `enqueueScored(scored: ScoredDeal[], overrideMax?: number)` — segundo parâmetro agora é override opcional que vale para os dois canais (usado por `runOnce` manual); sem ele, lê `MAX_DEALS_PER_RUN_WA` (default 4) e `MAX_DEALS_PER_RUN_TELEGRAM` (default 10). Task 4 depende dessa assinatura.

- [ ] **Step 1: Write the failing test**

Adicionar ao `describe('PipelineService.enqueueScored', ...)` em `src/pipeline/pipeline.service.spec.ts` (usa `makeDeps`, `scoredFixture`, `enrichedFor`, `rawFor` já existentes no arquivo):

```typescript
  it('applies per-channel caps: telegram receives more deals than wa', async () => {
    const d = makeDeps({ rawDeals: [] });
    d.targets.getActiveTargets.mockResolvedValue([
      { jid: '123@g.us', name: 'g', active: true, channel: 'wa' },
      { jid: '-100555', name: 'tg', active: true, channel: 'telegram' },
    ]);
    (d.pipeline as any).config = {
      get: (k: string, def?: string) => {
        if (k === 'MAX_DEALS_PER_RUN_WA') return '1';
        if (k === 'MAX_DEALS_PER_RUN_TELEGRAM') return '3';
        if (k === 'WA_DIGEST_SIZE') return '1';
        return def;
      },
    };
    const scored = [90, 85, 80].map((s, i) => ({
      ...scoredFixture(),
      score: s,
      deal: enrichedFor(rawFor(`MLB${i + 1}`)),
    }));

    const result = await d.pipeline.enqueueScored(scored);

    const calls = (d.sendQueue.add as jest.Mock).mock.calls;
    const waJobs = calls.filter(([, data]) => data.channel === 'wa');
    const tgJobs = calls.filter(([, data]) => data.channel === 'telegram');
    expect(waJobs).toHaveLength(1);
    expect(tgJobs).toHaveLength(3);
    expect(result.enqueued).toBe(4);
    expect(d.gate.selectForDispatch).toHaveBeenCalledWith(
      expect.anything(),
      3, // max(waCap=1, tgCap=3)
    );
  });
```

(`WA_DIGEST_SIZE=1` no fake mantém o teste válido após a Task 4.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest pipeline.service -t "per-channel caps" -v 2>&1 | tail -15`
Expected: FAIL — hoje `enqueueScored` exige `max` numérico e manda o mesmo set pra todos os targets (waJobs=3).

- [ ] **Step 3: Implement per-channel caps**

Em `src/pipeline/pipeline.service.ts`, substituir `enqueueScored` inteiro por:

```typescript
  /**
   * Enqueue approved deals per active target, honoring a per-channel cap:
   * MAX_DEALS_PER_RUN_WA for 'wa' targets, MAX_DEALS_PER_RUN_TELEGRAM for
   * 'telegram' targets. `overrideMax` (manual /pipeline/run) caps both.
   * The gate returns deals sorted by score desc, so slicing by index keeps
   * the best deals on every channel.
   *
   * Falls back to `WA_TARGET_JID` when the TargetsService registry is empty
   * so single-target installs keep working without DB seeding.
   */
  async enqueueScored(
    scored: ScoredDeal[],
    overrideMax?: number,
  ): Promise<{
    enqueued: number;
    targets: number;
    topScore: number | null;
  }> {
    const num = (k: string, def: number) =>
      Number(this.config.get<string>(k, String(def)));
    const waCap = overrideMax ?? num('MAX_DEALS_PER_RUN_WA', 4);
    const tgCap = overrideMax ?? num('MAX_DEALS_PER_RUN_TELEGRAM', 10);

    const selected = await this.gate.selectForDispatch(
      scored,
      Math.max(waCap, tgCap),
    );
    if (selected.length === 0) {
      return { enqueued: 0, targets: 0, topScore: null };
    }

    let activeTargets = await this.targets.getActiveTargets();
    if (activeTargets.length === 0) {
      const fallback = this.config.get<string>('WA_TARGET_JID', '');
      if (fallback) {
        activeTargets = [
          {
            jid: fallback,
            name: 'env:WA_TARGET_JID',
            active: true,
            channel: 'wa',
          },
        ];
      }
    }
    if (activeTargets.length === 0) {
      throw new Error(
        'No active targets and WA_TARGET_JID unset — nothing to publish',
      );
    }

    let enqueued = 0;
    const topScore = selected[0]?.scored.score ?? null;
    for (let i = 0; i < selected.length; i++) {
      const { scored: sd, variant } = selected[i];
      const catalogKey = keyToString(sd.deal.key);
      let dealEnqueued = false;
      for (const target of activeTargets) {
        const cap = target.channel === 'telegram' ? tgCap : waCap;
        if (i >= cap) continue;
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

    this.logger.log(
      `enqueueScored: deals=${selected.length} targets=${activeTargets.length} enqueued=${enqueued}`,
    );
    return { enqueued, targets: activeTargets.length, topScore };
  }
```

E em `runOnce`, trocar:

```typescript
    const max =
      opts?.max ?? Number(this.config.get<string>('MAX_DEALS_PER_RUN', '3'));

    const scored = await this.collectScored(sourceId);
    const result = await this.enqueueScored(scored, max);
```

por:

```typescript
    const scored = await this.collectScored(sourceId);
    const result = await this.enqueueScored(scored, opts?.max);
```

- [ ] **Step 4: Update the scheduler callers**

Em `src/scheduler/scheduler.service.ts`:

`tickBatch`: remover a linha `const maxDeals = Number(this.config.get<string>('MAX_DEALS_PER_RUN', '3'));` e trocar `await this.pipeline.enqueueScored(allScored, maxDeals);` por `await this.pipeline.enqueueScored(allScored);`

`tickLegacy`: mesma coisa — remover `const maxDeals = ...` e usar `await this.pipeline.enqueueScored(scored);`

- [ ] **Step 5: Raise the judge budget default**

Em `src/curation/curation-gate.service.ts:56`, trocar:

```typescript
    this.maxJudgeCallsPerTick = num('JUDGE_MAX_CALLS_PER_TICK', 10);
```

por:

```typescript
    this.maxJudgeCallsPerTick = num('JUDGE_MAX_CALLS_PER_TICK', 20);
```

- [ ] **Step 6: Update `.env.example`**

Trocar a linha `MAX_DEALS_PER_RUN=3` por:

```
# Per-channel dispatch caps (deals per tick). WA counts OFFERS, not messages —
# with WA_DIGEST_SIZE>1 they are grouped into a single digest message.
MAX_DEALS_PER_RUN_WA=4
MAX_DEALS_PER_RUN_TELEGRAM=10
```

E onde estiver `JUDGE_MAX_CALLS_PER_TICK` (se listado), atualizar para `JUDGE_MAX_CALLS_PER_TICK=20`; se não listado, adicionar abaixo de `DEEPSEEK_TIMEOUT_MS`.

- [ ] **Step 7: Run the affected suites**

Run: `npx jest pipeline.service scheduler curation-gate -v 2>&1 | tail -20`
Expected: PASS. Os testes antigos de `enqueueScored(x, 3)` seguem passando (override cobre os dois canais). Se o spec do scheduler mockar `enqueueScored` com 2 args, ajustar a expectativa para 1 arg.

- [ ] **Step 8: Commit**

```bash
git add src/pipeline src/scheduler src/curation .env.example
git commit -m "feat(pipeline): teto de publicacao por canal (wa/telegram) + juiz 20/tick

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: FormatterService.formatDigest

**Files:**
- Modify: `src/pipeline/formatter.service.ts`
- Create: `src/pipeline/formatter-digest.spec.ts`

**Interfaces:**
- Consumes: `AffiliateLinkPort.resolve(url)`, `ScoredDeal`, `CopyVariant`, `formatBRL`/`toHiResImage`/`disclaimerLine` já existentes no serviço.
- Produces: `formatDigest(entries: Array<{ scored: ScoredDeal; variant: CopyVariant }>): Promise<{ caption: string; imageUrl: string }>` — Task 4 (worker) chama exatamente essa assinatura. Também introduz o helper privado `resolveLink(raw: RawDeal): Promise<string>` que a Task 7 torna source-aware.

- [ ] **Step 1: Write the failing test**

`src/pipeline/formatter-digest.spec.ts`:

```typescript
import { FormatterService } from './formatter.service';
import type { ScoredDeal } from '../deal-score/types';

function makeScored(
  id: string,
  level: 'good' | 'top' | 'super',
  priceCents = 8990,
): ScoredDeal {
  return {
    deal: {
      key: { source: 'ml', externalId: id },
      source: 'ml',
      raw: {
        key: { source: 'ml', externalId: id },
        title: `Produto ${id}`,
        priceCents,
        originalPriceCents: priceCents * 2,
        discountPercent: 50,
        thumbnail: 'https://t/-I.jpg',
        permalink: `https://ml/${id}`,
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

function makeFormatter() {
  const affiliate = {
    resolve: jest.fn(async (u: string) => `aff:${u}`),
  };
  const headline = { generate: jest.fn(async () => 'HOOK 🔥') };
  return {
    formatter: new FormatterService(affiliate as any, headline as any),
    affiliate,
  };
}

describe('FormatterService.formatDigest', () => {
  it('renders one block per deal, links resolved, single disclaimer', async () => {
    const { formatter, affiliate } = makeFormatter();
    const entries = [
      { scored: makeScored('MLB1', 'super'), variant: 'A' as const },
      { scored: makeScored('MLB2', 'top'), variant: 'B' as const },
      { scored: makeScored('MLB3', 'good'), variant: 'A' as const },
    ];

    const { caption, imageUrl } = await formatter.formatDigest(entries);

    expect(caption).toContain('3 ACHADOS');
    expect(caption).toContain('Produto MLB1');
    expect(caption).toContain('Produto MLB2');
    expect(caption).toContain('Produto MLB3');
    expect(caption).toContain('aff:https://ml/MLB1');
    expect(caption).toContain('aff:https://ml/MLB3');
    expect(affiliate.resolve).toHaveBeenCalledTimes(3);
    // disclaimer única, no fim
    expect(caption.match(/Link de afiliado/g)).toHaveLength(1);
    // imagem = oferta top (primeira da lista, gate já ordena por score)
    expect(imageUrl).toBe('https://t/-F.jpg');
  });

  it('variant B block uses De/Por anchor; variant A does not', async () => {
    const { formatter } = makeFormatter();
    const { caption } = await formatter.formatDigest([
      { scored: makeScored('MLB1', 'top'), variant: 'B' as const },
      { scored: makeScored('MLB2', 'good'), variant: 'A' as const },
    ]);

    expect(caption).toContain('❌ De:');
    // bloco A: preço direto com 💰
    expect(caption).toContain('💰');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest formatter-digest -v 2>&1 | tail -15`
Expected: FAIL — `formatter.formatDigest is not a function`

- [ ] **Step 3: Implement formatDigest**

Em `src/pipeline/formatter.service.ts`:

1. Adicionar aos imports existentes:

```typescript
import type { RawDeal } from '../sources/source.port';
```

2. Trocar em `formatScored` a linha `this.affiliate.resolve(raw.permalink),` por `this.resolveLink(raw),` (mesma coisa em substância; prepara a Task 7).

3. Adicionar os métodos:

```typescript
  /**
   * One WA message bundling several approved deals. Header + one compact
   * block per deal + single disclaimer. Image comes from the first entry
   * (gate returns deals sorted by score desc).
   */
  async formatDigest(
    entries: Array<{ scored: ScoredDeal; variant: CopyVariant }>,
  ): Promise<{ caption: string; imageUrl: string }> {
    if (entries.length === 0) {
      throw new Error('formatDigest requires at least one deal');
    }
    const links = await Promise.all(
      entries.map((e) => this.resolveLink(e.scored.deal.raw)),
    );
    const blocks = entries.map((e, i) =>
      this.digestBlock(e.scored, e.variant, links[i]),
    );
    const header = `🔥 ${entries.length} ACHADOS NUM POST SÓ`;
    const caption = [
      header,
      '',
      blocks.join('\n\n➖➖➖\n\n'),
      '',
      this.disclaimerLine(),
    ].join('\n');
    const imageUrl = this.toHiResImage(
      entries[0].scored.deal.raw.thumbnail || '',
    );
    return { caption, imageUrl };
  }

  private digestBlock(
    sd: ScoredDeal,
    variant: CopyVariant,
    link: string,
  ): string {
    const raw = sd.deal.raw;
    const emoji =
      sd.level === 'super' ? '🚨' : sd.level === 'top' ? '🔥' : '✅';
    const price = raw.priceCents / 100;
    const original =
      raw.originalPriceCents != null ? raw.originalPriceCents / 100 : null;
    const lines = [`${emoji} *${raw.title}*`];
    if (variant === 'B' && original != null && original > price) {
      lines.push(`❌ De: ~${this.formatBRL(original)}~`);
      lines.push(
        `✅ Por: *${this.formatBRL(price)}* (-${raw.discountPercent}%)`,
      );
    } else {
      lines.push(`💰 *${this.formatBRL(price)}* (-${raw.discountPercent}%)`);
    }
    if (sd.deal.signals.freeShipping) lines.push('🚚 Frete grátis');
    lines.push(`👉 ${link}`);
    return lines.join('\n');
  }

  private resolveLink(raw: RawDeal): Promise<string> {
    return this.affiliate.resolve(raw.permalink);
  }
```

- [ ] **Step 4: Run tests**

Run: `npx jest formatter -v 2>&1 | tail -10`
Expected: PASS — `formatter-digest`, `formatter-variant` e `formatter.service` todos verdes.

Nota: o spec da Fase 3 menciona "selo de preço monitorado" nos blocos do
digest — esse selo tem spec próprio ainda não implementado
(`2026-07-15-selo-preco-monitorado-design.md`). Quando o selo existir no
`formatScored`, adicionar a mesma linha em `digestBlock`. Fora deste plano.

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/formatter.service.ts src/pipeline/formatter-digest.spec.ts
git commit -m "feat(formatter): formatDigest - varias ofertas numa mensagem WA

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Digest de ponta a ponta — job, enqueue, worker, migration

**Files:**
- Modify: `src/queue/queue.types.ts`
- Modify: `src/pipeline/pipeline.service.ts` (`enqueueScored` — ramo digest)
- Modify: `src/worker/send-deal.worker.ts`
- Modify: `prisma/schema.prisma:52-61` (SentMessage)
- Create: `prisma/migrations/20260715180000_add_sent_message_digest_id/migration.sql`
- Modify: `src/pipeline/pipeline.service.spec.ts`
- Modify: `src/worker/send-deal.worker.spec.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `FormatterService.formatDigest(entries)` (Task 3), `enqueueScored(scored, overrideMax?)` com caps por canal (Task 2).
- Produces: job BullMQ `send-digest` com payload `SendDigestJob { targetJid, channel: 'wa', digestId: string, deals: DigestDealEntry[] }`; `DigestDealEntry { catalogKey: string, variant: 'A' | 'B', scored: ScoredDeal }`; coluna `SentMessage.digestId String?`.

- [ ] **Step 1: Add the job types**

Em `src/queue/queue.types.ts`, adicionar após `SendDealJob`:

```typescript
export interface DigestDealEntry {
  catalogKey: string;
  variant: 'A' | 'B';
  scored: ScoredDeal;
}

/** Several deals bundled into a single WA message (job name 'send-digest'). */
export interface SendDigestJob {
  targetJid: string;
  channel: 'wa';
  /** Groups the SentMessage audit rows of one digest. */
  digestId: string;
  deals: DigestDealEntry[];
}

export type SendJob = SendDealJob | SendDigestJob;
```

E atualizar os tipos genéricos: em `src/pipeline/pipeline.service.ts` trocar `Queue<SendDealJob>` por `Queue<SendJob>` (ajustar import para `import type { SendJob } from '../queue/queue.types';`); em `src/worker/send-deal.worker.ts` trocar `Worker<SendDealJob>` por `Worker<SendJob>` e o import correspondente.

- [ ] **Step 2: Write the failing pipeline test**

Em `src/pipeline/pipeline.service.spec.ts`, adicionar ao describe de `enqueueScored`:

```typescript
  it('bundles wa deals into a send-digest job; telegram stays 1 job per deal', async () => {
    const d = makeDeps({ rawDeals: [] });
    d.targets.getActiveTargets.mockResolvedValue([
      { jid: '123@g.us', name: 'g', active: true, channel: 'wa' },
      { jid: '-100555', name: 'tg', active: true, channel: 'telegram' },
    ]);
    (d.pipeline as any).config = {
      get: (k: string, def?: string) => {
        if (k === 'MAX_DEALS_PER_RUN_WA') return '3';
        if (k === 'MAX_DEALS_PER_RUN_TELEGRAM') return '3';
        if (k === 'WA_DIGEST_SIZE') return '4';
        return def;
      },
    };
    const scored = [90, 85, 80].map((s, i) => ({
      ...scoredFixture(),
      score: s,
      deal: enrichedFor(rawFor(`MLB${i + 1}`)),
    }));

    const result = await d.pipeline.enqueueScored(scored);

    const calls = (d.sendQueue.add as jest.Mock).mock.calls;
    const digestCalls = calls.filter(([name]) => name === 'send-digest');
    const dealCalls = calls.filter(([name]) => name === 'send-deal');
    expect(digestCalls).toHaveLength(1); // 3 deals num digest só p/ wa
    expect(digestCalls[0][1].deals).toHaveLength(3);
    expect(digestCalls[0][1].digestId).toEqual(expect.any(String));
    expect(dealCalls).toHaveLength(3); // telegram individual
    expect(result.enqueued).toBe(4);
    expect(d.gate.recordPosted).toHaveBeenCalledTimes(3);
  });

  it('keeps single wa deal as a plain send-deal job (no digest of one)', async () => {
    const d = makeDeps({ rawDeals: [] });
    d.targets.getActiveTargets.mockResolvedValue([
      { jid: '123@g.us', name: 'g', active: true, channel: 'wa' },
    ]);
    (d.pipeline as any).config = {
      get: (k: string, def?: string) =>
        k === 'WA_DIGEST_SIZE' ? '4' : def,
    };

    await d.pipeline.enqueueScored([scoredFixture()]);

    const calls = (d.sendQueue.add as jest.Mock).mock.calls;
    expect(calls[0][0]).toBe('send-deal');
  });
```

Run: `npx jest pipeline.service -t "digest" -v 2>&1 | tail -15`
Expected: FAIL — hoje só existe caminho `send-deal`.

- [ ] **Step 3: Implement the digest branch in enqueueScored**

Em `src/pipeline/pipeline.service.ts`, substituir o corpo de `enqueueScored` (a partir do cálculo dos caps, mantendo a resolução de `activeTargets` da Task 2) por:

```typescript
  async enqueueScored(
    scored: ScoredDeal[],
    overrideMax?: number,
  ): Promise<{
    enqueued: number;
    targets: number;
    topScore: number | null;
  }> {
    const num = (k: string, def: number) =>
      Number(this.config.get<string>(k, String(def)));
    const waCap = overrideMax ?? num('MAX_DEALS_PER_RUN_WA', 4);
    const tgCap = overrideMax ?? num('MAX_DEALS_PER_RUN_TELEGRAM', 10);
    const digestSize = Math.max(1, num('WA_DIGEST_SIZE', 4));

    const selected = await this.gate.selectForDispatch(
      scored,
      Math.max(waCap, tgCap),
    );
    if (selected.length === 0) {
      return { enqueued: 0, targets: 0, topScore: null };
    }

    let activeTargets = await this.targets.getActiveTargets();
    if (activeTargets.length === 0) {
      const fallback = this.config.get<string>('WA_TARGET_JID', '');
      if (fallback) {
        activeTargets = [
          {
            jid: fallback,
            name: 'env:WA_TARGET_JID',
            active: true,
            channel: 'wa',
          },
        ];
      }
    }
    if (activeTargets.length === 0) {
      throw new Error(
        'No active targets and WA_TARGET_JID unset — nothing to publish',
      );
    }

    const waTargets = activeTargets.filter((t) => t.channel !== 'telegram');
    const tgTargets = activeTargets.filter((t) => t.channel === 'telegram');

    let enqueued = 0;
    const topScore = selected[0]?.scored.score ?? null;
    // catalogKey -> deal aprovado + flag "chegou em alguma fila"
    const posted = new Map<
      string,
      { sd: ScoredDeal; variant: CopyVariant; sent: boolean }
    >();
    for (const { scored: sd, variant } of selected) {
      posted.set(keyToString(sd.deal.key), { sd, variant, sent: false });
    }

    const addSingle = async (
      sd: ScoredDeal,
      variant: CopyVariant,
      target: { jid: string; channel?: 'wa' | 'telegram' },
    ) => {
      const catalogKey = keyToString(sd.deal.key);
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
        posted.get(catalogKey)!.sent = true;
      } catch (err) {
        this.logger.error(`enqueue ${jobId} failed: ${(err as Error).message}`);
      }
    };

    // Telegram: 1 job por (deal × target), como sempre.
    for (const { scored: sd, variant } of selected.slice(0, tgCap)) {
      for (const target of tgTargets) await addSingle(sd, variant, target);
    }

    // WhatsApp: chunks de até WA_DIGEST_SIZE viram 1 mensagem; chunk de 1
    // continua job individual (digest de uma oferta não faz sentido).
    const waSelected = selected.slice(0, waCap);
    for (let c = 0; c < waSelected.length; c += digestSize) {
      const chunk = waSelected.slice(c, c + digestSize);
      if (chunk.length === 1) {
        for (const target of waTargets) {
          await addSingle(chunk[0].scored, chunk[0].variant, target);
        }
        continue;
      }
      const keys = chunk.map(({ scored: sd }) => keyToString(sd.deal.key));
      const digestId = `dg-${Date.now()}-${c / digestSize}`;
      for (const target of waTargets) {
        const jobId = `digest:${target.jid}:${keys.join('+')}`;
        try {
          await this.sendQueue.add(
            'send-digest',
            {
              targetJid: target.jid,
              channel: 'wa',
              digestId,
              deals: chunk.map(({ scored: sd, variant }) => ({
                catalogKey: keyToString(sd.deal.key),
                variant,
                scored: sd,
              })),
            },
            { jobId },
          );
          enqueued++;
          for (const k of keys) posted.get(k)!.sent = true;
        } catch (err) {
          this.logger.error(
            `enqueue ${jobId} failed: ${(err as Error).message}`,
          );
        }
      }
    }

    for (const { sd, variant, sent } of posted.values()) {
      if (sent) await this.gate.recordPosted(sd, variant);
    }

    this.logger.log(
      `enqueueScored: deals=${selected.length} targets=${activeTargets.length} enqueued=${enqueued}`,
    );
    return { enqueued, targets: activeTargets.length, topScore };
  }
```

Import novo no topo do arquivo: `import type { CopyVariant } from '../shared/variant';`

Run: `npx jest pipeline.service -v 2>&1 | tail -15`
Expected: PASS (inclusive os testes antigos — deal único em WA continua `send-deal`).

- [ ] **Step 4: Write the failing worker test**

Em `src/worker/send-deal.worker.spec.ts`: no `makeDeps`, adicionar ao objeto `formatter`:

```typescript
    formatDigest: jest
      .fn()
      .mockResolvedValue({ caption: 'digest-cap', imageUrl: 'https://img' }),
```

E adicionar o describe:

```typescript
function makeDigestJob() {
  return {
    id: 'digest:123@g.us:ml:MLB1+ml:MLB2',
    name: 'send-digest',
    data: {
      targetJid: '123@g.us',
      channel: 'wa',
      digestId: 'dg-1',
      deals: [
        {
          catalogKey: 'ml:MLB1',
          variant: 'A',
          scored: {
            deal: { key: { source: 'ml', externalId: 'MLB1' }, raw: {} },
            score: 90,
            level: 'top',
          },
        },
        {
          catalogKey: 'ml:MLB2',
          variant: 'B',
          scored: {
            deal: { key: { source: 'ml', externalId: 'MLB2' }, raw: {} },
            score: 85,
            level: 'good',
          },
        },
      ],
    },
  } as any;
}

describe('SendDealWorker.process (send-digest)', () => {
  it('publishes one message and audits every deal with the digestId', async () => {
    const d = makeDeps();
    const worker = makeWorker(d);

    await (worker as any).process(makeDigestJob());

    expect(d.publisher.publish).toHaveBeenCalledTimes(1);
    expect(d.publisher.publish).toHaveBeenCalledWith(
      { caption: 'digest-cap', imageUrl: 'https://img' },
      '123@g.us',
    );
    expect(d.dedup.markPosted).toHaveBeenCalledWith('ml:MLB1');
    expect(d.dedup.markPosted).toHaveBeenCalledWith('ml:MLB2');
    expect(d.prisma.sentMessage.create).toHaveBeenCalledTimes(2);
    expect(d.prisma.sentMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        catalogId: 'ml:MLB1',
        targetJid: '123@g.us',
        variant: 'A',
        digestId: 'dg-1',
      }),
    });
  });
});
```

Run: `npx jest send-deal.worker -t "digest" -v 2>&1 | tail -15`
Expected: FAIL — `process` ainda trata todo job como single.

- [ ] **Step 5: Implement the worker branch**

Em `src/worker/send-deal.worker.ts`:

1. Ajustar import: `import { SEND_DEAL_QUEUE, SendDealJob, SendDigestJob, SendJob } from '../queue/queue.types';`
2. Renomear o método atual `process` para `processSingle` (tipo do parâmetro vira `Job<SendDealJob>`) e criar o roteador + o novo método:

```typescript
  private async process(job: Job<SendJob>): Promise<void> {
    if (job.name === 'send-digest') {
      return this.processDigest(job as Job<SendDigestJob>);
    }
    return this.processSingle(job as Job<SendDealJob>);
  }

  private async processDigest(job: Job<SendDigestJob>): Promise<void> {
    const { targetJid, deals, digestId } = job.data;

    const publisher = this.publishers.get('wa');
    const { caption, imageUrl } = await this.formatter.formatDigest(
      deals.map((d) => ({ scored: d.scored, variant: d.variant })),
    );
    await publisher.publish({ caption, imageUrl }, targetJid);

    for (const d of deals) {
      await this.dedup.markPosted(d.catalogKey);
      try {
        await (this.prisma as any).sentMessage.create({
          data: {
            catalogId: d.catalogKey,
            targetJid,
            caption,
            variant: d.variant,
            digestId,
          },
        });
      } catch (err) {
        // Audit row must never fail a job that already published.
        this.logger.warn(
          `sentMessage audit insert failed: ${(err as Error).message}`,
        );
      }
    }
    this.logger.log(
      `send-digest job ${job.id} ok (${deals.length} deals -> ${targetJid})`,
    );
  }
```

(O corpo antigo vira `processSingle` sem mudança de lógica; o `new Worker<SendJob>` no `onModuleInit` continua chamando `this.process(job)`.)

Run: `npx jest send-deal.worker -v 2>&1 | tail -10`
Expected: PASS (todos, incluindo os antigos).

- [ ] **Step 6: Schema + migration for digestId**

Em `prisma/schema.prisma`, no model `SentMessage`, adicionar após `variant   String?`:

```prisma
  digestId  String?
```

Criar `prisma/migrations/20260715180000_add_sent_message_digest_id/migration.sql`:

```sql
-- Fase 3: agrupa as linhas de auditoria de um mesmo digest WA.
ALTER TABLE "SentMessage" ADD COLUMN "digestId" TEXT;
```

Run: `npx prisma validate && npx prisma generate 2>&1 | tail -3`
Expected: `The schema ... is valid` e client regenerado. (Com o Postgres local de docker-compose de pé, aplicar com `npx prisma migrate deploy`.)

- [ ] **Step 7: Update `.env.example`**

Adicionar abaixo do bloco `MAX_DEALS_PER_RUN_*` da Task 2:

```
# Deals per WA message. >1 groups the tick's approved deals into one digest
# message (fewer messages, same offers). 1 = legacy one-message-per-deal.
WA_DIGEST_SIZE=4
```

- [ ] **Step 8: Full check + commit**

Run: `npx jest src/pipeline src/worker src/queue && npm run build 2>&1 | tail -5`
Expected: PASS + build limpo.

```bash
git add src/queue src/pipeline src/worker prisma .env.example
git commit -m "feat(digest): job send-digest - varias ofertas numa mensagem WA

Mesmos envios/dia, mais ofertas. SentMessage.digestId agrupa a auditoria.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Shopee — client assinado + mapping

**Files:**
- Modify: `src/sources/source.port.ts:3`
- Create: `src/sources/shopee/shopee-client.ts`
- Create: `src/sources/shopee/shopee-client.spec.ts`
- Create: `src/sources/shopee/mapping.ts`
- Create: `src/sources/shopee/mapping.spec.ts`

**Interfaces:**
- Consumes: `RawDeal`, `EnrichedDeal`, `NormalizedSeller` de `src/sources/source.port.ts`.
- Produces: `SourceId = 'ml' | 'shopee'`; `ShopeeClient.query<T>(req): Promise<T>` e `ShopeeClient.sign(timestamp, payload): string`; `ShopeeOfferNode`; `toRawDeal(node, feedId): RawDeal`; `toEnrichedDeal(raw, node): EnrichedDeal`. Task 6 consome tudo isso.

- [ ] **Step 1: Widen SourceId**

Em `src/sources/source.port.ts:3`:

```typescript
export type SourceId = 'ml' | 'shopee';
```

Run: `npm run build 2>&1 | tail -3` — Expected: sem erro (união só amplia).

- [ ] **Step 2: Write the failing client test**

`src/sources/shopee/shopee-client.spec.ts`:

```typescript
import { createHash } from 'node:crypto';
import { ShopeeClient } from './shopee-client';

function makeConfig(env: Record<string, string>) {
  return { get: (k: string) => env[k] } as any;
}

describe('ShopeeClient', () => {
  afterEach(() => jest.restoreAllMocks());

  it('signs with sha256(appId + timestamp + payload + secret)', () => {
    const client = new ShopeeClient(
      makeConfig({ SHOPEE_APP_ID: 'app1', SHOPEE_APP_SECRET: 'sec1' }),
    );
    const expected = createHash('sha256')
      .update('app1' + '1752580800' + '{"query":"q"}' + 'sec1')
      .digest('hex');
    expect(client.sign(1752580800, '{"query":"q"}')).toBe(expected);
  });

  it('sends Authorization header and returns data', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { productOfferV2: { nodes: [] } } }),
    });
    const client = new ShopeeClient(
      makeConfig({ SHOPEE_APP_ID: 'app1', SHOPEE_APP_SECRET: 'sec1' }),
    );

    const out = await client.query<{ productOfferV2: { nodes: unknown[] } }>({
      query: 'q',
    });

    expect(out.productOfferV2.nodes).toEqual([]);
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://open-api.affiliate.shopee.com.br/graphql');
    expect(init.headers.Authorization).toMatch(
      /^SHA256 Credential=app1, Timestamp=\d+, Signature=[0-9a-f]{64}$/,
    );
  });

  it('throws on graphql errors payload', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ errors: [{ message: 'invalid signature' }] }),
    });
    const client = new ShopeeClient(
      makeConfig({ SHOPEE_APP_ID: 'app1', SHOPEE_APP_SECRET: 'sec1' }),
    );

    await expect(client.query({ query: 'q' })).rejects.toThrow(
      /invalid signature/,
    );
  });
});
```

Run: `npx jest shopee-client -v 2>&1 | tail -10`
Expected: FAIL — módulo não existe.

- [ ] **Step 3: Implement the client**

`src/sources/shopee/shopee-client.ts`:

```typescript
import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface ShopeeGraphQLRequest {
  query: string;
  variables?: Record<string, unknown>;
}

/**
 * Cliente da API GraphQL de afiliados da Shopee BR. Autenticação por
 * assinatura: SHA256(appId + timestamp + payload + secret) em hex, enviada
 * no header Authorization junto com Credential e Timestamp (segundos).
 */
@Injectable()
export class ShopeeClient {
  private readonly appId: string;
  private readonly secret: string;
  private readonly endpoint: string;
  private readonly timeoutMs: number;

  constructor(private readonly config: ConfigService) {
    this.appId = this.config.get<string>('SHOPEE_APP_ID') ?? '';
    this.secret = this.config.get<string>('SHOPEE_APP_SECRET') ?? '';
    this.endpoint =
      this.config.get<string>('SHOPEE_ENDPOINT') ??
      'https://open-api.affiliate.shopee.com.br/graphql';
    this.timeoutMs = Number(
      this.config.get<string>('SHOPEE_TIMEOUT_MS') ?? '8000',
    );
  }

  sign(timestamp: number, payload: string): string {
    return createHash('sha256')
      .update(`${this.appId}${timestamp}${payload}${this.secret}`)
      .digest('hex');
  }

  async query<T>(req: ShopeeGraphQLRequest): Promise<T> {
    const payload = JSON.stringify(req);
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = this.sign(timestamp, payload);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `SHA256 Credential=${this.appId}, Timestamp=${timestamp}, Signature=${signature}`,
        },
        body: payload,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`shopee status=${res.status} body=${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as {
      data?: T;
      errors?: Array<{ message?: string }>;
    };
    if (data.errors?.length) {
      throw new Error(`shopee graphql: ${data.errors[0]?.message ?? 'error'}`);
    }
    if (!data.data) throw new Error('shopee graphql: empty data');
    return data.data;
  }
}
```

Run: `npx jest shopee-client -v 2>&1 | tail -5` — Expected: PASS.

- [ ] **Step 4: Write the failing mapping test**

`src/sources/shopee/mapping.spec.ts`:

```typescript
import { toEnrichedDeal, toRawDeal } from './mapping';
import type { ShopeeOfferNode } from './mapping';

function node(overrides: Partial<ShopeeOfferNode> = {}): ShopeeOfferNode {
  return {
    itemId: 12345,
    productName: 'Teclado Mecânico RGB',
    price: '99.90',
    priceDiscountRate: 50,
    imageUrl: 'https://cf.shopee.com.br/img.jpg',
    offerLink: 'https://s.shopee.com.br/aff123',
    productLink: 'https://shopee.com.br/product/1/12345',
    sales: 1500,
    ratingStar: '4.8',
    shopName: 'Loja Tech',
    shopType: [1],
    ...overrides,
  };
}

describe('toRawDeal (shopee)', () => {
  it('maps node to RawDeal with shopee key and affiliated permalink', () => {
    const raw = toRawDeal(node(), 'kw:teclado mecanico');
    expect(raw.key).toEqual({ source: 'shopee', externalId: '12345' });
    expect(raw.priceCents).toBe(9990);
    // 50% off => original = price / 0.5
    expect(raw.originalPriceCents).toBe(19980);
    expect(raw.discountPercent).toBe(50);
    expect(raw.permalink).toBe('https://s.shopee.com.br/aff123');
    expect(raw.feedId).toBe('kw:teclado mecanico');
    expect(raw.condition).toBe('new');
  });

  it('null discount => no original price', () => {
    const raw = toRawDeal(node({ priceDiscountRate: null }), 'kw:x');
    expect(raw.originalPriceCents).toBeNull();
    expect(raw.discountPercent).toBe(0);
  });

  it('falls back to productLink when offerLink is empty', () => {
    const raw = toRawDeal(node({ offerLink: '' }), 'kw:x');
    expect(raw.permalink).toBe('https://shopee.com.br/product/1/12345');
  });
});

describe('toEnrichedDeal (shopee)', () => {
  it('derives seller trust and signals from the feed node', () => {
    const raw = toRawDeal(node(), 'kw:x');
    const e = toEnrichedDeal(raw, node());
    expect(e.source).toBe('shopee');
    expect(e.seller?.sellerTrust).toBe('high'); // 4.8
    expect(e.seller?.isVerifiedStore).toBe(true); // shopType [1]
    expect(e.signals.volumeTier).toBe('high'); // 1500 vendas
    expect(e.signals.isVerifiedStore).toBe(true);
  });

  it('unknown rating => trust unknown; few sales => tier none', () => {
    const n = node({ ratingStar: null, sales: 3, shopType: null });
    const raw = toRawDeal(n, 'kw:x');
    const e = toEnrichedDeal(raw, n);
    expect(e.seller?.sellerTrust).toBe('unknown');
    expect(e.signals.volumeTier).toBe('none');
    expect(e.signals.isVerifiedStore).toBe(false);
  });
});
```

Run: `npx jest src/sources/shopee/mapping -v 2>&1 | tail -10`
Expected: FAIL — módulo não existe.

- [ ] **Step 5: Implement the mapping**

`src/sources/shopee/mapping.ts`:

```typescript
import {
  EnrichedDeal,
  NormalizedSeller,
  RawDeal,
} from '../source.port';

/**
 * Node do `productOfferV2` (API GraphQL de afiliados Shopee BR).
 * `price` chega como string decimal ("99.90"); `priceDiscountRate` é
 * percentual inteiro; `offerLink` já vem comissionado com o appId.
 */
export interface ShopeeOfferNode {
  itemId: number | string;
  productName: string;
  price: string;
  priceDiscountRate: number | null;
  imageUrl: string;
  offerLink: string;
  productLink: string;
  sales: number | null;
  ratingStar: string | null;
  shopName: string | null;
  shopType: number[] | null;
}

/** Código de loja oficial/mall na API de afiliados. */
const OFFICIAL_SHOP_TYPE = 1;

export function toRawDeal(node: ShopeeOfferNode, feedId: string): RawDeal {
  const priceCents = Math.round(parseFloat(node.price) * 100);
  const rate = node.priceDiscountRate ?? 0;
  const originalPriceCents =
    rate > 0 && rate < 100
      ? Math.round(priceCents / (1 - rate / 100))
      : null;
  return {
    key: { source: 'shopee', externalId: String(node.itemId) },
    title: node.productName,
    priceCents,
    originalPriceCents,
    discountPercent: rate,
    thumbnail: node.imageUrl ?? '',
    permalink: node.offerLink || node.productLink,
    feedId,
    condition: 'new',
  };
}

export function toEnrichedDeal(
  raw: RawDeal,
  node: ShopeeOfferNode,
): EnrichedDeal {
  const rating = node.ratingStar != null ? parseFloat(node.ratingStar) : null;
  const isOfficial = (node.shopType ?? []).includes(OFFICIAL_SHOP_TYPE);
  const seller: NormalizedSeller = {
    externalSellerId: node.shopName ?? 'unknown',
    displayName: node.shopName,
    sellerTrust:
      rating == null || Number.isNaN(rating)
        ? 'unknown'
        : rating >= 4.5
          ? 'high'
          : rating >= 4
            ? 'medium'
            : 'low',
    isVerifiedStore: isOfficial,
    ratingAverage: rating != null && !Number.isNaN(rating) ? rating : null,
    fetchedAt: new Date().toISOString(),
  };
  const sales = node.sales ?? 0;
  return {
    key: raw.key,
    source: 'shopee',
    raw,
    seller,
    condition: 'new',
    signals: {
      freeShipping: false,
      installmentsNoInterest: false,
      volumeTier:
        sales > 1000 ? 'high' : sales > 100 ? 'mid' : sales > 10 ? 'low' : 'none',
      isVerifiedStore: isOfficial,
    },
    extras: { sales },
  };
}
```

Run: `npx jest src/sources/shopee -v 2>&1 | tail -10` — Expected: PASS (client + mapping).

- [ ] **Step 6: Commit**

```bash
git add src/sources/source.port.ts src/sources/shopee
git commit -m "feat(shopee): client GraphQL assinado + mapping para RawDeal/EnrichedDeal

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Shopee — source service, módulo e registro condicional

**Files:**
- Create: `src/sources/shopee/shopee-source.service.ts`
- Create: `src/sources/shopee/shopee-source.service.spec.ts`
- Create: `src/sources/shopee/shopee-source.module.ts`
- Modify: `src/sources/sources.module.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `ShopeeClient`, `toRawDeal`/`toEnrichedDeal`/`ShopeeOfferNode` (Task 5), `DealSourcePort`.
- Produces: `ShopeeSource implements DealSourcePort` (`id: 'shopee'`); token `SHOPEE_SOURCE_OPTS`; registro no array de `SOURCES_TOKEN` **somente quando** `SHOPEE_APP_ID` e `SHOPEE_APP_SECRET` estão presentes.

- [ ] **Step 1: Write the failing service test**

`src/sources/shopee/shopee-source.service.spec.ts`:

```typescript
import { ShopeeSource } from './shopee-source.service';
import type { ShopeeOfferNode } from './mapping';

function node(id: number, name = 'Produto'): ShopeeOfferNode {
  return {
    itemId: id,
    productName: `${name} ${id}`,
    price: '49.90',
    priceDiscountRate: 40,
    imageUrl: 'https://img',
    offerLink: `https://s.shopee.com.br/${id}`,
    productLink: `https://shopee.com.br/p/${id}`,
    sales: 200,
    ratingStar: '4.6',
    shopName: 'Loja',
    shopType: null,
  };
}

function makeDeps(nodesByCall: ShopeeOfferNode[][]) {
  let call = 0;
  const client = {
    query: jest.fn(async () => ({
      productOfferV2: { nodes: nodesByCall[call++] ?? [] },
    })),
  } as any;
  const source = new ShopeeSource(client, {
    keywords: ['teclado', 'mouse'],
    limitPerKeyword: 20,
  });
  return { client, source };
}

describe('ShopeeSource', () => {
  it('discover: one query per keyword, maps nodes to RawDeal', async () => {
    const { client, source } = makeDeps([[node(1)], [node(2)]]);

    const raws = await source.discover();

    expect(client.query).toHaveBeenCalledTimes(2);
    expect(raws.map((r) => r.key.externalId)).toEqual(['1', '2']);
    expect(raws[0].key.source).toBe('shopee');
  });

  it('discover: a failing keyword does not kill the others', async () => {
    const { client, source } = makeDeps([[node(1)]]);
    client.query
      .mockRejectedValueOnce(new Error('shopee status=500'))
      .mockResolvedValueOnce({ productOfferV2: { nodes: [node(2)] } });

    const raws = await source.discover();

    expect(raws.map((r) => r.key.externalId)).toEqual(['2']);
  });

  it('enrichMany reuses feed nodes without extra API calls', async () => {
    const { client, source } = makeDeps([[node(1)], []]);
    const raws = await source.discover();
    client.query.mockClear();

    const enriched = await source.enrichMany(raws);

    expect(client.query).not.toHaveBeenCalled();
    expect(enriched[0].seller?.sellerTrust).toBe('high');
    expect(enriched[0].source).toBe('shopee');
  });

  it('discoverOne rotates keywords between calls', async () => {
    const { client, source } = makeDeps([[node(1)], [node(2)]]);

    await source.discoverOne();
    await source.discoverOne();

    const kws = (client.query as jest.Mock).mock.calls.map(
      ([req]: any[]) => req.variables.keyword,
    );
    expect(kws).toEqual(['teclado', 'mouse']);
  });
});
```

Run: `npx jest shopee-source -v 2>&1 | tail -10`
Expected: FAIL — módulo não existe.

- [ ] **Step 2: Implement the source service**

`src/sources/shopee/shopee-source.service.ts`:

```typescript
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  DealSourcePort,
  EnrichedDeal,
  RawDeal,
} from '../source.port';
import { ShopeeClient } from './shopee-client';
import { ShopeeOfferNode, toEnrichedDeal, toRawDeal } from './mapping';

export const SHOPEE_SOURCE_OPTS = Symbol('SHOPEE_SOURCE_OPTS');

export interface ShopeeSourceOpts {
  keywords: string[];
  limitPerKeyword: number;
}

export const SHOPEE_DEFAULT_KEYWORDS =
  'teclado mecanico,mouse gamer,headset gamer,smartwatch,caixa de som bluetooth,carregador turbo,fone bluetooth,hub usb c';

/** sortType do productOfferV2: ordenar por maior desconto. */
const SORT_BY_DISCOUNT_DESC = 5;

const PRODUCT_OFFER_QUERY = `
query ProductOffers($keyword: String, $sortType: Int, $page: Int, $limit: Int) {
  productOfferV2(keyword: $keyword, sortType: $sortType, page: $page, limit: $limit) {
    nodes {
      itemId
      productName
      price
      priceDiscountRate
      imageUrl
      offerLink
      productLink
      sales
      ratingStar
      shopName
      shopType
    }
  }
}`;

@Injectable()
export class ShopeeSource implements DealSourcePort {
  readonly id = 'shopee' as const;
  private readonly logger = new Logger(ShopeeSource.name);
  private readonly nodeIndex = new Map<string, ShopeeOfferNode>();
  private keywordCursor = 0;

  constructor(
    private readonly client: ShopeeClient,
    @Inject(SHOPEE_SOURCE_OPTS) private readonly opts: ShopeeSourceOpts,
  ) {}

  async discover(): Promise<RawDeal[]> {
    this.nodeIndex.clear();
    const all: RawDeal[] = [];
    for (const kw of this.opts.keywords) {
      try {
        all.push(...(await this.fetchKeyword(kw)));
      } catch (err) {
        this.logger.warn(
          `ShopeeSource discover kw="${kw}" failed: ${(err as Error).message}`,
        );
      }
    }
    return all;
  }

  async discoverOne(): Promise<RawDeal[]> {
    if (this.opts.keywords.length === 0) return [];
    const kw =
      this.opts.keywords[this.keywordCursor % this.opts.keywords.length];
    this.keywordCursor++;
    this.nodeIndex.clear();
    try {
      return await this.fetchKeyword(kw);
    } catch (err) {
      this.logger.warn(
        `ShopeeSource discoverOne kw="${kw}" failed: ${(err as Error).message}`,
      );
      return [];
    }
  }

  async enrichMany(raws: RawDeal[]): Promise<EnrichedDeal[]> {
    // O feed já traz loja/rating/vendas — zero chamadas extras.
    return raws.map((r) => {
      const node = this.nodeIndex.get(r.key.externalId);
      return toEnrichedDeal(r, node ?? this.fallbackNode(r));
    });
  }

  async ping(): Promise<{ ok: boolean; message?: string }> {
    try {
      await this.client.query({
        query: PRODUCT_OFFER_QUERY,
        variables: {
          keyword: this.opts.keywords[0] ?? 'teclado',
          sortType: SORT_BY_DISCOUNT_DESC,
          page: 1,
          limit: 1,
        },
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  private async fetchKeyword(kw: string): Promise<RawDeal[]> {
    const data = await this.client.query<{
      productOfferV2: { nodes: ShopeeOfferNode[] };
    }>({
      query: PRODUCT_OFFER_QUERY,
      variables: {
        keyword: kw,
        sortType: SORT_BY_DISCOUNT_DESC,
        page: 1,
        limit: this.opts.limitPerKeyword,
      },
    });
    const raws: RawDeal[] = [];
    for (const node of data.productOfferV2?.nodes ?? []) {
      const raw = toRawDeal(node, `kw:${kw}`);
      this.nodeIndex.set(raw.key.externalId, node);
      raws.push(raw);
    }
    return raws;
  }

  private fallbackNode(r: RawDeal): ShopeeOfferNode {
    return {
      itemId: r.key.externalId,
      productName: r.title,
      price: (r.priceCents / 100).toFixed(2),
      priceDiscountRate: r.discountPercent,
      imageUrl: r.thumbnail,
      offerLink: r.permalink,
      productLink: r.permalink,
      sales: null,
      ratingStar: null,
      shopName: null,
      shopType: null,
    };
  }
}
```

Run: `npx jest shopee-source -v 2>&1 | tail -10` — Expected: PASS.

- [ ] **Step 3: Module + conditional registration**

`src/sources/shopee/shopee-source.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ShopeeClient } from './shopee-client';
import {
  SHOPEE_DEFAULT_KEYWORDS,
  SHOPEE_SOURCE_OPTS,
  ShopeeSource,
  ShopeeSourceOpts,
} from './shopee-source.service';

@Module({
  providers: [
    ShopeeClient,
    {
      provide: SHOPEE_SOURCE_OPTS,
      inject: [ConfigService],
      useFactory: (config: ConfigService): ShopeeSourceOpts => ({
        keywords: (config.get<string>('SHOPEE_KEYWORDS') ??
          SHOPEE_DEFAULT_KEYWORDS)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        limitPerKeyword: Number(
          config.get<string>('SHOPEE_LIMIT_PER_KEYWORD') ?? '20',
        ),
      }),
    },
    ShopeeSource,
  ],
  exports: [ShopeeSource],
})
export class ShopeeSourceModule {}
```

`src/sources/sources.module.ts` — substituir o conteúdo inteiro:

```typescript
// src/sources/sources.module.ts

import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MLSourceModule } from './mercado-livre/ml-source.module';
import { MLSource } from './mercado-livre/ml-source.service';
import { ShopeeSourceModule } from './shopee/shopee-source.module';
import { ShopeeSource } from './shopee/shopee-source.service';
import { DealSourcePort, SOURCES_TOKEN } from './source.port';
import { SourceRegistry } from './source-registry.service';

@Global()
@Module({
  imports: [MLSourceModule, ShopeeSourceModule],
  providers: [
    {
      provide: SOURCES_TOKEN,
      inject: [ConfigService, MLSource, ShopeeSource],
      useFactory: (
        config: ConfigService,
        ml: MLSource,
        shopee: ShopeeSource,
      ): DealSourcePort[] => {
        const list: DealSourcePort[] = [ml];
        if (
          config.get<string>('SHOPEE_APP_ID') &&
          config.get<string>('SHOPEE_APP_SECRET')
        ) {
          list.push(shopee);
        } else {
          new Logger('SourcesModule').log(
            'Shopee source off — SHOPEE_APP_ID/SHOPEE_APP_SECRET ausentes',
          );
        }
        return list;
      },
    },
    SourceRegistry,
  ],
  exports: [SourceRegistry, MLSourceModule],
})
export class SourcesModule {}
```

- [ ] **Step 4: Update `.env.example`**

Adicionar bloco novo (perto do bloco DeepSeek):

```
# ──────────────────────────────────────────
# Shopee (segunda fonte — Fase 3)
# ──────────────────────────────────────────
# Credenciais da API de afiliados (https://open-api.affiliate.shopee.com.br).
# Ambas ausentes => fonte desligada (só ML roda). Requer conta aprovada no
# programa Shopee Afiliados.
SHOPEE_APP_ID=
SHOPEE_APP_SECRET=
# Warmup: false => Shopee acumula PriceHistory/auditoria mas não publica
# (gate rejeita com stage=source_warmup). Ligar após ~7 dias de histórico.
SHOPEE_DISPATCH_ENABLED=false
SHOPEE_KEYWORDS=teclado mecanico,mouse gamer,headset gamer,smartwatch,caixa de som bluetooth,carregador turbo,fone bluetooth,hub usb c
SHOPEE_LIMIT_PER_KEYWORD=20
SHOPEE_TIMEOUT_MS=8000
# Com 2 fontes, use SCHEDULER_MODE=batch para o tick varrer as duas.
```

- [ ] **Step 5: Full check + commit**

Run: `npx jest src/sources && npm run build 2>&1 | tail -5`
Expected: PASS (specs de sources antigos + shopee) e build limpo.

Nota de integração (não bloqueia a task): com credencial real em mãos, validar campos/sortType da query com `ShopeeSource.ping()` via um `GET /pipeline/sources` ou console — a doc oficial do programa lista os campos de `productOfferV2`; qualquer divergência de nome de campo se corrige só no `PRODUCT_OFFER_QUERY`/`ShopeeOfferNode`.

```bash
git add src/sources .env.example
git commit -m "feat(shopee): ShopeeSource no SOURCES_TOKEN condicionado a credencial

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Warmup por fonte no gate + afiliado por fonte no formatter

**Files:**
- Modify: `src/curation/curation-gate.service.ts`
- Modify: `src/curation/curation-gate.service.spec.ts`
- Modify: `src/pipeline/formatter.service.ts` (`resolveLink`)
- Modify: `src/pipeline/formatter-digest.spec.ts`

**Interfaces:**
- Consumes: `ScoredDeal.deal.key.source` (`'ml' | 'shopee'`), `CurationDecisionRepo` via `record()` existente.
- Produces: novo stage de auditoria `'source_warmup'` (string livre — sem migration, por design da Fase 2); `FormatterService.resolveLink` devolve `raw.permalink` direto quando `source !== 'ml'`.

- [ ] **Step 1: Write the failing gate test**

Em `src/curation/curation-gate.service.spec.ts`, adicionar um describe novo usando os helpers já existentes no arquivo (`makeDeps(overrides)`, `makeGate(d)`, `makeScored(id, score, factors)` e o repo fake `d.decisions.upsert`):

```typescript
function makeShopeeScored(id: string, score: number): ScoredDeal {
  const sd = makeScored(id, score);
  const key = { source: 'shopee' as const, externalId: id };
  (sd.deal as any).key = key;
  (sd.deal.raw as any).key = key;
  return sd;
}

describe('CurationGateService source warmup (shopee)', () => {
  it('rejects shopee deals with stage=source_warmup while dispatch is off (default)', async () => {
    const d = makeDeps(); // sem SHOPEE_DISPATCH_ENABLED — default é false
    const gate = makeGate(d);
    // score 95 + histórico (historyDays=30 no fake) — prova que o warmup
    // bloqueia ANTES de qualquer outra regra do gate.
    const out = await gate.selectForDispatch([makeShopeeScored('77', 95)], 5);

    expect(out).toHaveLength(0);
    expect(d.decisions.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        catalogId: 'shopee:77',
        stage: 'source_warmup',
        outcome: 'rejected',
      }),
    );
    expect(d.judge.judge).not.toHaveBeenCalled();
  });

  it('lets shopee deals through when SHOPEE_DISPATCH_ENABLED=true', async () => {
    const d = makeDeps({ SHOPEE_DISPATCH_ENABLED: 'true' });
    const gate = makeGate(d);

    const out = await gate.selectForDispatch([makeShopeeScored('77', 95)], 5);

    expect(out).toHaveLength(1);
  });

  it('never touches ml deals', async () => {
    const d = makeDeps();
    const gate = makeGate(d);

    const out = await gate.selectForDispatch([makeScored('MLB1', 95)], 5);

    expect(out).toHaveLength(1);
    const stages = d.decisions.upserts.map((u: any) => u.stage);
    expect(stages).not.toContain('source_warmup');
  });
});
```

Run: `npx jest curation-gate -t "source_warmup" -v 2>&1 | tail -10`
Expected: FAIL — stage não existe.

- [ ] **Step 2: Implement the warmup check**

Em `src/curation/curation-gate.service.ts`:

1. Novo campo no constructor (junto dos outros `num(...)`):

```typescript
    this.shopeeDispatchEnabled =
      (this.config.get<string>('SHOPEE_DISPATCH_ENABLED') ?? 'false') ===
      'true';
```

e a declaração `private readonly shopeeDispatchEnabled: boolean;` junto das demais.

2. Em `selectForDispatch`, logo após `const priceCents = sd.deal.raw.priceCents;` e ANTES do check de price-raise:

```typescript
      if (sd.deal.key.source === 'shopee' && !this.shopeeDispatchEnabled) {
        await this.record({
          catalogId: keyStr,
          stage: 'source_warmup',
          outcome: 'rejected',
          score: sd.score,
          priceCents,
        });
        continue;
      }
```

3. Atualizar o comentário do model `CurationDecision` em `prisma/schema.prisma` (lista de stages) acrescentando `'source_warmup'` — comentário só, sem migration.

Run: `npx jest curation-gate -v 2>&1 | tail -10` — Expected: PASS (novos + antigos).

- [ ] **Step 3: Write the failing formatter test**

Em `src/pipeline/formatter-digest.spec.ts`, adicionar:

```typescript
  it('shopee deals use the feed permalink as-is (no affiliate resolve)', async () => {
    const { formatter, affiliate } = makeFormatter();
    const shopee = makeScored('77', 'good');
    (shopee.deal as any).key = { source: 'shopee', externalId: '77' };
    (shopee.deal.raw as any).key = { source: 'shopee', externalId: '77' };
    (shopee.deal.raw as any).permalink = 'https://s.shopee.com.br/aff77';

    const { caption } = await formatter.formatDigest([
      { scored: shopee, variant: 'A' as const },
      { scored: makeScored('MLB1', 'top'), variant: 'A' as const },
    ]);

    expect(caption).toContain('https://s.shopee.com.br/aff77');
    expect(caption).toContain('aff:https://ml/MLB1');
    expect(affiliate.resolve).toHaveBeenCalledTimes(1); // só o deal ML
  });
```

Run: `npx jest formatter-digest -t "shopee" -v 2>&1 | tail -10`
Expected: FAIL — `resolveLink` ainda resolve tudo.

- [ ] **Step 4: Make resolveLink source-aware**

Em `src/pipeline/formatter.service.ts`, substituir `resolveLink`:

```typescript
  /**
   * ML precisa do passo de afiliação (painel/planilha). Shopee (e futuras
   * fontes com link já comissionado no feed) usa o permalink como está.
   */
  private resolveLink(raw: RawDeal): Promise<string> {
    if (raw.key.source === 'ml') return this.affiliate.resolve(raw.permalink);
    return Promise.resolve(raw.permalink);
  }
```

Run: `npx jest formatter -v 2>&1 | tail -10` — Expected: PASS.

- [ ] **Step 5: Full suite + lint + commit**

Run: `npx jest 2>&1 | tail -10 && npm run lint 2>&1 | tail -3 && npm run build 2>&1 | tail -3`
Expected: suíte inteira verde, lint e build limpos.

```bash
git add src/curation src/pipeline prisma/schema.prisma
git commit -m "feat(curation): warmup por fonte (source_warmup) + afiliado por fonte

Shopee só publica com SHOPEE_DISPATCH_ENABLED=true; link do feed ja vem
comissionado, sem passo de afiliacao.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Verificação final (após todas as tasks)

- [ ] `npx jest` — suíte inteira verde.
- [ ] `npm run build` — sem erro de tipo.
- [ ] Smoke local sem credenciais novas: `npm run start` → boot loga `Headline provider: noop` (sem DEEPSEEK_API_KEY) e `Shopee source off` — fallbacks intactos.
- [ ] Smoke com `DEEPSEEK_API_KEY`: boot loga `Headline provider: deepseek`.
- [ ] Pós-aprovação do afiliado Shopee (fora do código): preencher `SHOPEE_APP_ID`/`SECRET`, conferir `ping()` da fonte, rodar 7 dias com `SHOPEE_DISPATCH_ENABLED=false`, depois ligar.
