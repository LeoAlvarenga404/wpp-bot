# Fase 3 — Shopee como segunda fonte + volume por canal + digest WA

**Data:** 2026-07-15
**Status:** aprovado em brainstorming, aguardando plano de implementação

## Objetivo

Escalar o alcance do bot mantendo a mesma ideia (curadoria confiável, autônomo,
infra atual) em três frentes:

1. **Shopee** como segunda fonte de ofertas via `DealSourcePort` (porta já existe).
2. **Teto de publicação por canal** — Telegram vira canal de volume (~40 ofertas/dia),
   WhatsApp mantém a contagem de envios atual (risco de ban inalterado).
3. **Digest no WhatsApp** — 1 envio agrupa até 4 ofertas → até 16 ofertas/dia
   com os mesmos 4 envios.

E uma simplificação: **DeepSeek como LLM único** — headline migra de Groq para
DeepSeek; `GROQ_API_KEY` sai do projeto.

Custo incremental estimado: **~R$ 7–17/mês** (juiz DeepSeek escalando +
headlines ~R$ 2; Shopee API e Telegram são gratuitos; o VPS atual aguenta —
adapter é HTTP puro, sem Chromium).

## Decisões de requisito (clarificação com o usuário)

| Questão | Decisão |
|---|---|
| Direção da melhoria | Mais fontes de oferta (não tracking, não novos canais sociais) |
| Programas de afiliado existentes | Nenhum além do ML — inscrição no Shopee Afiliados é pré-requisito do adapter |
| Marketplace prioritário | Shopee (aprovação rápida, API GraphQL oficial, nicho tech barato) |
| Mix de publicação | Mesmo funil: ML e Shopee competem no mesmo gate, score decide |
| Volume desejado | Muito mais que 4 posts/dia → Telegram volume + digest WA (sem subir risco de ban) |
| Ramp do chip WA / multi-chip | Fora desta fase — candidatos a fase futura |
| Provedor LLM | Só DeepSeek, sempre — headline migra de Groq para DeepSeek |

## Arquitetura

### 1. Fonte Shopee (`src/sources/shopee/`)

- `ShopeeSourceService` implementa `DealSourcePort` — mesmo contrato do ML
  (`discover`, `discoverOne`, `enrichMany`, `ping`).
- **API:** GraphQL de afiliado Shopee BR
  (`https://open-api.affiliate.shopee.com.br/graphql`), autenticação por
  assinatura SHA256 de `appId + timestamp + payload + secret` no header.
  Query `productOfferV2` filtrada por categorias tech, ordenada por
  desconto/comissão.
- **Mapping → `RawDeal`:** `key = { source: 'shopee', externalId: itemId }`;
  `permalink = offerLink` — **link já comissionado pelo próprio feed**, sem
  passo de afiliação posterior. `SourceId` amplia para `'ml' | 'shopee'`.
- **`enrichMany` sem chamadas extras:** o feed já traz rating da loja, volume
  de vendas e flag de loja oficial → `NormalizedSeller` + `signals` direto.
- **Afiliado por fonte:** `FormatterService` só chama `affiliate.resolve()`
  quando `key.source === 'ml'`; Shopee usa o permalink como está. Adapters
  Playwright/JSON do ML não mudam.
- **Warmup por fonte:** `SHOPEE_DISPATCH_ENABLED=false` no início — a fonte
  participa do scorePipeline (acumula `PriceHistory` e auditoria
  `CurationDecision`) mas o gate rejeita dispatch com `stage='source_warmup'`.
  Liga após ~7 dias de histórico (barreira anti-fake precisa de mediana).
  Mesmo padrão da Fase 0.
- **Dedup / PriceHistory / juiz / A/B:** zero mudança — tudo já é chaveado por
  `keyToString(key)` (`shopee:123`). O juiz recebe o mesmo input compacto;
  deal Shopee sem histórico cai na zona cinza normalmente.
- **Sem matching cross-marketplace** (mesmo produto em ML e Shopee = duas
  chaves distintas). Fuzzy matching de título é complexidade alta, ganho baixo
  — YAGNI.
- **Fail-safe:** sem `SHOPEE_APP_ID`/`SHOPEE_APP_SECRET`, a fonte não registra
  no `SOURCES_TOKEN` (mesmo padrão dos fallbacks de Groq/DeepSeek/afiliado).
- **Pré-requisito não-código:** inscrição no Shopee Afiliados + solicitação de
  credencial da API aberta de afiliado.

### 2. Teto de publicação por canal

Hoje o gate aprova até `MAX_DEALS_PER_RUN` (global) e `enqueueScored` manda o
mesmo conjunto para todos os targets — WhatsApp e Telegram presos ao mesmo teto.

- Novos envs: `MAX_DEALS_PER_RUN_WA=4` (ofertas por tick — com digest ligado
  viram 1 mensagem) e `MAX_DEALS_PER_RUN_TELEGRAM=10`.
- `selectForDispatch(scored, max)` recebe `max = max(tetos dos canais ativos)`
  e devolve aprovados ordenados por score; o enqueue corta por canal: targets
  `wa` recebem os top `MAX_DEALS_PER_RUN_WA`, targets `telegram` os top
  `MAX_DEALS_PER_RUN_TELEGRAM`.
- `CurationDecision(stage='posted')` continua 1 linha por deal aprovado;
  deal aprovado que só sai no Telegram é auditado igual.
- **Juiz escala junto:** `JUDGE_MAX_CALLS_PER_TICK` sobe de 10 → 20.
  Pior caso ~80 calls/dia ≈ R$ 10–15/mês (hoje < R$ 3).
- Resultado: 4 ticks/dia → Telegram até ~40 ofertas/dia; WhatsApp inalterado.

### 3. Digest WhatsApp

- Novo tipo de job `send-digest` na fila `send-deal`: o enqueue agrupa os
  aprovados do tick em **1 job por target WA** com até `WA_DIGEST_SIZE=4`
  ofertas. Telegram continua 1 post por oferta (UX de canal melhor, rastreio
  por post).
- **Risco de ban cai ou mantém:** hoje cada oferta aprovada vira 1 mensagem
  (até N por tick); com digest, N ofertas viram **1 mensagem por tick por
  target** — a contagem de mensagens diminui mesmo com mais ofertas.
  Contadores `WaCounter`, jitter e quiet hours intactos (contam mensagens,
  não ofertas).
- **Interação dos envs:** `MAX_DEALS_PER_RUN_WA` limita ofertas por tick;
  `WA_DIGEST_SIZE` limita ofertas por mensagem. Mensagens por tick =
  `ceil(aprovadas_wa / WA_DIGEST_SIZE)`. Defaults (4 e 4) = 1 mensagem/tick.
- **Formato:** mídia da oferta de maior score + caption com blocos curtos por
  oferta — emoji do nível, título, preço, link afiliado e selo de preço
  monitorado quando houver histórico. Variante A/B calculada **por oferta**
  (hash de `catalogId`, como hoje); template de bloco por variante em
  `variants.ts`.
- **Auditoria por oferta preservada:** `SentMessage`, `CurationDecision(posted)`
  e dedup continuam 1 registro por deal, mesmo dentro do digest.
  `SentMessage` ganha coluna `digestId String?` para agrupar os envios de um
  mesmo digest (migration aditiva, hand-authored, padrão `add-target-channel`).
- **Rollback sem deploy:** `WA_DIGEST_SIZE=1` + `MAX_DEALS_PER_RUN_WA=3`
  reproduzem o comportamento atual (1 oferta por mensagem, 3 por tick).
- Falha no envio do digest = falha única do job (retry do BullMQ); os deals do
  digest só marcam dedup/`SentMessage` após envio confirmado, como hoje.

### 4. LLM único: DeepSeek (sem Groq)

Decisão do usuário: **só DeepSeek, sempre** — um provedor, uma chave, uma
fatura.

- Novo `deepseek-headline.adapter.ts` implementa o `HeadlinePort` existente
  contra a mesma API OpenAI-compatible já usada pelo juiz (reutiliza padrão de
  client/timeout do `DeepSeekJudgeAdapter`).
- Factory do `HeadlineModule` passa a chavear por `DEEPSEEK_API_KEY`
  (sem chave → noop, comportamento de fallback atual preservado).
- `groq-headline.adapter.ts` e `GROQ_API_KEY` removidos (adapter morto não
  fica no código; git preserva histórico).
- `headline-cache` e `static-hook-pool` inalterados.
- Custo headline via DeepSeek: ~50 ofertas/dia × (~400 in + ~100 out tokens)
  ≈ 0,75M tokens/mês ≈ **< R$ 2/mês**.

### 5. Env novo

```
SHOPEE_APP_ID=
SHOPEE_APP_SECRET=
SHOPEE_DISPATCH_ENABLED=false
MAX_DEALS_PER_RUN_WA=4
MAX_DEALS_PER_RUN_TELEGRAM=10
WA_DIGEST_SIZE=4
JUDGE_MAX_CALLS_PER_TICK=20
```

Removido: `GROQ_API_KEY` (headline migra para DeepSeek).

### 6. Ordem de entrega

1. **Headline → DeepSeek** — troca de adapter isolada, remove dependência Groq.
2. **Teto por canal** — destrava volume no Telegram só com ML. Sem dependência externa.
3. **Digest WA** — multiplica ofertas/dia no canal principal sem novo risco.
4. **Adapter Shopee** — destravado pela aprovação no programa de afiliados
   (enquanto isso, 1–3 já rodam com ML).

### Error handling

- Shopee API fora/erro de assinatura → `discover()` loga e devolve `[]`;
  tick segue só com ML (fontes são independentes).
- Juiz continua fail-closed; teto por tick agora 20.
- Escrita de auditoria continua try/catch sem derrubar pipeline.
- Digest com envio falho não marca dedup — deals voltam no próximo tick.

### Testes

- `shopee-source.service.spec`: fetch mockado — assinatura correta, mapping
  `productOfferV2 → RawDeal`, erro HTTP → `[]`, sem credencial → fonte ausente.
- Gate: corte por canal (WA 4 / Telegram 10), `stage='source_warmup'` quando
  `SHOPEE_DISPATCH_ENABLED=false`, budget do juiz a 20.
- Formatter digest: N blocos ordenados por score, variante por oferta,
  `WA_DIGEST_SIZE=1` = caption atual, selo de preço por oferta.
- Enqueue: 1 job digest por target WA × 1 job por oferta no Telegram;
  `digestId` propagado até `SentMessage`.
- `deepseek-headline.adapter.spec`: fetch mockado — headline ok, erro/timeout
  → fallback estático (paridade com o spec do adapter Groq que sai).
- Specs existentes do pipeline atualizados (tetos por canal na injeção).

## Fora de escopo (YAGNI)

- Ramp de envios do WA (4→8–10/dia) e multi-chip/multi-sessão Baileys —
  candidatos a fase futura.
- Amazon, AliExpress, Magalu — depois da Shopee provada.
- Matching de produto cross-marketplace.
- Tracking de clique próprio (segue candidato de fase futura, como na Fase 2).
- Digest no Telegram.
