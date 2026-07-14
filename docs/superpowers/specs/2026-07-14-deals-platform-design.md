# Plataforma de Ofertas Multi-canal — Design

**Data:** 2026-07-14
**Status:** Aprovado pelo usuário (brainstorming em sessão)

## Contexto e objetivo

Evoluir o repo atual (NestJS, Mercado Livre-first, WhatsApp via Baileys) para uma plataforma de mídia de ofertas com afiliados, operando 24/7 como negócio sério: múltiplos grupos/canais, publicação automática desde o início, sem promoções enganosas.

### Decisões fechadas

| Decisão | Escolha |
|---|---|
| Objetivo | Negócio sério de mídia (multi-canal, receita mensal, 24/7) |
| Afiliados hoje | Mercado Livre (Shopee e Amazon entram quando aprovados) |
| Canais | WhatsApp (Baileys, volume conservador) + Telegram (canal de escala) |
| Fontes de oferta | APIs oficiais + histórico de preço próprio; sem scraping; sem preço enganoso |
| Papel do LLM | Copywriting dos posts + juiz de curadoria em zona cinza; NUNCA agente-runtime |
| Provedor LLM | DeepSeek V4 apenas (sem GLM). Juiz = V4 Flash; copy = A/B entre V4 Flash e V4 Pro |
| Publicação | Automática desde o início, protegida pelo anti-fake gate |
| Base de código | Evoluir este repo (não reescrever) |

## Seção 1 — Arquitetura geral

Três camadas plugáveis por porta:

```
SOURCES                PIPELINE                          PUBLISHERS
┌──────────────┐   ┌─────────────────────────────┐   ┌──────────────────┐
│ MlSource ✅  │   │ enrich → score → anti-fake  │   │ TelegramPublisher│
│ ShopeeSource │ → │ gate → dedup → LLM copy     │ → │ BaileysPublisher │
│ (Amazon fut.)│   │ → enfileira                 │   │ (CloudApi fut.)  │
└──────────────┘   └─────────────────────────────┘   └──────────────────┘
   DealSourcePort         BullMQ (Redis)                 PublisherPort
```

**Dois processos:**

1. **App** (NestJS atual) — scheduler roda ciclos de ingestão, API admin/health, OAuth ML.
2. **Worker** (`src/worker/send-deal.worker.ts`, já existe) — consome fila, resolve publisher por canal, aplica rate-limit por target, retries.

**Estado:** Postgres/Prisma (models já criados: `Product`, `PriceHistory`, `DedupEntry`, `SentMessage`, `WaTarget`, `WaOptout`, `AffiliateLink`, `MlToken`). Zero estado em JSON local após a migração. Redis apenas para fila e rate-limit.

**Novos conceitos:**

- `PublisherPort` — interface `publish(post, target)`. O pipeline deixa de chamar `WaService` direto e de depender de `WA_TARGET_JID` único (`pipeline.service.ts:116`).
- `Target` ganha coluna `channel` (`'wa' | 'telegram'`). Um deal aprovado gera N jobs, um por target ativo.
- `AffiliateResolver` por marketplace — ML hoje; Shopee quando aprovado.
- Models novos: `CurationDecision` (auditoria do gate), `ClickEvent` (fase 3).

**Deploy:** docker compose atual (app + worker + postgres + redis). Worker é o único processo que abre sessão Baileys (sessão é single-holder).

## Seção 2 — Anti-fake gate

Publicação automática exige três barreiras em série. Deal só posta se passar todas.

### Barreira 1 — Score determinístico (existe, calibrar)

`deal-score.service.ts` pontua desconto vs mediana histórica, reputação do vendedor, frete, parcelamento → nota 0–100. Threshold inicial de postagem: 75. Ajustado com CTR real (Seção 4).

### Barreira 2 — Regras duras de histórico (novo, determinístico)

| Situação | Regra |
|---|---|
| Produto sem histórico próprio (< 7 dias de `PriceHistory`) | Desconto anunciado > 30% → não posta. Preço "de" do marketplace não é confiável |
| Com histórico | Preço atual deve ser ≤ mediana 30d − 10%. Desconto calculado contra a NOSSA mediana, nunca contra o preço riscado da loja |
| Pico suspeito | Preço subiu > 20% nos 14 dias anteriores à "promoção" → padrão de farsa → rejeita |
| Selo "menor preço em N dias" | Só quando verdadeiro no nosso histórico |

Implicação: o scheduler grava `PriceHistory` em todo ciclo, mesmo sem postar. Nas primeiras 1–2 semanas haverá poucas postagens enquanto o histórico acumula — custo aceito pela credibilidade.

Percentuais (30%, 10%, 20%) são configuráveis por env; valores acima são os defaults iniciais.

### Barreira 3 — Juiz LLM de zona cinza (novo)

- Aplica-se apenas a deals que passaram nas barreiras 1+2 mas têm sinal fraco: score 60–75, categoria nova ou vendedor desconhecido.
- Score ≥ 75 pula o juiz (custo zero no caminho comum).
- Modelo: DeepSeek V4 Flash via adapter OpenAI-compatible (OpenRouter como gateway, com fallback de provider). Prompt fixo → cache hit ~98% de desconto.
- Entrada: título, preço, histórico resumido, reputação. Saída JSON: `{aprovado, motivo, confianca}`. `confianca < 0.7` → descarta.
- **Fail-closed:** timeout/erro do LLM → descarta o deal com reason `llm_indisponivel`. Na dúvida, nunca posta. LLM indisponível jamais bloqueia a fila.

### Auditoria

Toda decisão (postado/rejeitado, motivo, números usados) gravada em `CurationDecision`. Reclamação de "promoção ruim" é reconstruível.

## Seção 3 — Publishers

```ts
interface PublisherPort {
  readonly channel: 'telegram' | 'wa';
  publish(post: RenderedPost, target: Target): Promise<PublishResult>;
}
```

Worker consome job → resolve publisher pelo `target.channel` → publica. Pipeline nunca toca canal diretamente.

### TelegramPublisher (novo)

- Bot API oficial (`sendMessage`/`sendPhoto` para canal via `chat_id`). HTTP puro, sem sessão, sem risco de ban.
- Limites: ~30 msg/s global, 20 msg/min por grupo — rate-limiter por target.
- Canal Telegram = broadcast ilimitado. É o canal de escala.

### BaileysPublisher (adaptar `wa.service.ts`)

- Volume conservador: máx 10–15 posts/dia por grupo, jitter aleatório de 30–120s entre envios, quiet hours (scheduler já tem).
- Worker é o único holder da sessão Baileys.
- Plano B desenhado na porta: `WaCloudApiPublisher` futuro implementa a mesma interface; troca via config quando o faturamento justificar a API oficial.

### Compliance (obrigatório)

- Disclaimer de afiliado em TODO template: "*Link de afiliado. Preço sujeito a alteração.*" Hoje existe teste garantindo que NÃO aparece (`formatter.service.spec.ts:54`) — inverter.
- Opt-out: comando "sair" no privado remove (migrar `optout.service.ts` para Prisma, model `WaOptout` já existe).
- Timestamp de preço no post ("preço visto às 14h32").

### Fluxo do job

```
deal aprovado → renderiza post 1x → N jobs (1 por target ativo)
job: { dealId, targetId, renderedPost }
worker: rate-limit ok? → publish → grava SentMessage → métricas
falha: retry 3x com backoff → dead-letter → alerta
```

Idempotência: chave única `dealId+targetId` em `SentMessage` — retry nunca duplica post.

## Seção 4 — Cliques, CTR e métricas

### Rastreamento em 2 níveis

1. **Sub-IDs do marketplace (imediato, sem infra):** tag/sub-ID por link na convenção `{canal}_{targetId}` (ex.: `tg_ofertas1`, `wa_grupo2`). Painel do afiliado mostra cliques/conversão por canal.
2. **Redirector próprio (fase 3):** `GET /r/:code` → grava `ClickEvent` (dealId, targetId, timestamp) → 302 para o link afiliado. Requer domínio público + HTTPS. Dá CTR por deal. Sem cookies, sem dados pessoais.

### Loop de calibração (semanal, manual no início)

- CTR por faixa de score → ajusta threshold.
- Categoria com CTR alto → aumenta cota no ranking do scheduler.

### Métricas Prometheus (instrumentar de verdade — `counters.service.ts` hoje é esqueleto)

- `deals_ingested_total{source}`, `deals_rejected_total{reason}` (sem_historico, pico_suspeito, score_baixo, llm_reprovou, llm_indisponivel...)
- `posts_published_total{channel,target}`, `publish_failures_total{channel}`
- `llm_judge_calls_total{verdict}`, `llm_cost_cents_total`
- `clicks_total{channel}` (fase 3)

`deals_rejected_total{reason}` é a métrica mais importante no início: mostra se o gate estrangula demais ou de menos.

### Alertas mínimos

Worker parado; fila > N por 10 min; sessão Baileys caiu; zero posts em 24h.

## Seção 5 — Rollout em fases

### Fase 0 — Fundação

- Completar migração Prisma/BullMQ já em andamento (repos, `src/queue/`, `src/worker/`, migrations). Zero JSON file-backed.
- Segurança: ApiKeyGuard em `/wa/*` (`wa-health.controller.ts:8` hoje aberto), `API_KEY` obrigatória em produção, `ValidationPipe` global.
- Disclaimer de afiliado em todo template + teste invertido.
- CI: `lint` sem `--fix`; resolver vulnerabilidade crítica do protobufjs (`npm audit`).
- Coleta contínua de `PriceHistory` ligada desde já.

### Fase 1 — Telegram no ar

- `PublisherPort` + `TelegramPublisher` + `Target.channel`. Canal Telegram criado, posts com sub-ID.
- Threshold 75+, barreiras 1+2 ativas. Sem LLM ainda.
- Rodar 2 semanas: acumular histórico, validar qualidade dos posts com acompanhamento manual.

### Fase 2 — LLM + automático calibrado

- Adapter OpenAI-compatible (OpenRouter), modelos por env var (`LLM_JUDGE_MODEL`, `LLM_COPY_MODEL`).
- Juiz: DeepSeek V4 Flash na zona 60–75, fail-closed.
- Copy: A/B entre DeepSeek V4 Flash e V4 Pro em 20 deals reais; escolher o melhor pt-BR.
- `CurationDecision` + `deals_rejected_total{reason}` no ar. Calibrar threshold com CTR do painel de afiliado.

### Fase 3 — WhatsApp grupo

- `BaileysPublisher` conservador (10–15/dia, jitter, quiet hours). Grupo alimentado por convite à audiência do Telegram.
- Redirector `/r/:code` opcional para CTR por post.

### Fase 4 — Shopee

- Quando aprovado: `ShopeeSource` + `ShopeeAffiliateResolver`. `SourceId` expande (abstração `DealSourcePort` já existe).

## Testes

- **Unit:** cada linha da tabela de regras duras (Seção 2) vira caso de teste; resolvers de afiliado; formatters com disclaimer obrigatório. Seguir padrão golden test já usado no repo (`deal-score` parity spec).
- **Integração:** pipeline → fila → publisher fake; idempotência `dealId+targetId`; fail-closed do juiz (timeout → rejeita com reason).
- **Erros:** retry/backoff apenas no publish; falha de ingestão loga e segue (próximo ciclo tenta); LLM indisponível nunca bloqueia a fila.

## Fora de escopo (por ora)

- Amazon (aguardar aprovação; usar Creators API, não PA-API legada).
- WhatsApp Cloud API (desenhado na porta, implementação futura).
- Painel admin de aprovação manual (publicação é automática; auditoria via `CurationDecision`).
- Multi-tenant/SaaS.
- Scraping de lojas ou agregadores.
