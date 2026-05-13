#!/usr/bin/env bash
#
# backup.sh — Cron-friendly Postgres backup for wpp-bot.
#
# Usage (via cron, daily 03:30):
#   30 3 * * * /opt/wpp-bot/deploy/backup.sh >> /var/log/wpp-bot/backup.log 2>&1
#
# Reads connection info from /etc/wpp-bot/env (DATABASE_URL).
# Writes timestamped gzipped dumps to $BACKUP_DIR (default /var/backups/wpp-bot).
# Retains the last N days (default 14).
#
# Exit codes:
#   0  backup written
#   1  config / dependency error
#   2  pg_dump failed

set -euo pipefail

ENV_FILE="${ENV_FILE:-/etc/wpp-bot/env}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/wpp-bot}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"

if [[ ! -r "$ENV_FILE" ]]; then
  echo "[backup] cannot read $ENV_FILE" >&2
  exit 1
fi

# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "[backup] DATABASE_URL not set in $ENV_FILE" >&2
  exit 1
fi

if ! command -v pg_dump >/dev/null 2>&1; then
  echo "[backup] pg_dump not found — install postgresql-client" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
chmod 750 "$BACKUP_DIR"

ts="$(date -u +%Y%m%dT%H%M%SZ)"
out="$BACKUP_DIR/wppbot-${ts}.sql.gz"

echo "[backup] $(date -Iseconds) -> $out"
if ! pg_dump --no-owner --no-privileges "$DATABASE_URL" | gzip -9 > "$out.tmp"; then
  rm -f "$out.tmp"
  echo "[backup] pg_dump failed" >&2
  exit 2
fi
mv "$out.tmp" "$out"
chmod 640 "$out"

# Prune old backups.
find "$BACKUP_DIR" -name 'wppbot-*.sql.gz' -mtime "+$RETENTION_DAYS" -delete

echo "[backup] ok ($(du -h "$out" | cut -f1))"
