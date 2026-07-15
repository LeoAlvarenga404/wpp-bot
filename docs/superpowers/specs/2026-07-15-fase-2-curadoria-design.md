# Fase 2 — Curadoria confiável: barreiras anti-fake, auditoria e juiz LLM

**Data:** 2026-07-15
**Status:** aprovado em brainstorming, aguardando plano de implementação

## Objetivo

Transformar o pipeline automático (Fase 1) em automático **confiável**: nenhuma
oferta fake publicada às cegas, toda decisão de curadoria auditável, e copy A/B
instrumentada para análise futura. Quatro entregas:

1. Barreiras anti-fake duras (price-raise vira bloqueio, não penalidade).
2. `CurationDecision` — auditoria de por que cada deal foi postado/rejeitado.
3. Juiz LLM (DeepSeek) somente na zona cinza das decisões.
4. Copy A/B com registro de variante (análise manual, sem tracking de clique).

## Decisões de requisito (clarificação com o usuário)

| Questão | Decisão |
|---|---|
| Deal sem histórico ≥7d, dispatch ligado | Zona cinza automática → juiz LLM decide |
| Deal com histórico | `score ≥ DEAL_SCORE_TOP` (90) posta direto; 75–89 → juiz; `< DEAL_SCORE_MIN` (75) rejeita |
| Price-raise suspeito | Bloqueio duro em qualquer faixa de score |
| Granularidade da auditoria | Grava todos os estágios, upsert por `(catalogId, stage, day)` com contador |
| Métrica do copy A/B | Só registro de variante; análise manual no painel de afiliado ML |
| Juiz indisponível/erro | Fail-closed: não posta, grava `judge_error`, deal volta no próximo tick |
| Sem `DEEPSEEK_API_KEY` | Juiz off → zona cinza rejeita (só `score ≥ TOP` com histórico posta) |

## Arquitetura (abordagem escolhida: gate centralizado + ports)

Novo `CurationGateService` (em `src/curation/`) concentra **todas** as decisões
de curadoria e grava `CurationDecision` em cada saída. `PipelineService` só
orquestra. Juiz é port + adapter, no padrão já usado por headline, affiliate e
publisher.

### Modelo de dados

```prisma
model CurationDecision {
  id           BigInt   @id @default(autoincrement())
  catalogId    String
  stage        String   // 'dedup' | 'fake_discount' | 'prescore_cut' | 'score_min'
                        // | 'price_raise' | 'judge' | 'judge_error' | 'judge_budget'
                        // | 'posted'
  outcome      String   // 'rejected' | 'approved' | 'posted'
  day          String   // 'YYYY-MM-DD' em America/Sao_Paulo — chave do upsert
  count        Int      @default(1)   // repetições no dia
  score        Int?
  priceCents   Int?
  reasons      Json?    // ScoreReason[] do DealScore, quando aplicável
  judgeVerdict Json?    // { approve, confidence, reason } quando stage=judge*
  variant      String?  // copy A/B quando stage=posted
  firstAt      DateTime @default(now())
  lastAt       DateTime @updatedAt

  @@unique([catalogId, stage, day])
  @@index([day, stage])
}
```

- Upsert em `(catalogId, stage, day)`: rejeição repetida no cron `*/1` só
  incrementa `count` e atualiza `lastAt`/`score`/`priceCents`. Sem flood.
- `stage`/`outcome` são strings, não enums — novo estágio não exige migration
  (mesmo racional de `WaTarget.channel`).
- Sem FK para `Product` — catalogId aparece em feed cru antes de existir
  `Product` (mesmo racional de `PriceHistory`).
- GC: 60 dias, junto do ciclo de retenção existente do `CurationService`.
- `SentMessage` ganha coluna `variant String?`.
- Migration única, aditiva, hand-authored + validada com `prisma migrate diff`
  (padrão do commit `add-target-channel`).
- Consulta típica: "por que MLB123 não postou hoje?" →
  `SELECT * FROM "CurationDecision" WHERE "catalogId"='ml:MLB123' AND day='2026-07-15'`.

### Juiz DeepSeek

```ts
// src/judge/judge.port.ts
export const DEAL_JUDGE = Symbol('DEAL_JUDGE');

export interface JudgeVerdict {
  approve: boolean;
  confidence: number; // 0..1
  reason: string;     // 1 frase — persiste em CurationDecision.judgeVerdict
}

export interface DealJudge {
  judge(input: JudgeInput): Promise<JudgeVerdict>;
}
```

- **Input** (JSON compacto, sem imagem/HTML): title, priceCents,
  originalPriceCents, discountPercent, analytics (median30d, min30/14/7,
  distinctDays, trend), sinal price-raise, seller (loja oficial, reputação),
  soldQty, score + reasons/penalties do DealScore.
- **Adapter** `DeepSeekJudgeAdapter`: POST `https://api.deepseek.com/chat/completions`
  (API OpenAI-compatible), `response_format: { type: 'json_object' }`,
  `temperature: 0`, `max_tokens: 200`, timeout via `AbortController`.
  Prompt system em pt-BR: curador cético de ofertas; rejeitar desconto
  inflado/preço fantasma/vendedor duvidoso; responder somente JSON.
- **Aprovação**: `approve === true && confidence >= JUDGE_MIN_CONFIDENCE`.
- **Fail-closed**: timeout, erro HTTP ou JSON inválido → não posta; grava
  `stage='judge_error'`. Sem retry no tick — deal reaparece no próximo.
- **Cache de veredito**: in-memory, chave `catalogId`, TTL 6h, invalidado se o
  preço variar >2%, teto ~500 entradas. Deal recorrente na zona cinza não paga
  LLM a cada tick.
- **Sem chave**: provider noop que rejeita zona cinza (conservador por design).

Env novo (`.env.example` já tem `DEEPSEEK_API_KEY`):

```
DEEPSEEK_MODEL=deepseek-chat        # trocar para v4-flash quando desejado
DEEPSEEK_TIMEOUT_MS=8000
JUDGE_MIN_CONFIDENCE=0.6
JUDGE_MAX_CALLS_PER_TICK=10
COPY_AB_ENABLED=true
```

### Fluxo do gate

```
tick
 └─ scorePipeline
     ├─ curation.record(preço)                  (inalterado)
     ├─ gate.screenRaw(raw)
     │    ├─ dedup?          → CurationDecision(stage=dedup)
     │    └─ fake_discount?  → CurationDecision(stage=fake_discount)
     ├─ prescore corta       → CurationDecision(stage=prescore_cut)
     ├─ enrich + DealScore
     └─ score < MIN          → CurationDecision(stage=score_min, score, reasons)

 └─ dispatch (só se SCHEDULER_DISPATCH_ENABLED)
     └─ gate.selectForDispatch(scored, max)
          para cada candidato (ordenado por score, até `max` aprovados):
          ├─ price-raise suspeito           → rejeita duro (stage=price_raise)
          ├─ score ≥ TOP com histórico      → aprova direto
          ├─ zona cinza (sem histórico OU 75–89) → juiz DeepSeek
          │    ├─ aprova com confiança      → aprovado (stage=judge, approved)
          │    ├─ reprova                   → stage=judge, rejected
          │    └─ erro/timeout              → stage=judge_error (fail-closed)
          └─ aprovado → enqueue por target + CurationDecision(stage=posted, variant)
```

- Juiz **somente no caminho de dispatch**: warmup (dispatch off) = zero custo
  LLM; auditoria dos estágios iniciais acumula desde já.
- `JUDGE_MAX_CALLS_PER_TICK`: teto de custo; excedente grava
  `stage=judge_budget` e fica para o próximo tick.
- `stage=posted` = aprovado + enfileirado. Envio real segue auditado por
  `SentMessage` (worker) — dois registros, papéis distintos.
- `runOnce` (`POST /pipeline/run`) usa o mesmo `selectForDispatch` — execução
  manual e cron idênticas.
- Counters novos no metrics: `judgeApprove`, `judgeReject`, `judgeError`.

### Copy A/B

- Variante = hash determinístico de `catalogId` → `'A' | 'B'`. Mesmo deal =
  mesma copy em WA e Telegram (comparação limpa entre canais).
- `src/pipeline/templates/variants.ts`: A = template atual por level; B =
  família alternativa (estrutura/gancho diferente, escrita na implementação).
- Fluxo: `selectForDispatch` calcula → `SendDealJob.variant` → worker →
  `FormatterService.formatScored(scored, variant)` → `SentMessage.variant` +
  `CurationDecision(posted).variant`.
- `COPY_AB_ENABLED=false` → sempre A (rollback sem deploy).
- Análise: SQL por período × painel de afiliado ML, manual.

### Error handling

- Escrita de `CurationDecision` nunca derruba o pipeline: try/catch +
  `logger.error` (padrão de `curation.record`).
- Juiz fail-closed (acima).
- Upsert por chave única; cron roda em instância única — sem corrida real.

### Testes

- `curation-gate.service.spec`: juiz fake via port — roteamento por faixa de
  score, sem-histórico → juiz, price-raise → bloqueio duro, budget cap,
  judge error → fail-closed, decisão gravada em cada saída.
- `deepseek-judge.adapter.spec`: fetch mockado — JSON ok / inválido / timeout /
  confidence abaixo do threshold.
- Repo de decisão: upsert incrementa `count`, não duplica linha.
- Formatter: hash A/B determinístico; `COPY_AB_ENABLED=false` → sempre A.
- Specs existentes do pipeline atualizados (injeção do gate); reuso dos
  fixtures de `deal-score/__fixtures__` para montar input do juiz.

## Fora de escopo (YAGNI)

- Tracking de clique / link intermediário próprio (candidato a Fase 3).
- Juiz em todos os posts (só zona cinza).
- Enums Prisma para stage/outcome.
- Dashboard de auditoria — consulta via SQL/Prisma Studio por ora.
