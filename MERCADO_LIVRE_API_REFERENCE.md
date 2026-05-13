# Mercado Livre API — Referência Completa

> Documento de contexto para uso com Claude em projetos de integração com a plataforma Mercado Livre, especialmente para construção de bots de promoção e ferramentas de afiliado.
>
> **Site Brasil:** `MLB` · **Base URL:** `https://api.mercadolibre.com`
> **Auth URL Brasil:** `https://auth.mercadolivre.com.br`
> **DevCenter:** `https://developers.mercadolivre.com.br/devcenter`

---

## Índice

1. [Visão geral e fatos importantes](#1-visão-geral-e-fatos-importantes)
2. [O que NÃO existe na API](#2-o-que-não-existe-na-api)
3. [Autenticação OAuth 2.0](#3-autenticação-oauth-20)
4. [APIs públicas (sem token)](#4-apis-públicas-sem-token)
5. [Busca de itens — endpoint principal para bots de promoção](#5-busca-de-itens--endpoint-principal-para-bots-de-promoção)
6. [Detalhe de itens](#6-detalhe-de-itens)
7. [Preços e promoções](#7-preços-e-promoções)
8. [Categorias](#8-categorias)
9. [Highlights, Trends, Hot Items](#9-highlights-trends-hot-items)
10. [APIs autenticadas relevantes](#10-apis-autenticadas-relevantes)
11. [Webhooks / Notificações](#11-webhooks--notificações)
12. [Rate limits e erros](#12-rate-limits-e-erros)
13. [Sites IDs e códigos de país](#13-sites-ids-e-códigos-de-país)
14. [IDs de categorias MLB (Brasil)](#14-ids-de-categorias-mlb-brasil)
15. [Programa de Afiliados — realidades operacionais](#15-programa-de-afiliados--realidades-operacionais)
16. [Padrões de uso e anti-patterns](#16-padrões-de-uso-e-anti-patterns)
17. [Receitas prontas para bots de promoção](#17-receitas-prontas-para-bots-de-promoção)

---

## 1. Visão geral e fatos importantes

- A API do Mercado Livre é REST sobre HTTPS, JSON.
- **Base URL única para todos os países:** `https://api.mercadolibre.com` (note: `mercadolibre`, não `mercadolivre`).
- O **site** é distinguido pelo path/parâmetro `MLB` (Brasil), `MLA` (Argentina), `MLM` (México), etc.
- A maior parte dos endpoints de leitura é **pública (não exige token)**, mas com rate limit mais agressivo.
- Endpoints privados exigem OAuth 2.0 com `Authorization: Bearer {access_token}`.
- **Access token válido por 6 horas** (`expires_in: 21600`).
- Refresh token é **single-use**: cada refresh gera um novo refresh_token e invalida o anterior.
- Scope padrão: `offline_access read write`.

---

## 2. O que NÃO existe na API

Documentar essas lacunas evita perda de tempo:

- ❌ **Geração programática de link de afiliado** (`mercadolivre.com/sec/...`) — não há endpoint. Só via painel web manual ou scraping autenticado do painel.
- ❌ **Consulta de cliques/comissões/conversões de afiliado** — não há endpoint público.
- ❌ **Lista oficial de "ofertas do dia"** como recurso REST direto — precisa ser inferida via `/sites/MLB/search?discount=...`.
- ❌ **Webhook de mudança de preço público** — só funciona para sellers autenticados em seus próprios itens (topic `items_prices`).
- ❌ **API de carrinho/compra programática** para terceiros.

---

## 3. Autenticação OAuth 2.0

### Fluxo: Authorization Code Grant (Server Side)

**Passo 1 — Redirect do usuário para autorização:**

```
GET https://auth.mercadolivre.com.br/authorization
    ?response_type=code
    &client_id={APP_ID}
    &redirect_uri={REDIRECT_URI}
    &state={CSRF_TOKEN}
```GG

`redirect_uri` deve ser EXATAMENTE igual à URL cadastrada no DevCenter (HTTPS obrigatório, sem query string variável).

**Passo 2 — Receber callback com `code` e trocar por token:**

```http
POST https://api.mercadolibre.com/oauth/token
Content-Type: application/x-www-form-urlencoded
Accept: application/json

grant_type=authorization_code
&client_id={APP_ID}
&client_secret={CLIENT_SECRET}
&code={AUTHORIZATION_CODE}
&redirect_uri={REDIRECT_URI}
```

**Resposta:**

```json
{
  "access_token": "APP_USR-5387223166827464-090515-8cc4448aac10d5105474e135355a8321-8035443",
  "token_type": "bearer",
  "expires_in": 21600,
  "scope": "offline_access read write",
  "user_id": 8035443,
  "refresh_token": "TG-5b9032b4e4b0714aed1f959f-8035443"
}
```

> ⚠️ O `code` é **single-use** e expira em poucos minutos. Se for usado 2x, retorna `invalid_grant`.

**Passo 3 — Refresh token (antes de expirar os 6h):**

```http
POST https://api.mercadolibre.com/oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token
&client_id={APP_ID}
&client_secret={CLIENT_SECRET}
&refresh_token={CURRENT_REFRESH_TOKEN}
```

**Resposta:** mesmo payload acima, **com um NOVO `refresh_token`**. Persista imediatamente — o antigo já está revogado.

### Usando o access token

```http
GET https://api.mercadolibre.com/users/me
Authorization: Bearer APP_USR-...
```

### O que invalida tokens antes da expiração

- Usuário muda senha
- App tem o secret renovado
- Usuário revoga permissões no painel
- App não faz nenhuma requisição por 4 meses
- Fraude detectada / desvinculação de dispositivo

### Erros OAuth principais

| Erro | Causa |
|---|---|
| `invalid_grant` | `code` ou `refresh_token` já usado, expirado, revogado, ou `redirect_uri` divergente |
| `invalid_scope` | Scope diferente de `offline_access`, `read`, `write` |
| `invalid_request` | Parâmetro faltando ou duplicado |
| `unsupported_grant_type` | `grant_type` deve ser `authorization_code` ou `refresh_token` |
| `local_rate_limited` (429) | Muitas chamadas em curto tempo, aguardar segundos |

---

## 4. APIs públicas (sem token)

Funcionam sem `Authorization`. Adequadas para bots de promoção que **só leem** o catálogo. Rate limit existe mas não é oficialmente publicado — recomendação prática: **≤ 10 req/s**, com backoff exponencial em 429.

Cobrem:
- Busca de itens (`/sites/{SITE}/search`)
- Detalhe de itens (`/items/{MLB_ID}`)
- Categorias
- Highlights e trends
- Info pública de seller
- Currencies, sites, países

---

## 5. Busca de itens — endpoint principal para bots de promoção

### Endpoint

```
GET /sites/MLB/search
```

### Parâmetros principais

| Parâmetro | Tipo | Exemplo | Descrição |
|---|---|---|---|
| `q` | string | `q=iphone+15` | Texto livre |
| `category` | string | `category=MLB1055` | ID de categoria |
| `seller_id` | int | `seller_id=123456` | Filtra por vendedor |
| `official_store_id` | int / `all` | `official_store_id=all` | Lojas oficiais |
| `nickname` | string | `nickname=NIKE` | Vendedor por nickname |
| `price` | range | `price=100-500` | Faixa de preço |
| `condition` | string | `condition=new` ou `used` | Condição |
| `shipping_cost` | string | `shipping_cost=free` | Frete grátis |
| `discount` | range | `discount=20-100` | **% de desconto — chave para promoções** |
| `power_seller` | string | `power_seller=yes` | Só MercadoLíder |
| `installments` | string | `installments=no_interest` | Sem juros |
| `sort` | string | `sort=price_asc`, `price_desc`, `relevance` | Ordenação |
| `limit` | int | `limit=50` | Máx 50 |
| `offset` | int | `offset=50` | Paginação (máx total: 1000) |

### Exemplo: promoções de eletrônicos com 30%+ de desconto

```http
GET /sites/MLB/search?category=MLB1000&discount=30-100&power_seller=yes&limit=50
```

### Estrutura da resposta (campos relevantes)

```json
{
  "site_id": "MLB",
  "paging": {
    "total": 1234,
    "primary_results": 1000,
    "offset": 0,
    "limit": 50
  },
  "results": [
    {
      "id": "MLB1234567890",
      "title": "iPhone 15 Pro Max 256GB Titânio Natural",
      "condition": "new",
      "permalink": "https://www.mercadolivre.com.br/iphone-15-pro...",
      "thumbnail": "https://http2.mlstatic.com/D_NQ_NP_...jpg",
      "currency_id": "BRL",
      "price": 8499.00,
      "original_price": 11999.00,
      "sale_price": { "price_id": "...", "amount": 8499.00, "regular_amount": 11999.00 },
      "available_quantity": 1,
      "sold_quantity": 50,
      "seller": {
        "id": 123456789,
        "nickname": "LOJAEXEMPLO",
        "power_seller_status": "platinum",
        "car_dealer": false,
        "real_estate_agency": false
      },
      "shipping": {
        "free_shipping": true,
        "logistic_type": "fulfillment",
        "mode": "me2"
      },
      "attributes": [
        { "id": "BRAND", "name": "Marca", "value_name": "Apple" }
      ]
    }
  ],
  "available_filters": [],
  "available_sorts": []
}
```

### Campos críticos para filtrar promoção real

- `price` vs `original_price` → calcular % de desconto
- `seller.power_seller_status` → `platinum` / `gold` / `silver` / `null`
- `shipping.free_shipping` → boolean
- `shipping.logistic_type` → `fulfillment` (Full = entrega rápida ML), `cross_docking`, `drop_off`, `self_service`
- `available_quantity` → estoque
- `sold_quantity` → social proof

### Paginação

- Máximo 1000 resultados via `offset` clássico
- Para mais, **scan**: `search_type=scan&scroll_id={SCROLL_ID}` (apenas em `/users/{id}/items/search`)

---

## 6. Detalhe de itens

```http
GET /items/{MLB_ID}
GET /items/{MLB_ID}/description
GET /items?ids=MLB1,MLB2,MLB3              # batch até 20 IDs
GET /items/{MLB_ID}?attributes=id,title,price,pictures
```

**Importante:** o ML está **descontinuando** os campos `price`, `base_price` e `original_price` do `/items`. Use `/items/{id}/sale_price` ou `/items/{id}/prices` para preço atualizado.

---

## 7. Preços e promoções

### Sale price (preço final ao comprador)

```http
GET /items/{MLB_ID}/sale_price?context=channel_marketplace
```

Resposta:
```json
{
  "price_id": "1",
  "amount": 800,
  "regular_amount": 1000,
  "currency_id": "BRL",
  "reference_date": "2025-02-15T00:23:53Z",
  "conditions": { "context_restrictions": [] },
  "metadata": {}
}
```

`regular_amount` = preço riscado (de). `amount` = preço por.

### Prices completo

```http
GET /items/{MLB_ID}/prices
```

Retorna todos os preços (standard, promotional, mshops, por contexto).

### Promoções do seller (autenticado)

```http
GET /seller-promotions/users/{USER_ID}?app_version=v2
GET /seller-promotions/items/{MLB_ID}?app_version=v2
```

Retorna promoções tipo `CUSTOM`, `PRICE_DISCOUNT`, `DEAL`, `MARKETPLACE_CAMPAIGN`. Use `app_version=v2` (versão atual).

---

## 8. Categorias

```http
GET /sites/MLB/categories                        # categorias raiz
GET /categories/{CATEGORY_ID}                    # detalhe + breadcrumb
GET /categories/{CATEGORY_ID}/attributes         # atributos esperados
GET /sites/MLB/category_predictor/predict?title=iphone+15  # adivinha categoria
```

Cada categoria tem `children_categories` permitindo navegar a árvore inteira.

---

## 9. Highlights, Trends, Hot Items

**Endpoints úteis para descoberta de "mais vendidos / em alta":**

```http
GET /highlights/MLB/category/{CATEGORY_ID}      # ranking de mais vendidos
GET /sites/MLB/hot_items/search?category={CAT}  # itens "quentes"
GET /sites/MLB/featured_items/HP                # destaques home
GET /sites/MLB/featured_items/HP-{CATEGORY_ID}  # destaques por categoria
GET /trends/MLB                                 # tendências de busca
GET /trends/MLB/{CATEGORY_ID}                   # tendências por categoria
```

Combine `highlights` + filtro local de desconto para "mais vendidos em promoção".

---

## 10. APIs autenticadas relevantes

### Usuário

```http
GET /users/me                              # usuário do token
GET /users/{USER_ID}                       # perfil público
GET /users/{USER_ID}/items/search          # itens publicados pelo usuário
```

### Vendas (seller)

```http
GET /orders/search?seller={USER_ID}
GET /orders/{ORDER_ID}
GET /shipments/{SHIPMENT_ID}
```

### Perguntas

```http
GET /questions/search?seller_id={USER_ID}&status=UNANSWERED
POST /answers                              # responder pergunta
```

### Mensageria pós-venda

```http
GET /messages/packs/{PACK_ID}/sellers/{USER_ID}
POST /messages/packs/{PACK_ID}/sellers/{USER_ID}
```

---

## 11. Webhooks / Notificações

Configurados no DevCenter, URL HTTPS pública.

### Topics relevantes

| Topic | Quando dispara |
|---|---|
| `items` | Item criado/modificado/pausado |
| `items_prices` | Mudança de preço de item próprio |
| `orders_v2` | Nova venda ou mudança de status |
| `messages` | Nova mensagem pós-venda |
| `questions` | Nova pergunta no item |
| `shipments` | Status de envio |
| `claims` | Reclamação aberta |
| `payments` | Status de pagamento |

### Estrutura da notificação (POST do ML para sua URL)

```json
{
  "resource": "/orders/123456",
  "user_id": 8035443,
  "topic": "orders_v2",
  "application_id": 1234567890,
  "attempts": 1,
  "sent": "2025-05-12T10:30:00.000Z",
  "received": "2025-05-12T10:30:00.000Z"
}
```

Responda com `HTTP 200` em até **22 segundos** ou o ML tenta de novo. Processamento real deve ser **assíncrono** (enfileirar e retornar 200 imediato).

---

## 12. Rate limits e erros

### Rate limits

- **1500 req/min por seller autenticado** (oficial).
- **Endpoints públicos:** não documentado, prática: ≤ 10 req/s por IP, com backoff em 429.
- Headers retornados em algumas respostas: `X-RateLimit-Limit`, `X-RateLimit-Remaining`.
- Em 429, resposta pode vir **vazia** — trate como erro recuperável.

### HTTP status codes

| Code | Significado | Ação |
|---|---|---|
| 200 | OK | — |
| 201 | Criado | — |
| 400 | Bad request | Validar payload |
| 401 | Token inválido/expirado | Refresh |
| 403 | Sem permissão (scope ou recurso) | Verificar scope |
| 404 | Recurso não existe | — |
| 429 | Rate limited | Backoff exponencial |
| 500 / 502 / 503 | Erro ML | Retry com backoff |

### Estratégia de retry recomendada

```
Tentativas: 5
Backoff: exponential com jitter
Base: 1s · max: 60s
Retentar em: 429, 500, 502, 503, 504, network errors
NÃO retentar: 400, 401 (faça refresh antes), 403, 404
```

---

## 13. Sites IDs e códigos de país

| Site ID | País | Auth URL |
|---|---|---|
| `MLA` | Argentina | auth.mercadolibre.com.ar |
| `MLB` | Brasil | auth.mercadolivre.com.br |
| `MLM` | México | auth.mercadolibre.com.mx |
| `MLC` | Chile | auth.mercadolibre.cl |
| `MCO` | Colômbia | auth.mercadolibre.com.co |
| `MLU` | Uruguai | auth.mercadolibre.com.uy |
| `MPE` | Peru | auth.mercadolibre.com.pe |
| `MLV` | Venezuela | auth.mercadolibre.com.ve |
| `MEC` | Equador | auth.mercadolibre.com.ec |
| `CBT` | Global (Cross Border Trade) | — |

---

## 14. IDs de categorias MLB (Brasil)

Categorias raiz mais relevantes para bots de promoção:

| ID | Categoria |
|---|---|
| `MLB5726` | Eletrodomésticos |
| `MLB1648` | Informática |
| `MLB1051` | Celulares e Telefones |
| `MLB1000` | Eletrônicos, Áudio e Vídeo |
| `MLB1276` | Esportes e Fitness |
| `MLB1574` | Casa, Móveis e Decoração |
| `MLB1132` | Brinquedos e Hobbies |
| `MLB1430` | Calçados, Roupas e Bolsas |
| `MLB1246` | Beleza e Cuidado Pessoal |
| `MLB1499` | Indústria e Comércio |
| `MLB1196` | Livros, Revistas e Comics |
| `MLB1144` | Games |
| `MLB1071` | Animais |
| `MLB1182` | Instrumentos Musicais |
| `MLB1367` | Antiguidades e Coleções |
| `MLB1540` | Serviços |
| `MLB1953` | Mais Categorias |
| `MLB1500` | Construção |
| `MLB1168` | Música, Filmes e Seriados |
| `MLB1276` | Esportes |
| `MLB1039` | Câmeras e Acessórios |
| `MLB1384` | Bebês |
| `MLB264586` | Saúde |
| `MLB1276` | Esportes |
| `MLB1743` | Carros, Motos e Outros |
| `MLB1459` | Imóveis |

**Sempre buscar a árvore completa em runtime:** `GET /sites/MLB/categories` para garantir IDs atualizados, pois o ML cria/remove categorias.

---

## 15. Programa de Afiliados — realidades operacionais

### O que existe oficialmente

- Programa de afiliados em `mercadolivre.com.br/afiliados/`
- Painel web para gerar links manuais
- Comissão variável por categoria

### O que NÃO existe (até esta data)

- API REST para gerar links de afiliado programaticamente
- API para consultar cliques, conversões, comissões
- Endpoint para listar produtos elegíveis ao programa

### Estratégias práticas para obter links de afiliado em escala

#### Estratégia A: Tag UTM na URL (mais simples, menos confiável)

Adicionar parâmetro com seu ID de afiliado à URL canônica do produto. **Validar empiricamente** se o ML atribui comissão por esse meio — varia ao longo do tempo.

```
{permalink}?ref=affiliate&ref_source={SEU_ID}
```

#### Estratégia B: Scraping autenticado do painel via Playwright

Mais robusto, garante o link curto oficial `mercadolivre.com/sec/...`. Mas:
- Viola os ToS do ML formalmente
- Frágil: cada mudança de UI quebra
- Precisa de sessão persistente (cookies + storage state)

**Padrão de implementação:** isolar atrás de uma interface (`AffiliateLinkPort`) para poder trocar de estratégia sem mexer no resto do código.

```typescript
interface AffiliateLinkPort {
  generate(productPermalink: string): Promise<AffiliateLink>;
}
```

#### Estratégia C: Deep link manual + UTM custom

Algumas categorias aceitam deep link com tracking ID no path. Validar caso a caso.

---

## 16. Padrões de uso e anti-patterns

### ✅ Padrões corretos

- **Cache em camada de aplicação:** `/categories/*` e `/sites/*` mudam raramente — TTL de 24h é seguro.
- **Batch quando possível:** `/items?ids=MLB1,MLB2,...` (até 20) em vez de N chamadas.
- **Use a busca para descobrir, detalhe só quando necessário.** A `/search` já traz 90% dos campos úteis.
- **Webhook + queue:** receba o POST do ML, enfileire, responda 200 em <1s, processe assincronamente.
- **Persista token e refresh_token criptografados.** Refresh é single-use.
- **Idempotência em jobs:** use `MLB_ID` como chave única para deduplicar.
- **Histórico de preço próprio em banco:** essencial para detectar fake discount.

### ❌ Anti-patterns

- **Fazer `/items/{id}` em loop em vez de batch ou de já consumir da `/search`.** Estoura rate limit rápido.
- **Salvar `access_token` em código ou variável de ambiente "estática".** Ele expira em 6h.
- **Ignorar 429.** Sem backoff você é banido temporariamente.
- **Confiar em `original_price` da `/search` para decidir promoção.** Muitos sellers inflam o preço de. Cruze com histórico próprio.
- **Polling em vez de webhook** quando webhook está disponível.
- **Responder webhook após o processamento.** Estoura os 22s e o ML retenta.

---

## 17. Receitas prontas para bots de promoção

### Receita 1 — Descobrir promoções em uma categoria

```http
GET /sites/MLB/search
    ?category=MLB1000
    &discount=25-100
    &power_seller=yes
    &condition=new
    &sort=price_desc
    &limit=50
```

Filtrar resultado:
1. `(original_price - price) / original_price >= 0.25`
2. `seller.power_seller_status in [platinum, gold]`
3. `shipping.free_shipping === true` (opcional)
4. `available_quantity >= 1`

### Receita 2 — Mais vendidos com promoção ativa

```http
GET /highlights/MLB/category/MLB1051
```

Para cada `item_id` retornado:
```http
GET /items/{id}/sale_price?context=channel_marketplace
```

Manter apenas os que têm `regular_amount` significativamente maior que `amount`.

### Receita 3 — Monitorar quedas de preço

1. Buscar diariamente os itens-alvo (lista própria de MLBs).
2. Para cada um: `GET /items/{id}/sale_price`.
3. Persistir `(item_id, amount, captured_at)` em tabela `price_history`.
4. Alertar quando `amount` cai >= X% vs mediana dos últimos 30d.

### Receita 4 — Validar desconto real (anti-fake-discount)

```sql
-- SQL Server
SELECT 
  PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY price_cents) 
    OVER () AS median_30d
FROM price_history
WHERE item_id = @item_id
  AND captured_at >= DATEADD(DAY, -30, GETDATE());
```

Regra: só publica se `current_price < median_30d * 0.85` (15% abaixo da mediana real).

### Receita 5 — Pipeline assíncrono recomendado

```
[Scheduler] ──► [discovery queue] ──► chama /search por categoria
                                              │
                                              ▼
                                  [enrich queue] ──► sale_price + histórico
                                                          │
                                                          ▼
                                            [affiliate-link queue]
                                                          │
                                                          ▼
                                              [publish queue] ──► Telegram/WhatsApp
```

Cada etapa idempotente, com retry exponencial, deduplicação por `MLB_ID + janela temporal`.

### Receita 6 — Cabeçalho de requisição padrão

```http
GET /sites/MLB/search?q=notebook HTTP/1.1
Host: api.mercadolibre.com
Accept: application/json
User-Agent: NomeDoBot/1.0 (+contato@exemplo.com)
```

Para endpoints autenticados, adicione:
```
Authorization: Bearer APP_USR-...
```

---

## Apêndice A — Links da documentação oficial

- DevCenter (gerenciar apps): https://developers.mercadolivre.com.br/devcenter
- Docs PT-BR: https://developers.mercadolivre.com.br/pt_br/api-docs-pt-br
- Autenticação e Autorização: https://developers.mercadolivre.com.br/pt_br/autenticacao-e-autorizacao
- Itens e Buscas: https://developers.mercadolivre.com.br/pt_br/itens-e-buscas
- Preços (sale_price): https://developers.mercadolivre.com.br/pt_br/products-prices
- Notificações/Webhooks: https://developers.mercadolivre.com.br/pt_br/produto-receba-notificacoes
- Categorias: https://developers.mercadolivre.com.br/pt_br/categorias-e-publicacoes

---

## Apêndice B — Cheat sheet de endpoints

```
# AUTENTICAÇÃO
POST   /oauth/token

# USUÁRIO
GET    /users/me                                     [auth]
GET    /users/{USER_ID}                              [public]
GET    /users/{USER_ID}/items/search                 [auth]

# BUSCA
GET    /sites/MLB/search                             [public]
GET    /sites/MLB/search?category=X&discount=20-100  [public]

# ITENS
GET    /items/{MLB_ID}                               [public]
GET    /items?ids=MLB1,MLB2                          [public/auth]
GET    /items/{MLB_ID}/description                   [public]

# PREÇOS
GET    /items/{MLB_ID}/sale_price                    [public]
GET    /items/{MLB_ID}/prices                        [public]

# PROMOÇÕES (seller)
GET    /seller-promotions/users/{USER_ID}            [auth]
GET    /seller-promotions/items/{MLB_ID}             [auth]

# CATEGORIAS
GET    /sites/MLB/categories                         [public]
GET    /categories/{CATEGORY_ID}                     [public]
GET    /categories/{CATEGORY_ID}/attributes          [public]

# DESCOBERTA
GET    /highlights/MLB/category/{CATEGORY_ID}        [public]
GET    /sites/MLB/hot_items/search                   [public]
GET    /sites/MLB/featured_items/HP-{CAT}            [public]
GET    /trends/MLB                                   [public]

# VENDAS
GET    /orders/search?seller={USER_ID}               [auth]
GET    /orders/{ORDER_ID}                            [auth]
GET    /shipments/{SHIPMENT_ID}                      [auth]

# PERGUNTAS
GET    /questions/search?seller_id={USER_ID}         [auth]
POST   /answers                                      [auth]
```

---

**Última revisão deste documento:** Maio 2026. Endpoints e parâmetros podem mudar — sempre validar contra a documentação oficial antes de implementar features críticas.
