# Deal manual por link — resolve + dispatch em 1 tiro

**Data:** 2026-07-18
**Status:** aprovado (brainstorming)
**Issue relacionada:** #8 (manual ML deal, já mergeado em main)

## Problema

Hoje o backend já tem `POST /approval/manual/resolve {url}`: cola link de produto
ML, scrape (título/imagem/preço à vista/parcelas), cria card **pendente** na fila
de aprovação. Três lacunas impedem o fluxo que o operador quer — "colo o link e
ele já dispara":

1. **Short link quebra.** `canResolve` casa `meli.la`, mas `extractMlId`
   (`ml-manual-resolver.ts`) roda na string crua e exige `MLB\d+`. Link curto não
   tem MLB → retorna null → lança `invalid_url` **antes** do scrape. O operador
   manda link encurtado (`meli.la/xxx`) e nunca funciona.
2. **Não há "fila OU dispara já" em 1 ação.** `resolveUrl` sempre cai em
   `createManual` → card pendente. Pra disparar imediato: resolve, depois clica
   urgent no card (2 passos, 2 requests).
3. **Sem UI no painel.** O endpoint existe mas `web/` (main) não tem tela pra
   colar link. Só dá pra chamar via HTTP direto.

## Objetivo

Operador cola um link ML (inclusive `meli.la` encurtado), o card é montado
automático (título/imagem/preço/parcelas) e ele escolhe **fila** ou **dispara
já** nos canais — num único fluxo pelo painel.

## Decisões (brainstorming)

- **Short link:** seguir redirect via HTTP (GET/HEAD com follow de 302). Barato,
  sem browser extra.
- **Dispatch:** flag `dispatch` no endpoint resolve. Um request resolve + urgent.
- **Cupom:** manual, só via edit no card (issue #6 já existe). Sem scrape de cupom
  (ML sem API confiável — ver memória `ml-coupons-v1`, `ml-items-403-non-owned`).

## Design

### 1. Expandir short link

Nova unidade `expandShortUrl(url): Promise<string>`:

- Se o host for curto (`meli.la`), faz HTTP `GET` com follow de redirect (limite
  ~5 saltos), retorna a URL final resolvida.
- Timeout ~5s. Qualquer falha (rede, timeout, non-2xx sem Location) → devolve a
  URL **original** inalterada (degrada limpo: `extractMlId` falha depois e vira
  `invalid_url`, sem card fantasma).
- Não é ML-específico no conceito, mas v1 só reconhece `meli.la`. Outros
  encurtadores = adicionar host à lista.

**Testabilidade:** a função de fetch é injetada (port ou parâmetro), pra o spec
mockar redirects sem rede real.

`MlManualResolver.resolve(url)` passa a:

1. `id = extractMlId(url)`.
2. Se `id == null` **e** host é curto → `expanded = await expandShortUrl(url)`;
   `id = extractMlId(expanded)`; usa `expanded` dali pra frente.
3. Se ainda `null` → `ManualResolveError('invalid_url', …)` (comportamento atual).
4. Scrape roda na URL expandida. `permalink` = URL expandida (afiliado e chave de
   dedup batem a URL canônica, alinham com deals do pipeline).

### 2. Flag `dispatch`

`ResolveManualDto`:

```ts
export class ResolveManualDto {
  @IsString() @IsUrl(...) url!: string;
  @IsOptional() @IsBoolean() dispatch?: boolean; // default false
}
```

`ManualDealService.resolveUrl(url, dispatch = false)`:

1. Resolve + `createManual(sd)` → `pending {id, ...}` (igual hoje).
2. Se `dispatch === true` → `approvalQueue.approve(pending.id, undefined, { urgent: true })`
   no mesmo request. Fura quiet hours, dispara já nos canais.
3. Se `dispatch === false` → retorna o card pendente (fluxo atual).

Retorno: fila → `PendingSummary`; dispatch → o resultado de `approve`
(`{id, catalogId, enqueued, targets}`). Controller devolve o que o service retornar.

**Dedup no dispatch:** se o deal foi postado < `DEDUP_WINDOW_DAYS`, `approve`
urgent lança `409 recently_posted` (não passa `dedupOverride`). **Não** forçamos
override silencioso. O card já foi criado por `createManual` e **fica pendente**
na fila; o painel mostra o aviso de dedup e o operador confirma urgent + override
no card. Zero perda, zero bypass mudo.

### 3. Cupom

v1: cupom só via edit no card (issue #6). Consequência:

- Quer cupom → path **fila**: resolve (dispatch=false) → edita cupom no card →
  urgent-send.
- `dispatch=true` = **sem cupom** (uso comum: disparo rápido sem cupom).

`ResolveManualDto` fica `{url, dispatch?}` — sem campo de cupom. Cupom one-shot
fica pra iteração futura se pedido.

### 4. Painel (`web/`)

Nova UI de "deal manual por link" (não existe em main):

- Input de link (colar URL/short link).
- Toggle **Fila** / **Dispara já** (mapeia `dispatch`).
- Botão enviar → `POST /approval/manual/resolve {url, dispatch}`.
- Feedback:
  - Sucesso fila → card aparece na lista de pendentes.
  - Sucesso dispatch → confirmação "disparado" (`enqueued`/`targets`).
  - Erro `invalid_url` / `scrape_failed` → mensagem do backend (link ruim / página
    ilegível).
  - Erro `recently_posted` no dispatch → aviso "já postado há N dias; card ficou
    na fila, confirme urgent lá".

## Fora de escopo

- Scrape de cupom (ML sem API confiável).
- Cupom em disparo one-shot (só via card na fila por ora).
- Outras lojas (novo resolver na array `MANUAL_RESOLVERS`, sem tocar o service).
- Auto-override de dedup no dispatch.

## Arquivos tocados

**Backend:**
- `src/curation/dto/resolve-manual.dto.ts` — add `dispatch?`.
- `src/curation/manual/manual-deal.service.ts` — `resolveUrl(url, dispatch)`.
- `src/curation/manual/ml-manual-resolver.ts` — expandir short link antes do
  extractMlId.
- `src/curation/approval.controller.ts` — passar `dispatch` do body.
- Nova unidade de expansão de URL (`url-expander` fn/port) + wiring no module.

**Frontend (`web/`):**
- Componente de deal manual por link (input + toggle + submit + feedback).
- `web/src/api.ts` — chamada resolve.
- `web/src/App.tsx` — montar o componente.

**Testes:**
- Spec do expander (redirect mockado, timeout, falha → URL original).
- Spec do resolver (short link → id via expansão; link direto inalterado).
- Spec do service (dispatch=true → approve urgent; dispatch=false → card;
  409 dedup → card fica pendente).

## Verificação (live e2e)

Após implementar + rebuild container + migrate (se aplicável):
- Colar `meli.la` curto, dispatch=false → card montado na fila.
- Mesmo link, dispatch=true → disparo nos 2 alvos (grupo WA teste + Telegram).
- Link inválido → erro limpo, sem card.
- Deal repetido no dispatch → 409, card fica pendente.
