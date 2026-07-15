# Infraestrutura — rodar o wpp-bot 100% autônomo

> Data da análise: 2026-07-15. Câmbio assumido: US$ 1 ≈ R$ 5,50 · € 1 ≈ R$ 6,00.
> Preços de cloud/API são estimativas da data — confira antes de contratar.

---

## 1. O que a aplicação exige (requisitos duros)

A app é um **monólito NestJS de processo único** que roda tudo junto: API HTTP,
scheduler (`@nestjs/schedule`), worker BullMQ (`SendDealWorker`) e o socket
Baileys do WhatsApp. Isso define a infra:

| Componente | Requisito | Por quê |
|---|---|---|
| Processo Node 22 | **Long-running, 24/7, instância única** | Baileys mantém WebSocket persistente com o WhatsApp; sessão não pode ter 2 réplicas |
| Postgres 16 | Persistente | Prisma: `Product`, `PriceHistory`, `SentMessage`, `CurationDecision`, `MlToken`, `DedupEntry`, `WaCounter/Target/Optout` |
| Redis 7 (AOF) | Persistente | BullMQ (fila `send-deal` com jitter anti-ban) |
| Chromium/Playwright | glibc (Debian, não Alpine), ~400–600 MB RAM em pico | Adapter de link de afiliado (`AFFILIATE_PROVIDER=playwright`) |
| Disco persistente | `./auth_info` + `./data` + `pgdata` + `redisdata` | Sessão Baileys sobrevive a restart (senão: re-scan de QR) |
| IP estável, idealmente BR | Forte recomendação | Troca de IP/datacenter estrangeiro aumenta risco de re-auth e ban do chip |
| Saída HTTPS | ML API, Groq, DeepSeek, Telegram, Sentry | Só tráfego outbound; nada disso exige porta aberta |
| Entrada HTTPS | Opcional | `/pipeline/*` e `/affiliate/*` são admin (protegidos por `x-api-key`); OAuth ML (`/oauth/callback`) é **one-time** — o token vive no Postgres e se auto-renova (`token-refresher`) |

**Consequências diretas:**

- ❌ **Serverless está descartado** (Lambda, Cloud Run scale-to-zero, Vercel):
  WebSocket persistente do Baileys + worker BullMQ + Chromium não sobrevivem a
  cold start / scale-to-zero. Cloud Run com `min-instances=1` funciona, mas
  custa ~R$ 80–150/mês para 2 GB always-on e não tem disco persistente nativo
  para `auth_info` — pior e mais caro que um VPS.
- ❌ **Escala horizontal não existe** — é 1 réplica por definição (sessão WA).
  Escalar = otimizar vertical ou separar Postgres/Redis.
- ✅ **Um VPS pequeno resolve tudo.** O `docker-compose.yml` do repo já sobe o
  stack completo (app + postgres + redis) e o `deploy/` já traz systemd,
  logrotate, backup e install script como alternativa sem Docker.

### Dimensionamento

| Recurso | Mínimo | Confortável | Observação |
|---|---|---|---|
| vCPU | 1 | 2 | Pico só quando Chromium abre (afiliado) e no tick do scheduler (4×/dia) |
| RAM | 1 GB + swap | **2 GB** | Node+Nest ~250 MB, Baileys ~100 MB, Postgres ~150 MB, Redis ~50 MB, Chromium ~500 MB em pico. Com `AFFILIATE_PROVIDER=json` roda em 1 GB |
| Disco | 20 GB | 40 GB NVMe | DB cresce poucos MB/mês; imagem Docker + Chromium ~2 GB |
| Banda | Irrisória | — | <1 GB/dia (chamadas de API + fotos de produto) |
| SO | Ubuntu 22.04/24.04 ou Debian 12 | — | Dockerfile já é bookworm |

---

## 2. Comparativo de hospedagem (o componente que decide o custo)

| Opção | Specs | Custo/mês | IP | Latência BR | Prós | Contras |
|---|---|---|---|---|---|---|
| **Oracle Cloud Free (ARM A1)** | até 4 OCPU / 24 GB / 200 GB | **R$ 0** | Fixo, região São Paulo | Ótima | De longe o melhor hardware por R$ 0; roda o stack inteiro com folga | Conseguir capacidade free em GRU é loteria; instância *always-free* ociosa pode ser recuperada (mitigável virando conta PAYG, continua R$ 0); ARM exige imagem multi-arch (o Dockerfile atual builda normal em arm64) |
| **Hostinger KVM 2** ⭐ | 2 vCPU / 8 GB / 100 GB NVMe | **R$ 27–40 (promo), R$ 55–70 renovação** | Fixo, datacenter BR | Ótima | IP brasileiro estável (o melhor cenário para Baileys), painel simples, specs sobradas | Preço de renovação ~2× o promocional; CPU compartilhada |
| **Contabo Cloud VPS 10** | 4 vCPU / 8 GB / 75 GB NVMe | **~R$ 32 (€5,36)** | Fixo, EU/US (sem BR) | ~200 ms | Melhor custo/spec do mercado | Datacenter fora do BR (IP estrangeiro = mais risco de flag no chip WA); latência irrelevante para o bot, relevante para o risco |
| **Vultr São Paulo** | 1 vCPU / 2 GB / 55 GB | **~R$ 66 (US$ 12)** | Fixo, BR | Ótima | Cloud "de verdade" com região GRU, snapshots, API | 2× o preço do Hostinger pelo mesmo efeito |
| **AWS Lightsail São Paulo** | 2 vCPU / 2 GB / 60 GB | **~R$ 66–80 (US$ 12 + impostos)** | Fixo (static IP), BR | Ótima | Ecossistema AWS, snapshots fáceis | Mais caro; 2 GB fica justo com Chromium + Postgres juntos |
| **Fly.io (GRU)** | shared-1x / 2 GB + volume | **~R$ 60–75 (US$ 11–14)** | IPv4 dedicado +US$ 2/mês | Ótima | Deploy por Dockerfile, região GRU | Machines efêmeras: `auth_info` exige volume; restart/migração de host muda comportamento de rede; mais peças móveis para um bot que precisa ficar parado e quieto |
| **Railway** | ~2 GB always-on | **~R$ 55–110 (usage)** | Dinâmico, sem BR | Média | Zero-config | IP dinâmico = pior caso para Baileys; custo imprevisível; **evitar** |
| **Servidor em casa (mini-PC/RPi 5)** | 4 cores / 8 GB | **R$ 5–15 (energia)** + R$ 500–900 hardware 1× | Residencial (o que o WhatsApp mais "gosta"), dinâmico com DDNS | Ótima | IP residencial reduz risco de ban; custo marginal quase zero; controle total | Sem SLA: queda de luz/internet para o bot; você vira o on-call; precisa DDNS/Tailscale para acesso |

⭐ = recomendação. Justificativa: **IP fixo em datacenter brasileiro é o fator
que mais reduz o risco operacional real do projeto (ban do chip)**, e o
Hostinger entrega isso no menor preço. O `deploy/README.md` do repo já aponta
para essa conclusão.

### E a API oficial do WhatsApp (Cloud API)?

Não é alternativa: a Cloud API **não posta em grupos** (só conversas 1:1 e
templates pagos — marketing ~US$ 0,0625/msg no BR). Para canal de ofertas em
grupo, Baileys é o único caminho — o custo "zero" embute o risco de ban, que a
app já mitiga (warmup por idade do chip, jitter, quiet hours, contadores).

---

## 3. Postgres e Redis: local vs gerenciado

| Opção | Custo/mês | Prós | Contras |
|---|---|---|---|
| **Local no VPS (docker compose)** ⭐ | R$ 0 | Zero latência, zero limite, backup já pronto (`deploy/backup.sh` + cron) | Você administra (na prática: 1 cron de `pg_dump` + rclone) |
| Supabase Free (Postgres) | R$ 0 | Região São Paulo, dashboard | 500 MB, pausa após 7d sem tráfego (o bot escreve todo dia, então ok), acoplamento externo desnecessário |
| Neon Free (Postgres) | R$ 0 | Branching, autosuspend | Região us-east (~120 ms), cold start no primeiro query do tick |
| RDS/Cloud SQL menor | R$ 90–150 | Gerenciado de verdade | Custa 3× o VPS inteiro. Overkill absoluto para MBs de dados |
| **Upstash Redis Free** | R$ 0 → **armadilha** | "Redis grátis" | Cobra **por comando** — BullMQ faz polling constante (delayed jobs, blocking ops) e estoura os 10k comandos/dia em horas. **Não usar com BullMQ** |

Veredito: **tudo local no VPS**. O volume de dados é minúsculo (MB), o
`docker-compose.yml` já declara os serviços com healthcheck e volume, e o
backup diário com off-site cobre o risco.

---

## 4. Serviços externos e seus custos

| Serviço | Papel | Custo/mês |
|---|---|---|
| Mercado Livre API | Fonte de ofertas + afiliado (OAuth já auto-renovado pelo `token-refresher`) | **R$ 0** |
| Groq (`llama-3.3-70b`) | Headlines dos posts (~12 chamadas/dia × ~400 tokens) | **R$ 0** (free tier cobre; pago seria < R$ 1) |
| DeepSeek (`deepseek-chat`) | Juiz LLM da zona cinza (teto: 10 calls/tick × 4 ticks = 40/dia) | **< R$ 3** (~1–2M tokens/mês a US$ 0,27/M in + US$ 1,10/M out) |
| Telegram Bot API | Publisher fase 1 | **R$ 0** |
| Sentry | Erros | **R$ 0** (free: 5k eventos/mês) |
| Healthchecks.io ou UptimeRobot | Watchdog externo (ping do cron / `/wa/health`) | **R$ 0** |
| Cloudflare R2 ou Backblaze B2 | Backup off-site (`pg_dump` + `auth_info` via rclone) | **R$ 0** (free: 10 GB) |
| Domínio (opcional) | HTTPS p/ `/oauth/callback` e admin remoto atrás de Caddy | R$ 0 (DuckDNS) ou ~R$ 3,30 (.com.br R$ 40/ano) |

Fallbacks já embutidos no código baixam ainda mais o risco de custo: sem
`GROQ_API_KEY` → headline `noop`; sem `DEEPSEEK_API_KEY` → juiz desligado;
`AFFILIATE_PROVIDER=json` → dispensa Chromium.

---

## 5. Cenários de custo total

| Cenário | Composição | Custo/mês | Tradeoff central |
|---|---|---|---|
| **Custo zero** | Oracle Free ARM (GRU) + compose + R2 backup + free tiers | **R$ 0–3** | Depende de conseguir capacidade ARM free em São Paulo; risco (baixo) de reclaim; sem suporte |
| **Recomendado** ⭐ | Hostinger KVM 2 (BR) + compose + backups R2 + DeepSeek | **R$ 30–45 promo / R$ 58–73 renovação** | Paga pouco pelo fator que mais importa: IP fixo BR + previsibilidade |
| **Custo/spec máximo** | Contabo 8 GB (EU) + compose + DeepSeek | **~R$ 35** | Aceita IP europeu → risco maior de flag no chip WA |
| **Cloud "séria"** | Lightsail/Vultr GRU 2 GB + compose + DeepSeek | **~R$ 70–85** | Snapshots e ecossistema por ~2× o preço; nada que o bot exija |
| **Casa** | Mini-PC usado + Tailscale + DDNS | **R$ 5–15** (+ hardware 1×) | Melhor IP possível (residencial), pior disponibilidade (luz/net); você é o SLA |

Em qualquer cenário, o software é o mesmo: `docker compose up -d` ou o
`deploy/install.sh` (systemd). A decisão é só *onde* e *quanto risco de ban vs
custo vs disponibilidade* você aceita.

---

## 6. Checklist "100% autônomo"

Infra provisionada não basta — estes itens fecham o loop sem humano:

**Configuração (uma vez):**
- [ ] Parear WhatsApp localmente e `rsync ./auth_info` para o servidor (QR não aparece bem em log)
- [ ] Autorizar ML uma vez via `/oauth/authorize` (depois o `token-refresher` renova sozinho; token fica no Postgres)
- [ ] `API_KEY` forte (boot **recusa** produção sem ela), `SENTRY_DSN`, `ML_AFFILIATE_TAG`, `WA_TARGET_JID`
- [ ] Fase 0 (warmup): `SCHEDULER_ENABLED=true` + `SCHEDULER_DISPATCH_ENABLED=false` por 1–2 semanas até `PriceHistory` ter ≥7 dias (barreira anti-fake precisa de mediana)
- [ ] Depois: ligar dispatch; conferir `CATEGORY_WEIGHTS`, quiet hours (23h–7h), `MAX_DEALS_PER_RUN=3`

**Resiliência (já suportado, só ativar):**
- [ ] `restart: unless-stopped` (compose) ou `Restart=always` (systemd) — auto-recuperação de crash
- [ ] Healthcheck Docker já aponta para `/wa/health`; adicionar watchdog externo (UptimeRobot em `/wa/health` via Caddy, ou Healthchecks.io pingado pelo cron de backup)
- [ ] Alertas Sentry por e-mail/Telegram para: desconexão WA além de `WA_MAX_RECONNECTS`, falha de refresh do token ML, tick com erro
- [ ] Backup diário: cron `deploy/backup.sh` (pg_dump, retenção 14d) + `rclone` semanal de `/var/backups/wpp-bot` **e `auth_info`** para R2/B2 — perder `auth_info` = re-parear chip
- [ ] Logrotate (já em `deploy/logrotate.conf`), `unattended-upgrades`, UFW só 22 (e 443 se usar Caddy), fail2ban

**O que ainda exige humano (por design):**
- Re-scan de QR se o WhatsApp derrubar a sessão de vez (raro com IP estável; alerta via Sentry/watchdog)
- Ban do chip → chip novo + warmup (`WA_CHIP_FIRST_USE_DATE`)

---

## 7. Riscos de infra, ranqueados

1. **Ban do chip WhatsApp** — o maior risco do projeto inteiro, e não se resolve
   com dinheiro em servidor: mitiga com IP fixo BR, warmup, jitter da fila,
   quiet hours, ≤4 posts/dia (tudo já implementado). Plano B: publisher
   Telegram já existe no código.
2. **Perda de `auth_info`** — backup off-site resolve; sem ele, todo redeploy
   vira re-pareamento.
3. **Oracle Free reclaim / indisponibilidade GRU** (só no cenário R$ 0) —
   mitigável convertendo para PAYG (segue gratuito) e mantendo backup para
   migrar para VPS pago em <1h.
4. **Estouro de RAM com Chromium** em VPS de 1 GB — usar 2 GB ou
   `AFFILIATE_PROVIDER=json` + swap de 2 GB.
5. **Renovação do Hostinger a preço cheio** — pagar 12–24 meses no promo ou
   migrar (o stack inteiro é `rsync auth_info + pg_dump | restore + compose up`).

---

## TL;DR

- **Precisa de**: 1 VPS (2 vCPU / 2 GB / 20 GB) com IP fixo — de preferência no
  Brasil — rodando o docker-compose do repo (app + Postgres + Redis), disco
  persistente para `auth_info`, backups com cópia off-site, Sentry + watchdog
  externo. Nada de serverless, nada de múltiplas réplicas.
- **Custo**: R$ 0–3/mês (Oracle Free, se conseguir GRU) ou **R$ 30–45/mês no
  cenário recomendado** (Hostinger KVM 2), com APIs de LLM somando menos de
  R$ 5/mês nos tetos atuais.
- **Tradeoff que governa a escolha**: risco de ban do chip (IP) × custo ×
  disponibilidade — não performance. Qualquer opção da tabela aguenta a carga
  com folga.
