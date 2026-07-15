#!/bin/sh
# Container entrypoint.
#
# Applies pending Prisma migrations (idempotent — no-op if already up to date)
# before exec'ing the Nest app. Runs in the same process so the app does not
# start serving traffic while the schema is still being modified.
#
# If `DATABASE_URL` is unset, migration is skipped and the app boots in
# file-backed legacy mode. This keeps local-dev flows that don't bring up
# Postgres workable without editing the Dockerfile.
set -e

if [ -n "$DATABASE_URL" ]; then
  echo "[entrypoint] DATABASE_URL set — running prisma migrate deploy"
  npx prisma migrate deploy
else
  echo "[entrypoint] DATABASE_URL not set — skipping prisma migrate deploy"
fi

exec "$@"
