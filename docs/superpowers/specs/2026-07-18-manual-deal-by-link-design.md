# Composer de deal manual — colar link, editar tudo, fila ou dispara já

**Data:** 2026-07-18
**Status:** aprovado (brainstorming)
**Issue relacionada:** #8 (manual ML deal, já mergeado em main)

## Problema

O backend já tem `POST /approval/manual/resolve {url}`: cola link ML, scrape
(título/imagem/preço/parcelas), **cria card pendente na fila**. O operador quer
mais: colar um link (inclusive `meli.la` encurtado), ver o card montado, **editar
qualquer coisa** (imagem, texto, preço, cupom, link) e escolher **fila** ou
**dispara já** — tudo num fluxo só, com UI/UX caprichada. E poder montar um deal
100% na mão, sem link.

Lacunas do estado atual:

1. **Short link quebra.** `extractMlId` (`ml-manual-resolver.ts`) roda na string
   crua e exige `MLB\d+`. Link curto (`meli.la/xxx`) não tem MLB → `invalid_url`
   antes do scrape.
2. **Sem edição antes de enviar.** `resolveUrl` cria o card direto na fila. Não há
   momento de revisar/editar imagem, texto, preço, cupom, link antes de decidir.
3. **Sem "fila OU dispara já" em 1 ação.** Disparar exige aprovar urgent no card
   depois (2 passos).
4. **Sem UI no painel.** Endpoint existe, `web/` (main) não tem tela.
5. **Sem post 100% manual pela UI.** `createGeneric` existe no backend mas sem
   tela e sem dispatch.

## Objetivo

Uma tab **"Novo deal"** no painel: cola link → auto-preenche → edita tudo →
**Pra fila** ou **Dispara já**. Link opcional (dá pra montar do zero). Preview ao
vivo idêntico ao post real.

## Decisões (brainstorming)

- **Layout:** split — form à esquerda, preview WhatsApp/Telegram ao vivo à direita.
- **Short link:** expandir via redirect HTTP (follow 302), sem browser extra.
- **Imagem:** colar URL apenas. Sem upload/storage.
- **Post sem link:** suportado (link opcional), reusa `createGeneric`. Composer
  universal (qualquer loja).
- **Texto:** campos estruturados (título, De, Por PIX, parcelas, cupom) → o
  template monta a caption (padrão De riscado / Por PIX / parcelas / FULL). Sem
  override de caption livre.
- **Dispatch:** submit unificado com flag `dispatch`; um request cria + urgent.
- **Cupom:** campo manual no composer. Sem scrape de cupom (ML sem API confiável
  — memórias `ml-coupons-v1`, `ml-items-403-non-owned`).
- **Polish visual:** delegado à skill `frontend-design` na implementação.

## Design

### Contrato backend (muda o atual)

O `resolve` deixa de criar card; passa a devolver **campos pra preencher**. A
criação vira um submit separado, depois da edição.

**1. `POST /approval/manual/resolve` → prefill (não cria card)**

Body: `{ url }`. Retorna os campos resolvidos pra popular o form:

```ts
// ResolvedManualView
{
  source: 'ml',
  title: string,
  priceCents: number,
  originalPriceCents: number | null,
  discountPercent: number,
  thumbnail: string,
  permalink: string,        // URL expandida/canônica
  installmentsNoInterest: boolean,
}
```

Erros mantêm o padrão: `invalid_url` (400), `scrape_failed` (422),
`unsupported_url` (400). Nenhum card é criado em nenhum caminho.

**2. `POST /approval/manual/preview` → caption ao vivo (novo, stateless)**

Body: os campos do form (mesmo shape do submit, sem `dispatch`). Monta um
`ScoredDeal` sintético via `toScoredDeal`, roda `renderCaption`, retorna
`{ caption, imageUrl }`. **Não** cria, decide nem enfileira nada. O painel chama
com debounce a cada edição — o preview bate 100% com o que dispara (zero drift
de template no client).

**3. `POST /approval/manual` → submit unificado (estende `createGeneric`)**

Body:

```ts
// CreateManualDealDto
{
  store: string,                    // 'ml' | 'shopee' | 'outro'…
  title: string,
  priceCents: number,               // Por PIX / à vista
  originalPriceCents?: number,      // De
  installmentsNoInterest?: boolean,
  coupon?: { code: string; finalCents?: number },  // CuratorCouponEdit (issue #6)
  thumbnail: string,                // URL da imagem
  permalink?: string,               // LINK OPCIONAL — sem link = post manual puro
  dispatch?: boolean,               // default false
}
```

Comportamento:

1. Monta `ResolvedManualDeal` a partir dos campos (deriva `discountPercent` de
   De vs Por, igual `createGeneric` hoje) → `toScoredDeal` → `createManual` →
   card `{ id, ... }`.
2. `dispatch === false` → retorna o card pendente (`PendingSummary`).
3. `dispatch === true` → `approve(id, edits, { urgent: true })` no mesmo request;
   retorna `{ id, catalogId, enqueued, targets }`.

**Dedup no dispatch:** deal postado < `DEDUP_WINDOW_DAYS` → `approve` urgent
lança `409 recently_posted`. **Não** forçamos override silencioso. O card já foi
criado por `createManual` e **fica pendente** na fila; o painel mostra o aviso e
o operador confirma urgent + override no card. Zero perda, zero bypass mudo.

### Short-link expander

Nova unidade `expandShortUrl(url): Promise<string>`:

- Host curto (`meli.la`) → HTTP `GET` com follow de redirect (limite ~5 saltos),
  retorna a URL final. Timeout ~5s.
- Qualquer falha (rede, timeout, sem Location) → devolve a URL **original**
  (degrada limpo: `extractMlId` falha depois → `invalid_url`, sem card fantasma).
- Fetch injetado (port/fn) pra o spec mockar redirects sem rede.

`MlManualResolver.resolve(url)`:

1. `id = extractMlId(url)`.
2. `id == null` e host curto → `expanded = await expandShortUrl(url)`;
   `id = extractMlId(expanded)`; usa `expanded` dali pra frente.
3. Ainda `null` → `ManualResolveError('invalid_url', …)`.
4. Scrape na URL expandida; `permalink` = URL expandida.

### Painel (`web/`) — tab "Novo deal", layout split

- **Nav:** nova tab ao lado de pending/history/config.
- **Barra de colar:** input link + botão **Resolver** (opcional). Estados:
  idle / resolvendo (spinner) / erro (mensagem do backend, link ruim/ilegível).
- **Form (esquerda):** Título, De, Por PIX, Parcelas (toggle sem juros), Cupom
  (código + valor), Imagem (URL), Link (opcional). Preenchido pelo resolve,
  editável.
- **Preview (direita):** reusa `CaptionPreview`, alimentado por
  `POST /approval/manual/preview` com debounce (~400ms) a cada edição.
- **Ações:** **➕ Pra fila** (dispatch=false) / **⚡ Dispara já** (dispatch=true).
- **Feedback:**
  - Fila → toast "na fila", card aparece em pending.
  - Dispatch → toast "disparado" (`enqueued`/`targets`).
  - `recently_posted` no dispatch → aviso "já postado há N dias; card ficou na
    fila, confirme urgent lá".
- **Validação client:** título + Por PIX + imagem obrigatórios; link/De/cupom
  opcionais. Erros de campo inline.

### Reuso

`toScoredDeal`, `renderCaption`, `approve` (urgent/dedup), `createManual`,
`CouponService` / cupom manual (issue #6), `CaptionPreview`, `DealCard`,
`api.ts` (padrão request + erros tipados).

## Fora de escopo

- Upload de arquivo de imagem (só URL).
- Scrape de cupom (ML sem API confiável).
- Override de caption livre (só campos estruturados).
- Auto-override de dedup no dispatch.
- Outras lojas com resolver dedicado (novo resolver na array, sem tocar o
  service) — o composer manual já cobre qualquer loja via campos.

## Arquivos tocados

**Backend:**
- `src/curation/dto/resolve-manual.dto.ts` — resolve continua `{ url }`.
- `src/curation/dto/create-manual-deal.dto.ts` — novo (estende create-generic com
  parcelas/cupom/dispatch; permalink opcional).
- `src/curation/dto/preview-manual.dto.ts` — novo (campos sem dispatch).
- `src/curation/manual/manual-deal.service.ts` — `resolveUrl` retorna prefill
  (não cria card); `preview(fields)`; `submit(dto)` com dispatch.
- `src/curation/manual/ml-manual-resolver.ts` — expandir short link.
- `src/curation/approval.controller.ts` — rotas resolve / preview / submit.
- `src/curation/manual/url-expander.ts` — novo (`expandShortUrl` + port/fn) +
  wiring no module.

**Frontend (`web/`):**
- `web/src/components/ManualComposer.tsx` — novo (split form + preview + ações).
- `web/src/api.ts` — `resolveManual`, `previewManual`, `submitManual`.
- `web/src/App.tsx` — tab "Novo deal".
- `web/src/types.ts` — tipos do composer.

**Testes:**
- `url-expander` spec (redirect mockado, timeout, falha → URL original).
- `ml-manual-resolver` spec (short link → id via expansão; link direto igual).
- `manual-deal.service` spec (resolve retorna prefill sem card; preview stateless;
  submit dispatch=true → approve urgent; dispatch=false → card; 409 dedup → card
  pendente; submit sem link → post manual).

## Verificação (live e2e)

Após implementar + rebuild container + migrate (se aplicável):
- Colar `meli.la` curto → form preenchido; editar imagem/preço/cupom → preview
  atualiza.
- Dispara já → post nos 2 alvos (grupo WA teste + Telegram), com edições.
- Pra fila → card em pending com as edições.
- Post sem link (manual puro) → dispara/fila normal.
- Link inválido → erro limpo, sem card.
- Deal repetido no dispatch → 409, card fica pendente.
