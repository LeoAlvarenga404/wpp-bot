#!/usr/bin/env bash
#
# install.sh — Bootstrap a fresh Ubuntu/Debian VPS to run wpp-bot.
#
# Run as root:
#   curl -fsSL https://example.com/install.sh | sudo bash
# Or after cloning:
#   sudo bash deploy/install.sh
#
# What it does:
#   - apt update + base tools (curl, ca-certs, git, build-essential)
#   - installs Node.js 22 from NodeSource
#   - creates `wppbot` system user
#   - clones the repo into /opt/wpp-bot (placeholder URL — edit before running)
#   - installs npm deps and builds
#   - installs the systemd unit and logrotate config
#   - enables + starts the service
#
# Idempotent: re-running upgrades the checkout and restarts the service.

set -euo pipefail

# ---- Config (edit these) ----------------------------------------------------
REPO_URL="${REPO_URL:-https://github.com/YOUR_ORG/wpp-bot.git}"
APP_DIR="/opt/wpp-bot"
APP_USER="wppbot"
ENV_DIR="/etc/wpp-bot"
LOG_DIR="/var/log/wpp-bot"
NODE_MAJOR=22

# ---- Helpers ---------------------------------------------------------------
log() { printf '\n\033[1;36m[install]\033[0m %s\n' "$*"; }
require_root() {
  if [[ $EUID -ne 0 ]]; then
    echo "Must be run as root (sudo bash $0)" >&2
    exit 1
  fi
}

require_root

log "Updating apt and installing base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl ca-certificates git build-essential gnupg logrotate

if ! command -v node >/dev/null 2>&1 || \
   [[ "$(node -v 2>/dev/null | sed 's/v\([0-9]*\).*/\1/')" -lt "$NODE_MAJOR" ]]; then
  log "Installing Node.js ${NODE_MAJOR}.x from NodeSource"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi

log "Node $(node -v), npm $(npm -v)"

if ! id "$APP_USER" >/dev/null 2>&1; then
  log "Creating system user '$APP_USER'"
  useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"
fi

log "Preparing dirs"
mkdir -p "$APP_DIR" "$ENV_DIR" "$LOG_DIR"
chown -R "$APP_USER:$APP_USER" "$APP_DIR" "$LOG_DIR"
chown root:"$APP_USER" "$ENV_DIR"
chmod 750 "$ENV_DIR"

if [[ ! -d "$APP_DIR/.git" ]]; then
  log "Cloning $REPO_URL -> $APP_DIR"
  sudo -u "$APP_USER" git clone "$REPO_URL" "$APP_DIR"
else
  log "Updating existing checkout in $APP_DIR"
  sudo -u "$APP_USER" git -C "$APP_DIR" fetch --all --prune
  sudo -u "$APP_USER" git -C "$APP_DIR" pull --ff-only
fi

log "Installing npm deps (prod only) and building"
sudo -u "$APP_USER" bash -lc "cd '$APP_DIR' && npm ci && npm run build"

# Provision env file if missing — admin must fill it in.
if [[ ! -f "$ENV_DIR/env" ]]; then
  log "Creating template $ENV_DIR/env (chmod 600) — EDIT THIS FILE"
  cp "$APP_DIR/.env.example" "$ENV_DIR/env"
  chown root:"$APP_USER" "$ENV_DIR/env"
  chmod 640 "$ENV_DIR/env"
fi

log "Installing systemd unit"
install -m 0644 "$APP_DIR/deploy/systemd/wpp-bot.service" /etc/systemd/system/wpp-bot.service

log "Installing logrotate config"
install -m 0644 "$APP_DIR/deploy/logrotate.conf" /etc/logrotate.d/wpp-bot

systemctl daemon-reload
systemctl enable wpp-bot.service
systemctl restart wpp-bot.service

log "Done. Check status with: systemctl status wpp-bot"
log "Tail logs with:           journalctl -u wpp-bot -f"
log "App logs:                 tail -f $LOG_DIR/app.log"
log "Remember to edit:         $ENV_DIR/env"
