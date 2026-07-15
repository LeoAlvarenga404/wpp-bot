# Growth — estratégia de divulgação e preparo para escala

> Data: 2026-07-15. Complementa o [INFRA.md](INFRA.md) (infra/custo) com o plano
> de aquisição de membros e as 4 features técnicas que o suportam.
>
> Premissa central: **o gargalo de escala de um grupo WhatsApp não é CPU — é
> ban do chip e o limite de 1024 membros por grupo.** Postar é O(grupos), não
> O(membros). Toda a estratégia abaixo deriva disso.

---

## 0. Regra nº 1 — nunca divulgar o link do grupo diretamente

Todo material de divulgação (bio do TikTok, card de IG, boca-a-boca, anúncio)
aponta para **um link fixo próprio** (ex. `https://seudominio.com.br/entrar`),
que redireciona para o convite do grupo ativo. Motivos:

1. **Grupo enche** (1024 membros) → troca-se o destino do redirect para o
   grupo 2, sem quebrar nenhum material já publicado.
2. **Chip banido / link de convite resetado** → novo grupo, mesmo link fixo.
   Vídeo de 6 meses atrás continua convertendo.
3. **Medição** → `?src=tiktok` no link fixo diz de onde veio cada membro.
   Sem isso, não existe cálculo de CAC e todo investimento em divulgação é às
   cegas.

Isso é a Feature 1 (§3). Deve existir **antes** da primeira divulgação, mesmo
para amigos/família.

---

## 1. Posicionamento

- Grupo genérico "promoções de tudo" compete com Pelando/Promobit/mega-grupos.
  Não dá para ganhar em volume.
- O diferencial deste bot é **curadoria automática** (deal-score + judge +
  histórico de preço): poucas ofertas por dia, só as que valem, sem spam de
  50 mensagens. Isso é o pitch — na descrição do grupo, na bio das redes, no
  roteiro dos vídeos.
- Nicho > genérico quando possível (tech, casa, mercado, bebê…): retém mais,
  converte mais, e o deal-score pode ser tunado por categoria.

## 2. Canais de aquisição

### 2.1 Orgânico (motor principal, custo zero)

| Canal | Formato | Cadência | Observação |
|---|---|---|---|
| TikTok / Reels / Shorts | Vídeo "achadinhos" mostrando 1–3 ofertas do dia | 1/dia | Canal nº 1 de crescimento de grupos de promo no BR. Headline do DeepSeek já é metade do roteiro |
| Instagram (feed + stories) | Card por oferta (Feature 4, §6) + stories | 1–3/dia | Link fixo na bio. Card gerado automaticamente pelo bot |
| Telegram (espelho) | Mesmo pipeline, publisher já existe | Automático | Canal TG é pesquisável dentro do app e sem limite de membros. Capta público que o WA não capta |
| Rodapé viral no digest | "📢 Manda pra um amigo: [link fixo]" ocasional | 1–2×/semana | Encaminhamento é o mecanismo de crescimento nativo do WA. Não pôr em toda mensagem (vira ruído) |
| Comunidades (grupos FB de nicho, Reddit r/promocoes) | Participação genuína, não spam | Oportunista | Respeitar regras de cada comunidade |

### 2.2 Pago (só depois de medir)

Pré-requisito: Features 1 e 2 rodando, com pelo menos ~30 dias de dado de
**receita por membro por mês** (relatório de subID Shopee/ML ÷ membros).
Sem esse número, anúncio é queimar dinheiro.

- **Meta Ads click-to-WhatsApp (CTWA)** — CAC mais barato para grupo WA no
  BR. Começar com R$ 10–20/dia, uma `src=` por criativo, otimizar pelo funil
  entrada → clique → receita.
- **Micro-influencers de achadinhos** — permuta ou comissão. Um subID de
  afiliado por influencer mede o retorno exato de cada parceria.

### 2.3 Datas de pico

Black Friday, 12.12 Shopee, Prime Day, Dia do Consumidor (15/03), Dia das
Mães/Pais. Membros encaminham sozinhos se a oferta for boa — preparar
conteúdo e aumentar cadência 1–2 semanas antes. Melhor época para gastar em
aquisição: a semana anterior ao pico (membro novo já entra vendo o grupo no
melhor momento).

## 3. KPIs

| Métrica | Fonte | Uso |
|---|---|---|
| Entradas por origem (`src`) | Feature 1 | CAC por canal |
| Cliques por oferta/grupo/variante | Feature 2 | CTR, qual copy/fonte converte |
| Receita por subID | Painel Shopee / ML | EPC (receita por clique), receita por grupo |
| **Receita por membro/mês** | subID ÷ membros | O número que autoriza (ou não) tráfego pago |
| Saídas do grupo (churn) | contagem manual/semanal | Sinal de cadência errada ou oferta ruim |

---

# As 4 features técnicas

Ordem de implementação recomendada: **F1 → F2 → F4 → F3** (F3 já está 80%
pronta; o que falta só importa com >1 grupo).

---

## 4. Feature 1 — Link fixo de entrada (redirect + UTM)

### Objetivo

URL permanente e medível que desacopla a divulgação do convite volátil do
grupo. Sobrevive a: grupo cheio, ban, reset de link de convite, migração
para Canal do WhatsApp.

### Design recomendado: Cloudflare Worker + KV (fora do VPS)

Motivos para NÃO hospedar no bot: (a) aquisição não pode cair junto com o
VPS; (b) não expõe o IP do VPS em material público; (c) free tier da CF
(100k req/dia) cobre qualquer cenário realista; (d) latência de borda.

```
GET https://seudominio.com.br/entrar?src=tiktok
  → Worker lê KV "dest:default" (ou "dest:<src>" se existir)
  → log assíncrono do evento (ctx.waitUntil)
  → 302 para https://chat.whatsapp.com/XXXX
```

Componentes:

1. **Domínio próprio** (~R$ 40/ano, Registro.br). Usar domínio "sério" — não
   .xyz barato: o mesmo domínio serve o encurtador de cliques (F2) e domínio
   com má reputação aumenta risco de flag de spam no WA.
2. **Worker** (~40 linhas): rota `/entrar`, lookup no KV, 302. `src`
   ausente → `direct`.
3. **KV**: chave `dest:default` = link de convite atual. Chaves `dest:<src>`
   opcionais permitem apontar origens diferentes para grupos diferentes
   (ex. teste A/B de grupo nichado).
4. **Log de entrada**: duas opções, em ordem de simplicidade:
   - **Workers Analytics Engine** (grátis): `env.JOINS.writeDataPoint({
     blobs: [src], doubles: [1] })` — consulta via GraphQL da CF.
   - **Webhook para o bot**: `ctx.waitUntil(fetch(BOT_URL + '/growth/join',
     { headers: { 'x-api-key': SECRET }, body: { src } }))` → tabela
     `JoinEvent(src, at)`. Vantagem: dado junto do resto no Postgres,
     consultável com SQL. Recomendado se F2 for feita (a rota admin já
     existe no padrão `ApiKeyGuard`).
5. **Atualização do destino** quando o grupo muda:
   `wrangler kv key put dest:default "https://chat.whatsapp.com/YYYY"` — ou
   um `POST /update` no próprio worker protegido por token, para o bot
   atualizar sozinho no futuro.

### Detalhes que importam

- **Landing intermediária vs redirect seco**: tráfego morno (bio do TikTok,
  amigo indicou) converte melhor com redirect direto. Tráfego frio (ads)
  converte melhor com landing de 1 tela (proposta de valor + botão
  "Entrar no grupo"). Implementar redirect seco primeiro; landing por `src`
  quando começar tráfego pago.
- **QR code** apontando para o link fixo (com `src=qr`) para material
  impresso/stories.
- O link fixo é também o plano de recuperação de ban (§8): grupo novo →
  1 comando → tudo que já foi divulgado volta a funcionar.

### Esforço: ~meio dia. Sem mudança no bot (opcionalmente +1 rota admin `POST /growth/join`).

---

## 5. Feature 2 — Click-tracking próprio (`GET /r/:code`)

### Objetivo

Medir **cliques** por oferta × grupo × variante de copy. Fecha o funil:
curadoria → post → clique → receita (subID). Hoje o funil termina no post —
não há como saber qual fonte/copy/grupo gera clique, nem calcular EPC.

### Design

O formatter, ao montar o caption, troca o link de afiliado por um link curto
próprio. O clique passa pelo bot, é contado e redireciona (302) para o link
de afiliado final.

```
caption:  https://l.seudominio.com.br/r/aB3xK9p
                          │
                          ▼
GET /r/aB3xK9p  (rota pública, SEM ApiKeyGuard)
  → lookup TrackedLink.code (cache Redis opcional)
  → classifica User-Agent (humano vs bot de preview)
  → INSERT LinkClick assíncrono (fire-and-forget; nunca atrasa o redirect)
  → 302 destUrl (link de afiliado)
```

### Schema (Prisma)

```prisma
// Um código por (oferta × alvo × variante) — criado pelo formatter na hora
// de montar o caption. destUrl é o link de afiliado já resolvido.
model TrackedLink {
  code      String   @id            // base62, 7 chars (nanoid custom alphabet)
  catalogId String
  targetJid String?                 // qual grupo/canal recebeu
  variant   String?                 // variante de copy (A/B)
  destUrl   String
  createdAt DateTime @default(now())

  @@index([catalogId])
}

model LinkClick {
  id        BigInt   @id @default(autoincrement())
  code      String
  clickedAt DateTime @default(now())
  uaClass   String                  // 'human' | 'preview-bot' | 'unknown'
  ipHash    String?                 // sha256 truncado (16 hex) — LGPD-safe

  @@index([code, clickedAt])
}
```

### Integração com o pipeline existente

- `FormatterService.resolveLink()` (`src/pipeline/formatter.service.ts`) é o
  ponto único onde o link entra no caption — hoje resolve afiliado para
  `source === 'ml'` e passa `permalink` direto para o resto. Passa a:
  resolver o link final → criar `TrackedLink` → retornar a URL curta.
- **Fallback obrigatório**: se o INSERT do `TrackedLink` falhar (Postgres
  fora etc.), o caption usa o link de afiliado direto. Tracking nunca pode
  travar publicação.
- Para atribuir `targetJid`/`variant`, `formatScored`/`formatDigest` passam a
  receber o `targetJid` — o `SendDealWorker` já tem esse dado no job
  (`job.data.targetJid`), é só encaminhar. Cada alvo já formata em job
  próprio, então códigos por grupo saem naturalmente.
- Métrica Prometheus junto (o `CountersService` já existe):
  `link_clicks_total{ua_class, source}`.

### Armadilha principal: bots de preview

Quando a mensagem chega, o WhatsApp (e o Telegram) fazem fetch da URL para
gerar o preview — **cada envio gera 1+ hits que não são cliques humanos**.
Tratamento:

- Classificar por User-Agent: `WhatsApp/`, `facebookexternalhit`,
  `TelegramBot` etc. → `uaClass = 'preview-bot'`, excluído dos relatórios.
- Requests `HEAD` → idem.
- Relatórios usam só `uaClass = 'human'`.

### Exposição pública

A rota precisa de HTTPS público — hoje o bot só faz tráfego outbound
(INFRA.md §1). Solução: subdomínio `l.seudominio.com.br` **proxied pela
Cloudflare** (orange cloud) → VPS, com Caddy (TLS automático) ou nginx na
frente do Node. A CF esconde o IP do VPS e absorve picos. Somente `/r/*`
exposto; resto das rotas continua atrás do `x-api-key` como hoje.

### Relatórios

```sql
-- CTR por grupo e variante (últimos 7 dias, só humanos)
SELECT tl."targetJid", tl.variant,
       COUNT(DISTINCT tl.code)                       AS posts,
       COUNT(lc.id) FILTER (WHERE lc."uaClass"='human') AS clicks
FROM "TrackedLink" tl
LEFT JOIN "LinkClick" lc ON lc.code = tl.code
WHERE tl."createdAt" > now() - interval '7 days'
GROUP BY 1, 2 ORDER BY clicks DESC;
```

Cruzar com o relatório de subID da Shopee/ML (usar **um subID por grupo**) →
EPC real por grupo. Fase futura: cliques viram input do deal-score
(categorias com EPC alto ganham boost na curadoria).

### Esforço: ~1 dia (migration + rota + formatter + testes + Caddy/CF).

---

## 6. Feature 3 — Multi-target: estado atual e o que falta

### Já implementado (não refazer)

| Peça | Onde | Status |
|---|---|---|
| Registro de alvos (CRUD, ativo/inativo, canal `wa`/`telegram`) | `WaTarget` + `TargetsService` + REST `/wa/targets` | ✅ |
| Fan-out por alvo (singles e digest, jobId idempotente por deal×alvo) | `PipelineService.enqueueScored()` | ✅ |
| Publisher por canal (WA via Baileys, Telegram via Bot API) | `PublisherRegistry` | ✅ |
| Caps por canal | `MAX_DEALS_PER_RUN_WA` / `MAX_DEALS_PER_RUN_TELEGRAM` | ✅ |
| Auditoria por alvo | `SentMessage.targetJid` | ✅ |

Adicionar um segundo grupo hoje = `POST /wa/targets` com o JID. Nada mais.

### Gap 1 — rate limit é por chip, compartilhado entre grupos

O limiter/warmup conta mensagens **do chip**, não por grupo. N grupos = N×
mensagens por tick. Regra prática:

```
grupos_max_por_chip ≈ cap_horário_do_warmup / mensagens_por_tick
```

Com digest (1 mensagem por tick por grupo) isso rende folga — mas ao passar
de ~4–5 grupos num chip jovem, ou o warmup atrasa os envios (BullMQ segura,
comportamento correto) ou é hora do Gap 3. Documentar o teto no runbook e
monitorar `throttled:*` no Prometheus (`wppMessagesFailed`) como sinal.

### Gap 2 — Canal do WhatsApp (Channels/newsletter) ⭐ maior alavanca

Canal não tem limite de membros, é unidirecional (zero spam de membro) e
descobrível dentro do WhatsApp. É o destino natural quando a soma dos grupos
passar de ~1–2k membros; grupos viram "comunidade VIP".

- Baileys 7 tem suporte a JIDs `...@newsletter`. **Validar na rc10 em canal
  descartável antes de contar com isso** (enviar imagem+caption, medir
  estabilidade por 1 semana).
- Se funcionar: é só um `WaTarget` com o JID do canal, `channel: 'wa'` —
  zero mudança de schema ou publisher.
- Risco menor de ban por denúncia (membro de canal não denuncia mensagem
  como num grupo), mas o chip continua sendo o ponto único de falha.

### Gap 3 — sharding por chip (só quando precisar)

Hoje: 1 processo = 1 sessão Baileys = 1 chip (INFRA.md §1). Para >1 chip:

- `WaTarget.chipId String @default("main")` + mapa de sessões por chip no
  `WhatsappService` (ou N processos com `TARGET_FILTER`, mais simples).
- Warmup/counters já são por chip conceitualmente (`WaCounter` ganharia
  prefixo do chip).
- **Não fazer agora.** Gatilho: >4–5 grupos ativos ou necessidade de chip
  backup quente. Registrado aqui para a decisão de schema não surpreender.

### Gap 4 — miudezas

- `SendDealWorker.processDigest()` hardcoda `publishers.get('wa')` — correto
  enquanto digest é só WA; se um dia houver digest TG, usar
  `job.data.channel` como no `processSingle`.
- Comandos in-group (`/ofertas`, `/sair`) já existem (`command.handler.ts`);
  administração de alvos fica na REST — não expor `addtarget` em grupo.

### Esforço: Gap 2 ~meio dia de validação; Gaps 1/4 são documentação/ajuste fino; Gap 3 ~2–3 dias quando chegar a hora.

---

## 7. Feature 4 — Gerador de cards para Instagram

### Objetivo

Transformar deal aprovado em imagem pronta para IG (feed 1080×1350, story
1080×1920): foto do produto, headline, preço, badge de desconto, marca do
grupo, CTA "link na bio". Alimenta o canal de aquisição nº 2 (§2.1) com
custo marginal zero — o bot já tem a oferta, a foto hi-res
(`toHiResImage()`) e a headline (DeepSeek, com cache).

### Render: Playwright screenshot de template HTML (recomendado)

O Chromium **já está na stack** (adapter de afiliado, `AFFILIATE_PROVIDER=
playwright`) — template HTML/CSS + `page.screenshot()` = zero dependência
nova e total liberdade de layout. Alternativa `satori`+`resvg` (sem
Chromium) só compensaria para fugir do peso do browser, que já é pago.

```
src/card/
├── card.module.ts
├── card.service.ts          # render(scored, variant, format) → Buffer PNG
├── card.controller.ts       # POST /card/preview (ApiKeyGuard) p/ iterar layout
└── templates/
    ├── feed.html            # 1080×1350
    └── story.html           # 1080×1920
```

- `CardService.render()`: carrega template, injeta dados (headline, preço
  formatado, % off, foto, selo "menor preço em 30d" quando o histórico
  confirmar — dado que o `PriceHistory` já tem e nenhum concorrente mostra),
  `page.setViewportSize()`, screenshot, salva em `./data/cards/`.
- Selo de credibilidade é o diferencial do card: **"menor preço dos últimos
  30 dias ✓"** só quando for verdade. Curadoria vira marketing.
- Selection: só deals `score >= CARD_MIN_SCORE` com thumbnail ≥ 800px;
  `CARD_MAX_PER_DAY` (default 3). Card ruim polui o feed.

### Distribuição

**Fase 1 — humano no loop (fazer já):** após aprovação no gate, bot envia o
card + caption sugerida (headline + preço + "link na bio 🔗") para um canal
Telegram privado de ops (o publisher TG já existe — é um `WaTarget`
`channel: 'telegram'` inativo para o pipeline normal, usado só pelo
CardService). Postar manualmente custa ~1 min/dia e evita toda a burocracia
de API.

**Fase 2 — IG Graph API (quando a página tiver tração):** content publishing
exige IG Business vinculado a página do Facebook + app aprovado; publica por
`image_url` público (servir de `GET /cards/:file` público via o mesmo proxy
CF da F2, ou um bucket R2). Limite: 25 posts/dia por conta — irrelevante.

**Bônus (custo ~zero):** o mesmo card no **Status do WhatsApp** do chip
(Baileys envia para `status@broadcast`) — vitrine para todos os contatos do
chip; e como imagem de capa do digest (hoje a capa é a foto crua do 1º
produto — card composto é mais profissional).

### Esforço: 1–2 dias (template + service + envio pro TG ops). Fase 2 IG API: +1 dia + burocracia Meta.

---

## 8. Runbook de ban (vai acontecer; a pergunta é quando)

1. **Chip dedicado** — nunca o número pessoal.
2. **Chip backup aquecendo desde já**: segundo número em aparelho barato,
   uso humano leve por 4+ semanas (o `source_warmup` do bot cuida do ritmo
   de mensagens, mas idade e histórico do chip contam).
3. **Backup**: `auth_info/` + Postgres (scripts em `deploy/` já cobrem).
   Testar restore 1×/mês.
4. **Recuperação** (com F1 no ar): chip novo → QR → criar/assumir grupo →
   `POST /wa/targets` → atualizar KV `dest:default`. Downtime de aquisição:
   minutos. Sem F1: todo material divulgado morre — por isso F1 vem primeiro.
5. **Prevenção contínua**: jitter + quiet hours + warmup já implementados;
   monitorar `wppMessagesFailed{reason}` no Prometheus; mais membros = mais
   denúncias — crescer cadência devagar após onda grande de entradas.

## 9. Compliance

- **Disclosure de afiliado**: o `disclaimerLine()` já é obrigatório em todo
  caption — manter em qualquer formato novo (cards incluem "#publi" ou
  "links de afiliado" na caption sugerida). CONAR exige.
- **LGPD**: opt-out já existe (`WaOptout` + `/sair`); F2 armazena só hash
  truncado de IP; `JoinEvent` não guarda identificador pessoal.
- **Termos dos programas** (Shopee/ML): revisar antes do tráfego pago —
  programas costumam proibir anúncio em termo de marca (brand bidding) e
  alguns formatos de incentivo. Violação = conta de afiliado banida (pior
  que ban de chip).

## 10. Roadmap consolidado

| Fase | Membros | Ações de marketing | Features |
|---|---|---|---|
| 1 | 0 → 200 | Amigos/família **via link fixo**; chip backup aquecendo | F1 no ar; F2 implementada |
| 2 | 200 → 1k | TikTok/IG 1 post/dia; espelho TG; rodapé viral no digest | F4 fase 1 (cards + TG ops) |
| 3 | 1k+ | CTWA R$ 10–20/dia guiado por EPC; micro-influencers com subID próprio | F3 gap 2 (Canal WA); F4 fase 2 (IG API); F3 gap 3 se precisar |

Critério de passagem 2→3: receita/membro/mês conhecida e estável por 30 dias.
