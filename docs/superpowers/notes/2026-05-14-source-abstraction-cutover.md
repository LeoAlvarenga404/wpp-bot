# Source Abstraction Cutover Notes (2026-05-14)

## Pre-deploy

1. Confirm staging passes `npm test` + `npx tsc --noEmit`.
2. Backup prod `data/price-history.json` and `data/posted-log.json` manually
   (in addition to the automatic `.pre-refactor-bak` files created on boot).
3. Confirm `SOURCES_ENABLED=ml` (default) and `SOURCES_MIGRATION_BACKUP=true`
   in the prod env.

## Deploy

1. Deploy with `SCHEDULER_ENABLED=false`.
2. Hit `GET /pipeline/preview` to confirm ML discovery still works.
3. Set `SCHEDULER_ENABLED=true` and `SCHEDULER_MODE=batch` with `WA_TARGET_JID`
   pointing to a test JID.
4. Observe 3 ticks. Validate:
   - log line `Scheduler tick batch - totalScored=N dispatched=K topScore=X`
   - no Sentry errors
   - score distribution against prior baseline ≤ 5% drift
5. Flip `WA_TARGET_JID` back to production target.

## Rollback

1. Revert the merge commit on `main`.
2. Restore `data/price-history.json` and `data/posted-log.json` from
   `.pre-refactor-bak`.
3. Re-deploy.

## Post-deploy

1. Set `SOURCES_MIGRATION_BACKUP=false` after 24h of clean operation.
2. Mark the source-abstraction sub-project complete in `docs/superpowers/plans/`.
3. Open the next sub-project (Shopee adapter) per the spec roadmap.
