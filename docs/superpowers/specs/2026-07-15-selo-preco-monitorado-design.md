# Selo de preço monitorado — design

**Data:** 2026-07-15
**Status:** aprovado (brainstorm de diferenciais pós-Fase 2)

## Contexto

O grupo de promoções nasce do zero e precisa de um diferencial competitivo que
funcione com qualquer número de membros e 100% automatizado. Fraqueza escolhida
para atacar (observada nos grupos concorrentes): oferta ruim/expirada e
desconto falso — alegações de "menor preço" sem lastro.

O bot já possui o ativo que nenhum concorrente tem: histórico de preço próprio
(`PriceHistory`, warmup contínuo) e um gate de curadoria que bloqueia desconto
falso (Fase 2). Este design torna esse lastro **visível no post**.

## Objetivo

Todo post cuja oferta tem histórico suficiente sai com uma linha de prova:

```
📉 Menor preço em 30 dias ✓ monitorado há 42 dias
```

(Texto do rótulo é o retorno literal de `getLowestPriceBadge` — "Menor preço
em 30/14/7 dias" — acrescido do sufixo de proveniência.)

Concorrente afirma; nós mostramos há quanto tempo vigiamos o preço.

## O que muda no post

Exemplo (nível top, variante A):

```
🔥 PROMOÇÃO TOP
{hook}

📦 Echo Dot 5ª geração
💰 *R$ 279,00* (-38%)
12x sem juros · 🚚 frete grátis

📉 Menor preço em 30 dias ✓ monitorado há 42 dias

🛒 {link}

_🔗 Link de afiliado. Preço visto às 14:32 — sujeito a alteração._
```

- A linha de histórico existente (`pickHistoryLine`, baseada em reasons do
  score) é substituída pela linha de selo **quando houver selo**; sem selo,
  a linha atual permanece como fallback. Nada regride.
- Vale para os três níveis de template (`super`/`top`/`good`) e para as duas
  variantes de copy (A e B). A linha é idêntica nas duas variantes — não
  contamina o experimento A/B.
- Decisão de produto: **sem** nota/score numérico no post (proposto e
  rejeitado pelo dono em 2026-07-15).

## Fluxo de dados

Cálculo no **enqueue** (pipeline), transporte no **payload** do job:

1. `SendDealJob` ganha campo opcional:
   ```ts
   trustBadge?: { label: string; monitoredDays: number }
   ```
   Mesmo contrato de compatibilidade do campo `variant?`: job antigo no Redis
   sem o campo se comporta como hoje.
2. No enqueue, o pipeline consulta `CurationService.getLowestPriceBadge(catalogId, priceCents)`
   e `CurationService.historyDays(catalogId)` (métodos públicos, síncronos,
   cache em memória — sem round-trip de DB no caminho de dispatch).
   Badge `null` → campo ausente.
3. `SendDealWorker` repassa o campo para `FormatterService.formatScored(scored, variant, trustBadge)`.
4. Os templates renderizam `{label} ✓ monitorado há {monitoredDays} dias`.

Alternativa rejeitada: formatter injetar `CurationService` e calcular na hora
do format. Dado ligeiramente mais fresco, mas acopla o formatter ao store de
curadoria, quebra se o worker sair do processo e engorda os testes do
formatter. O gap enqueue→send é de minutos e o disclaimer já carimba o horário
do preço.

## Feature flag

`TRUST_BADGE_ENABLED` (default `true`). Com `false`, o pipeline nunca preenche
`trustBadge` e os posts saem idênticos aos de hoje. Mesmo padrão de rollback do
`COPY_AB_ENABLED`. Flag lida via `ConfigService` em service existente — sem
`@Injectable` novo com constructor de números-com-default (lição da Fase 2).

## Edge cases

- **Warmup insuficiente** (`historyDays < CURATION_MIN_HISTORY_DAYS`):
  `getLowestPriceBadge` retorna `null` → sem selo → fallback na linha atual.
  O selo aparece organicamente quando o warmup amadurece; nunca finge lastro.
- **Job pré-upgrade** no Redis: campo ausente → comportamento atual.
- **`formatItem` legado** (já aceita `lowestPriceBadge: string`): intocado.

## Testes

- Templates: com `trustBadge` → linha de selo (3 níveis × 2 variantes);
  sem → fallback atual.
- Pipeline: preenche `trustBadge` quando badge existe; omite quando `null`;
  omite quando `TRUST_BADGE_ENABLED=false`.
- Worker: repassa o campo intacto ao formatter.
- Suite existente (201 testes) permanece verde + smoke de boot real no
  container (unit test não pega crash-loop de DI).

## Fora de escopo (backlog do brainstorm)

Ideias levantadas na mesma sessão, não escolhidas agora:

- **B5 — re-verificação pós-post**: job re-checa oferta 1h/6h/24h depois e
  responde `⚠️ ENCERROU` quando morre. Candidata natural à próxima iteração.
- **B6 — placar de acerto público**: resumo semanal automático de taxa de
  ofertas ainda válidas (dados já existem em `CurationDecision`/`SentMessage`).
- **B7 — "reprovadas da semana"**: expor oferta bloqueada pelo gate e o porquê
  (reasoning do juiz). Esperar warmup ≥ 30d.
- **A3 — modo fundo histórico**, **A4 — copy com contexto do histórico**,
  **C8 — cota fixa baixa**, **C9 — digest do dia**.
- **Tracking de clique/link próprio**: descartado para Fase 3 (decisão
  anterior ao brainstorm).
