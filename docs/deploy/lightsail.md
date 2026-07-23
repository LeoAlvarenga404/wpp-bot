# Deploy — AWS Lightsail (single box)

Arquitetura: **1 instância Lightsail** roda tudo via `docker-compose` — Nest
(API + serve a SPA de curadoria + worker BullMQ + Baileys + Playwright) +
Postgres + Redis (containers). Exposição/proteção por **Cloudflare Tunnel +
Access** (sem porta pública). Custo ~$12/mês (2GB), coberto pelo crédito AWS.

Por que não ECS: Fargate + RDS + ElastiCache + ALB custa ~$40-70/mês para uma
única instância stateful e não resolve as restrições do Baileys (uma instância
só) nem do Playwright (login persistente). VPS/Lightsail é mais barato e simples.

---

## Restrições que moldam o deploy

- **Baileys = um dono só.** Exatamente 1 container. Sem autoscaling. Deploy
  para-e-sobe (nunca 2 apps concorrendo pela sessão WhatsApp → erro 440).
- **Playwright precisa de sessão logada.** O login usa browser *headed* (tela),
  impossível num server headless. Solução: gerar `auth_info/playwright-state.json`
  no **seu micro** e copiar para a instância (igual às credenciais do Baileys).
- **Estado em disco:** `auth_info/` (QR Baileys + state Playwright), `data/`,
  `config/`. Backup = snapshot do Lightsail.

---

## Fase 0 — Pré-requisitos

- Conta AWS (crédito) + Lightsail.
- Domínio no Cloudflare (ou subdomínio de um que você já controla).
- No seu micro: repo clonado, Docker, e o Playwright já logado uma vez
  (arquivo `auth_info/playwright-state.json` existindo localmente).

---

## Fase 1 — Criar a instância

1. Lightsail → Create instance → região **sa-east-1 (São Paulo)**.
2. Plataforma **Linux/Unix**, blueprint **Ubuntu 22.04 LTS**.
3. Plano **2 GB RAM / 2 vCPU** (~$12/mês). Se der OOM em scrape pesado, resize
   para 4GB depois (snapshot → instância maior, ~2 min).
4. Firewall Lightsail: manter só **SSH (22)**. NÃO abrir 80/443 — o Cloudflare
   Tunnel faz a saída, nada de inbound público.

## Fase 2 — Preparar o host

```bash
# via SSH na instância
sudo apt-get update && sudo apt-get upgrade -y

# Docker + compose plugin
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu   # relogar depois

# Swap de 2GB — colchão pro pico do Chromium num box de 2GB
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
free -h   # confirmar Swap: 2.0G
```

## Fase 3 — Subir o bot

# O repo é PRIVADO — `git clone` HTTPS anônimo dá 403. Enviar o código do
# micro via git archive (só arquivos rastreados, sem node_modules/.env):
#   git archive --format=tar main | ssh -i chave.pem ubuntu@IP \
#     'mkdir -p ~/wpp-bot && tar -x -C ~/wpp-bot'
# (ou configurar deploy key/PAT no box e clonar normalmente)

```bash
cd ~/wpp-bot
mkdir -p auth_info data config

# .env de produção (ver bloco abaixo)
nano .env

# Copiar do SEU micro para a instância (rodar no micro):
#   scp -i chave.pem auth_info/playwright-state.json ubuntu@IP:~/wpp-bot/auth_info/
#   (Playwright: state logado do ML — headless no box lê e roda)
# ML token da API (evita OAuth + redirect): exportar do DB do micro para
#   auth_info/ml-token.json no box — o app faz backfill p/ o DB no 1º boot.
#   Shape: {access_token, refresh_token, expires_at (ms), user_id, scope,
#   obtained_at}. Sem isso: GET /oauth/authorize (precisa redirect alcançável).

# IMPORTANTE: usar docker-compose.box.yml (NÃO prod.yml). base + prod
# CONCATENAM as listas `ports` e dão bind duplo em 5433/6380 ("address
# already in use"); box.yml faz !override — pg/redis internos, app em :3000.
docker compose -f docker-compose.yml -f docker-compose.box.yml up -d --build
docker compose -f docker-compose.yml -f docker-compose.box.yml logs -f app  # boot + QR Baileys
```

### `.env` de produção (mínimo)

```dotenv
NODE_ENV=production
PORT=3000
API_KEY=<32+ chars aleatórios>          # app recusa boot sem isso em prod
DATABASE_URL=postgresql://wppbot:<senha forte>@postgres:5432/wppbot?schema=public
POSTGRES_PASSWORD=<mesma senha forte>

# Alvos
WA_TARGET_JID=<grupo@g.us>
TELEGRAM_CHAT_ID=<id>
TELEGRAM_BOT_TOKEN=<token>

# Playwright: provider logado + tuning de baixa RAM (box de 2GB)
AFFILIATE_PROVIDER=playwright
SCRAPE_CONCURRENCY=1                     # 1 browser por vez (era 2) — segura o pico

# LLM juiz (opcional; o autônomo funciona sem)
DEEPSEEK_API_KEY=<key>
JUDGE_ENABLED=true
```

> Flags de baixa-RAM do Chromium (`--disable-dev-shm-usage`, `--disable-gpu`)
> já estão no `playwright-adapter.ts` — evitam crash de `/dev/shm` no container.

## Fase 4 — Migrate + QR + login Playwright

```bash
# Migrations (o entrypoint já roda migrate deploy; se precisar manual:)
docker compose exec app npx prisma migrate deploy

# Baileys: escanear o QR que aparece em `docker compose logs -f app`
#   (WhatsApp → Aparelhos conectados → Conectar aparelho)

# Playwright: NÃO logar aqui (server sem tela). O state veio do seu micro
# (Fase 3). Se expirar, relogar no micro e re-copiar o playwright-state.json.
```

## Fase 5 — Cloudflare Tunnel + Access

```bash
# cloudflared na instância
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cloudflared.deb
sudo dpkg -i cloudflared.deb
cloudflared tunnel login
cloudflared tunnel create wpp-bot
# rota o hostname para o app local (127.0.0.1:3000)
cloudflared tunnel route dns wpp-bot painel.SEUDOMINIO.com
```

`~/.cloudflared/config.yml`:

```yaml
tunnel: wpp-bot
credentials-file: /home/ubuntu/.cloudflared/<tunnel-id>.json
ingress:
  - hostname: painel.SEUDOMINIO.com
    service: http://127.0.0.1:3000
  - service: http_status:404
```

```bash
sudo cloudflared service install
sudo systemctl enable --now cloudflared
```

Depois, no dashboard Cloudflare Zero Trust → **Access → Applications**:
adicionar `painel.SEUDOMINIO.com`, policy por e-mail/Google. Isso protege o
painel e a API mesmo com o `x-api-key` (defesa em profundidade).

## Fase 6 — Validar

1. Abrir `https://painel.SEUDOMINIO.com` → passar pelo Access → painel carrega.
2. Aba **Fila** deve listar pendentes (prova que a API responde).
3. Criar um deal manual → **Dispara já** → conferir no grupo de teste.
4. `docker stats` sob scrape para ver o pico de RAM; se encostar no limite,
   resize para 4GB.

---

## Operação

- **Deploy de update:** enviar o código novo do micro
  (`git archive --format=tar main | ssh ... 'tar -x -C ~/wpp-bot'`), então
  `docker compose -f docker-compose.yml -f docker-compose.box.yml up -d --build`
  (para-e-sobe; Baileys reconecta com o state salvo, sem novo QR).
- **Backup:** snapshot do Lightsail (pega os volumes) + `pg_dump` opcional.
- **Sessão Playwright expirou** (deals sem link de afiliado / scrape falhando):
  relogar no micro → `scp` do `playwright-state.json` → `docker compose restart app`.
- **RAM apertada:** `SCRAPE_CONCURRENCY=1` já ajuda; próximo passo é resize 4GB
  ou adotar "colar link afiliado no painel" (dispensa Playwright, cai pra 1GB).
