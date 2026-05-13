# Deploy

Production deployment guide for `wpp-bot`. Target: a small Linux VPS running
the bot under systemd, 24/7, with logs and Postgres backups rotated.

---

## 1. Pick a host

| Option | Price | Pros | Cons |
|---|---|---|---|
| **Hostinger KVM 2** | R$ 25-50/mo | BR datacenter, fixed IPv4, 2GB RAM | shared CPU bursts |
| **Contabo VPS S** | €4-6/mo | More RAM (8GB), generous storage | EU datacenter (latency to BR) |
| **Fly.io** | free → ~$5/mo | Docker-native, easy scaling | dynamic IP may trigger Baileys re-auth |
| **Railway** | $5-10/mo | zero-config | dynamic IP, costs scale fast |

Recommendation: **Hostinger or Contabo** for stable IP (Baileys is happier with a
sticky residential-looking IP). Use Fly.io/Railway only if you accept occasional
QR re-scans.

Minimum specs: 1 vCPU, 1 GB RAM, 20 GB disk, Ubuntu 22.04 or 24.04.

---

## 2. One-shot bootstrap

SSH in as root and run:

```bash
# 1. Pull the install script (or scp it from your laptop).
curl -fsSL https://raw.githubusercontent.com/YOUR_ORG/wpp-bot/main/deploy/install.sh -o /tmp/install.sh

# 2. Edit REPO_URL at the top, then:
sudo bash /tmp/install.sh
```

The script:
- installs Node.js 22 from NodeSource
- creates the `wppbot` system user
- clones to `/opt/wpp-bot`, runs `npm ci && npm run build`
- copies `.env.example` -> `/etc/wpp-bot/env` (mode 640, group `wppbot`) — **edit this**
- installs `/etc/systemd/system/wpp-bot.service`
- installs `/etc/logrotate.d/wpp-bot`
- `systemctl enable --now wpp-bot`

---

## 3. Configure `/etc/wpp-bot/env`

```bash
sudo -e /etc/wpp-bot/env
sudo chmod 600 /etc/wpp-bot/env   # tighten once filled
```

Set at minimum:
- `ML_CLIENT_ID`, `ML_CLIENT_SECRET`, `ML_REDIRECT_URI`, `ML_AFFILIATE_TAG`
- `WA_TARGET_JID`
- `API_KEY` (random 32+ char hex; required to call `/pipeline/*` and `/affiliate/*`)
- `DATABASE_URL` (point at Postgres — see step 5)
- `SENTRY_DSN` (optional but recommended)

After editing:

```bash
sudo systemctl restart wpp-bot
sudo journalctl -u wpp-bot -f
```

---

## 4. First-time WhatsApp pairing

The bot expects an existing Baileys session at `/opt/wpp-bot/auth_info`. If
that directory is empty, the QR appears in stdout — but stdout is going to a
log file, so the easiest flow is:

```bash
# On your laptop, pair locally first (creates ./auth_info), then upload:
rsync -avz ./auth_info/ root@VPS:/opt/wpp-bot/auth_info/
sudo chown -R wppbot:wppbot /opt/wpp-bot/auth_info
sudo systemctl restart wpp-bot
```

Verify: `curl -s http://localhost:3000/wa/health` should return `connected: true`.

---

## 5. Postgres

The systemd unit assumes Postgres is reachable per `DATABASE_URL`. Either:

**(a) Install on the same host:**

```bash
sudo apt-get install -y postgresql postgresql-client
sudo -u postgres createuser --pwprompt wppbot
sudo -u postgres createdb -O wppbot wppbot
```

Then in `/etc/wpp-bot/env`:
```
DATABASE_URL=postgresql://wppbot:PASSWORD@localhost:5432/wppbot?schema=public
```

**(b) Run the bundled docker-compose stack** (simpler if you already use Docker):

```bash
cd /opt/wpp-bot && docker compose up -d postgres
```

Apply schema once code uses Prisma (P1-9):
```bash
sudo -u wppbot bash -lc 'cd /opt/wpp-bot && npx prisma migrate deploy'
```

---

## 6. Backups

`deploy/backup.sh` dumps Postgres to `/var/backups/wpp-bot/` and prunes older
than 14 days. Wire it via cron:

```bash
sudo apt-get install -y postgresql-client
sudo crontab -e
# Add:
30 3 * * * /opt/wpp-bot/deploy/backup.sh >> /var/log/wpp-bot/backup.log 2>&1
```

Off-site copies (recommended): rclone the `BACKUP_DIR` to S3/B2/R2 weekly.

---

## 7. Log rotation

Already wired by the installer. Defaults (see `deploy/logrotate.conf`):

- `daily`, 14 rotations, `gzip` compressed
- `app.log` is the systemd `StandardOutput`/`StandardError` sink
- HUP signaled to the service so the fd is reopened on rotate

To inspect:

```bash
ls -lah /var/log/wpp-bot/
sudo logrotate -d /etc/logrotate.d/wpp-bot   # dry run
```

---

## 8. Useful commands

```bash
systemctl status wpp-bot
systemctl restart wpp-bot
journalctl -u wpp-bot -f
journalctl -u wpp-bot --since '10 minutes ago'

# Update to latest main:
cd /opt/wpp-bot
sudo -u wppbot git pull
sudo -u wppbot bash -lc 'cd /opt/wpp-bot && npm ci && npm run build'
sudo systemctl restart wpp-bot
```

---

## 9. Firewall

Expose only what you need. Typical:

```bash
sudo ufw allow 22/tcp        # SSH
sudo ufw allow 443/tcp       # if you front the bot with a reverse proxy
sudo ufw enable
```

Do **not** expose port 3000 directly to the public internet. Put it behind
Caddy/Nginx with TLS and pass the `x-api-key` header through.
