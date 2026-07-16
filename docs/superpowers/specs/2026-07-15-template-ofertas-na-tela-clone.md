# Spec — Template "Ofertas na Tela" (clone de formato)

Data: 2026-07-15
Status: aprovado (brainstorming)

## Objetivo

Reproduzir o formato de mensagem do grupo de referência "Ofertas na Tela"
(t.me/ofertasnatela) no nosso bot. O usuário validou o formato deles e quer que
todo post do bot saia com o mesmo layout flat.

## Formato de referência (observado)

ML:

```
#MercadoLivre
PRA DAR AQUELE TALENTO NA BARBA OU CABELO 🔥

➡️ Aparador De Pelos Super Groom 10 Mondial 6W Bivolt

✅ R$ 87 NO PIX
🎟️ Use o cupom: SHOWNOCAMPO
🛒 Link: https://meli.la/1ZT7fww
```

Shopee muda 2 linhas: cupom = link de resgate (não temos API → fora de escopo),
e `🛒 Link do produto:` em vez de `🛒 Link:`.

Sem disclaimer. Sem frete grátis, De/Por, badge de confiança, histórico, seller.

## Decisões travadas

1. **Substitui tudo.** Um único template flat para ML + Shopee. Mata os 6
   templates (good/top/super × A/B). Nível só muda o emoji do hook.
2. **Preço "NO PIX" honesto.** Tem `priceView.pixPriceCents` → `✅ R$ X NO PIX`.
   Não tem → `✅ R$ X à vista` (mesmo emoji verde, sem claim falso de PIX).
3. **Sem disclaimer.** Usuário assumiu (compliance de afiliado). Removido de
   `formatScored` e `formatDigest`.
4. **Hashtag por source.** `ml` → `#MercadoLivre`, `shopee` → `#Shopee`.
5. **FULL.** ML com `logistic_type === 'fulfillment'` mostra `⚡ FULL`. Shopee nunca.
6. **PIX verde.** Linha de preço usa `✅` (mesmo do grupo, passa impressão de barato).

## Layout final

```
{hashtag}                       ← #MercadoLivre | #Shopee
{HOOK EM CAIXA ALTA} {emoji}    ← headline atual .toLocaleUpperCase('pt-BR'); só se houver hook

➡️ {título}
⚡ FULL                          ← só se signals.isFull

✅ R$ {int} NO PIX               ← pixPrice presente
✅ R$ {int} à vista              ← fallback sem pixPrice
🎟️ Use o cupom: {code}          ← só se couponView
🛒 {linkLabel} {link}            ← "Link:" (ml) | "Link do produto:" (shopee)
```

- **Sem** linha de disclaimer no final.
- **Emoji do hook por nível:** good `🔥`, top `🔥🔥`, super `🚨` (ajustável).
- **Preço:** inteiro, `Math.floor(cents/100)`, `toLocaleString('pt-BR')` p/ separador
  de milhar (`4.846`), prefixo `R$ `. Floor nunca superfatura o claim.
- **Cupom:** só o código. Dropa `mode`/`finalCents`/`validUntil`/`minCents` da
  renderização (o worker já filtra cupom expirado antes de passar).

## Plumbing do FULL (4 arquivos)

| Arquivo                                                   | Mudança                                                                               |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `src/mercado-livre/ml.service.ts` (`tryBuildDeal`, ~l.78) | `DealItem` recebe `isFull: best.shipping?.logistic_type === 'fulfillment'`            |
| `src/mercado-livre/types.ts`                              | `DealItem.isFull: boolean`                                                            |
| `src/sources/mercado-livre/mapping.ts` (`toEnrichedDeal`) | popula `signals.isFull` a partir de `DealItem`; `fallbackDealItem` e Shopee = `false` |
| `src/sources/source.port.ts`                              | `EnrichedDeal.signals.isFull: boolean` (obrigatório)                                  |

Notas:

- `isFull` obrigatório em `signals` → todos os fixtures/specs que constroem
  `signals` precisam adicionar `isFull` (o TS força).
- `ml-source.service.ts` propaga `dealItems[i].isFull` no `toEnrichedDeal` (hoje
  passa só `freeShipping`; adicionar arg ou ler do DealItem dentro do mapping).
- `fallbackDealItem` (`ml-source.service.ts:93`) precisa `isFull: false`.
- Shopee `mapping.ts` seta `isFull: false`.

## Arquivos removidos / reescritos

**Remove:**

- `src/pipeline/templates/template-good.ts`
- `src/pipeline/templates/template-top.ts`
- `src/pipeline/templates/template-imperdivel.ts`
- `src/pipeline/templates/variants.ts` (A/B)

**Novo:**

- `src/pipeline/templates/template-ofertas.ts` — layout acima. Assinatura recebe
  `ScoredDeal`, `formatBRL`/helpers, `link`, `hook`, `priceView`, `couponView`.
- Helpers `sourceHashtag(source)` e `linkLabel(source)` (no template ou em
  `templates/index.ts`).

**`src/pipeline/templates/index.ts`:**

- Remove `templatesByLevel` / re-exports de good/top/imperdivel.
- Exporta o template único.

**`src/pipeline/formatter.service.ts`:**

- `formatScored`: usa o template único; **ignora `variant`** (param mantido na
  assinatura como no-op p/ não quebrar o worker); dropa `disclaimerLine()`;
  move a lógica de preço PIX/à-vista e cupom-só-código pra cá ou pro template.
- `injectPriceExtras`/`priceExtraLines`/`couponLine`/`appendCouponLine`: revisar —
  a linha de preço nova substitui `injectPriceExtras`. Cupom vira só código.
- `formatDigest`: bloco no formato clone, **sem disclaimer**. Remove branch De/Por
  (variante B). Nota: `WA_DIGEST_SIZE=1` → path single (`formatScored`) domina;
  digest fica coerente mas dormente.
- `formatItem` (legacy, `fireTemplate`): **sem caller vivo em prod**. Deixar como
  está (fora de escopo) ou remover junto — decisão na fase de plano.

## A/B (variant) — neutralizado, não ripado

- `variant` continua correndo por `pipeline.service.ts` → `queue.types.ts` →
  `send-deal.worker.ts`, mas o **formatter ignora**. Campo vira no-op.
- `pickVariant` / `shared/variant.ts` ficam vestigiais. Cleanup total do plumbing
  A/B = follow-up opcional (fora de escopo desta spec) p/ manter o diff focado no
  output e reduzir churn de teste.

## Testes (TDD)

Specs que quebram e precisam reescrita pro novo formato:

- `formatter.service.spec.ts` (layout, disclaimer removido, preço PIX/à vista)
- `formatter-digest.spec.ts`
- `formatter-variant.spec.ts` (A/B) → simplifica/remove (variant no-op)
- `formatter-trust-badge.spec.ts` (trust line removida do output)
- specs de template good/top/imperdivel → removidos com os arquivos

Novos:

- `template-ofertas.spec.ts`: hashtag por source, título `➡️`, FULL on/off,
  preço PIX vs à vista, cupom só-código, label de link ML vs Shopee, sem disclaimer,
  emoji de hook por nível, hook uppercased, hook ausente omite linha.
- mapping/plumbing: `isFull` verdadeiro quando `logistic_type==='fulfillment'`,
  falso caso contrário e no Shopee.

## Riscos

- **Disclaimer removido** = decisão do usuário (compliance de afiliado).
- **A/B efetivamente morto** para medição (escolha "substitui tudo").
- **Claim "NO PIX"** protegido: só quando o scraper entregou `pixPriceCents`.
- **Fora de escopo:** cupom Shopee via link de resgate (sem API — fase 2), fonte
  Amazon (não existe), rip total do plumbing A/B.
