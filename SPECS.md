# wpp-bot — Specs

Spec doc for items needed to make the bot production-grade. Organized by priority phase.
Each spec lists Goal, Files touched, Dependencies, Acceptance, Implementation sketch.

> Scope: **Mercado Livre + WhatsApp only**. Multi-marketplace / Telegram / web frontend deferred.

---

## Phase P0 — Critical (must run 24/7 unattended)

### P0-1. Cron scheduling

**Goal**: Auto-trigger pipeline on schedule. Replace manual REST.http calls.

**Files**:
- `src/scheduler/scheduler.module.ts` (new)
- `src/scheduler/scheduler.service.ts` (new)
- `src/app.module.ts` (register)
- `.env` (add `SCHEDULER_ENABLED`, `SCHEDULER_CRON`)

**Deps**: `@nestjs/schedule`

**Acceptance**:
- Bot posts 3-5 deals/day automatically without user intervention
- Cron expression configurable via env
- Off by default in dev (`SCHEDULER_ENABLED=false`)
- Logs each scheduled run with timestamp + result

**Sketch**:
```typescript
@Injectable()
export class SchedulerService {
  @Cron(process.env.SCHEDULER_CRON ?? '0 10,13,17,20 * * *')
  async tick() {
    if (process.env.SCHEDULER_ENABLED !== 'true') return;
    // rotate category, call pipeline.runOnce
  }
}
```

Default schedule: 10h, 13h, 17h, 20h (4 posts/day, decent for Tier-1 chip).

---

### P0-2. Dedup (no duplicate posts)

**Goal**: Never post the same `catalogId` (or `itemId`) within a configurable window (default 7 days).

**Files**:
- `src/dedup/dedup.module.ts` (new)
- `src/dedup/dedup.service.ts` (new)
- `src/pipeline/pipeline.service.ts` (consult before send)

**Deps**: None for v1 (file-backed). Migrate to Postgres in P1.

**Acceptance**:
- `dedup.markPosted(catalogId)` persists entry with timestamp
- `dedup.wasRecentlyPosted(catalogId, windowDays)` returns boolean
- Pipeline skips deals where `wasRecentlyPosted(id, 7)` true
- Storage: `./data/posted-log.json` (gitignored)

**Sketch**:
```typescript
{
  "MLB66122676": "2026-05-13T18:00:00.000Z",
  "MLB54014512": "2026-05-12T10:30:00.000Z"
}
```

GC: prune entries older than `2 * windowDays` on every load.

---

### P0-3. Quiet hours

**Goal**: Block sends 23h-7h local time. User opt-in window configurable.

**Files**:
- `src/scheduler/quiet-hours.guard.ts` (new) or inline in `scheduler.service.ts`
- `.env` (`QUIET_START=23`, `QUIET_END=7`, `TZ=America/Sao_Paulo`)

**Acceptance**:
- Scheduler tick + manual trigger both short-circuit during quiet window
- Returns `{ skipped: true, reason: 'quiet_hours' }`
- Configurable via env

**Sketch**:
```typescript
private isQuiet(): boolean {
  const hour = new Date().toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: 'America/Sao_Paulo' });
  const h = Number(hour);
  return h >= QUIET_START || h < QUIET_END;
}
```

---

### P0-4. Affiliate disclaimer

**Goal**: Comply with affiliate marketing regulation. Every post visibly tagged.

**Files**:
- `src/pipeline/formatter.service.ts` (append footer)
- `src/whatsapp/wa.service.ts` (`pinTopicMessage` helper) — optional v2
- New env: `AFFILIATE_DISCLAIMER`

**Acceptance**:
- Every published message ends with a one-line disclaimer (configurable text)
- Default text: `"Link de afiliado. Posso receber comissão sem custo extra pra você."`
- Group description text suggestion documented in README

**Sketch**:
```typescript
const lines = [..., `_${this.disclaimer}_`];
```

---

### P0-5. Retry/backoff for ML calls

**Goal**: Survive transient ML failures (429, 5xx, network).

**Files**:
- `src/mercado-livre/ml.service.ts` (wrap `get<T>` in retry helper)
- `src/shared/retry.ts` (new — exponential backoff with jitter)

**Acceptance**:
- 5 attempts, base 1s, max 60s, jitter ±25%
- Retry on: 429, 500, 502, 503, 504, ECONNRESET, ETIMEDOUT
- No retry on: 400, 401 (refresh first), 403, 404
- Surfaces final failure with status + body in log

**Sketch**:
```typescript
export async function withRetry<T>(fn: () => Promise<T>, opts?: RetryOpts): Promise<T> {
  let delay = opts?.baseMs ?? 1000;
  for (let i = 0; i < (opts?.maxAttempts ?? 5); i++) {
    try { return await fn(); }
    catch (err) {
      if (!shouldRetry(err)) throw err;
      await sleep(delay + jitter(delay));
      delay = Math.min(delay * 2, opts?.maxMs ?? 60_000);
    }
  }
  throw new Error('retry exhausted');
}
```

---

### P0-6. Baileys health-check + auto-reconnect + alert

**Goal**: Detect dead WhatsApp session and recover. Alert if unrecoverable.

**Files**:
- `src/whatsapp/wa.service.ts` (extend existing reconnect)
- `src/whatsapp/wa-health.controller.ts` (new — `/wa/health`)

**Acceptance**:
- `GET /wa/health` returns `{ connected, lastSeen, reconnectAttempts }`
- Exponential backoff on reconnect (1s → 60s, cap)
- After N failed reconnects (default 10), emit error to Sentry + stop trying
- On `loggedOut`: do not retry, log clear "need to scan QR again"

**Sketch**: extend current `connection.update` handler with attempt counter.

---

### P0-7. Structured logging + Sentry

**Goal**: JSON logs to stdout. Errors auto-shipped to Sentry. Sensitive data scrubbed.

**Files**:
- `src/main.ts` (replace default logger with pino)
- `src/shared/logger.ts` (new — pino instance with redaction)
- `.env` (`SENTRY_DSN`, `LOG_LEVEL`)

**Deps**: `nestjs-pino`, `pino`, `pino-http`, `@sentry/node`

**Acceptance**:
- All logs are valid JSON
- Fields: `level`, `time`, `msg`, `requestId`, `module`
- `Authorization`, `cookie`, `access_token`, `client_secret`, `refresh_token` redacted from log payloads
- Uncaught exceptions reach Sentry within 10s
- Local dev: pretty-print via `pino-pretty`

---

### P0-8. Proactive ML token refresh + alert

**Goal**: Never serve a request with expired token. Alert when refresh fails (re-auth needed).

**Files**:
- `src/mercado-livre/ml-auth.service.ts` (already has skew. Add background refresh)
- `src/scheduler/token-refresher.service.ts` (new — cron every 30min)

**Acceptance**:
- Background job refreshes token when ≤ 30min from expiry
- If refresh fails 3× consecutive → ship error to Sentry with message `"ML reauth required — visit /oauth/authorize"`
- Endpoint `/oauth/status` returns token state (`hasToken`, `expiresAt`, `lastRefresh`)

---

## Phase P1 — Professionalism (quality + safety)

### P1-9. Postgres + Prisma

**Goal**: Replace file-backed state. Prepare for analytics.

**Files**:
- `prisma/schema.prisma` (new)
- `prisma/migrations/...`
- `src/db/prisma.service.ts` (new)
- Refactor: `ml-auth.service.ts`, `dedup.service.ts`, `json-cache-adapter.ts` use Prisma

**Deps**: `prisma`, `@prisma/client`. Postgres via Docker.

**Schema**:
```prisma
model Product {
  catalogId        String   @id
  title            String
  thumbnail        String?
  domainId         String?
  lastSeenAt       DateTime
  priceHistory     PriceHistory[]
  sentMessages     SentMessage[]
}

model PriceHistory {
  id          BigInt   @id @default(autoincrement())
  catalogId   String
  itemId      String
  priceCents  Int
  originalPriceCents Int?
  capturedAt  DateTime @default(now())
  product     Product  @relation(fields: [catalogId], references: [catalogId])
  @@index([catalogId, capturedAt])
}

model SentMessage {
  id          BigInt   @id @default(autoincrement())
  catalogId   String
  targetJid   String
  caption     String
  sentAt      DateTime @default(now())
  product     Product  @relation(fields: [catalogId], references: [catalogId])
  @@index([catalogId, sentAt])
}

model AffiliateLink {
  catalogId   String   @id
  shortUrl    String
  longUrl     String?
  generatedAt DateTime @default(now())
}

model MlToken {
  id           Int      @id @default(1)  // singleton
  accessToken  String
  refreshToken String?
  expiresAt    DateTime
  userId       BigInt?
  scope        String
  updatedAt    DateTime @updatedAt
}
```

**Acceptance**:
- `docker compose up` brings up Postgres
- `npm run migrate` applies schema
- Token, dedup, affiliate cache all read/write through Prisma
- `affiliate-links.json` migrated to `AffiliateLink` table on first boot

---

### P1-10. Fake-discount filter (median 30d)

**Goal**: Skip "fake promotion" — where seller inflates `original_price`.

**Files**:
- `src/curation/curation.service.ts` (new)
- `src/pipeline/pipeline.service.ts` (consult before publish)
- Uses `PriceHistory` table from P1-9

**Acceptance**:
- For each deal candidate:
  - Compute median of `priceCents` from last 30 days
  - Publish only if `currentPrice < median * 0.85`
  - If history < 7 days of data → skip (insufficient evidence) OR publish anyway with flag (configurable)
- Tag `🔻 Menor preço em N dias` added to caption when applicable

**SQL**:
```sql
SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY price_cents)
FROM price_history
WHERE catalog_id = $1 AND captured_at >= NOW() - INTERVAL '30 days';
```

---

### P1-11. Rotating message templates

**Goal**: Avoid Meta anti-spam pattern detection. 3-5 templates rotate per send.

**Files**:
- `src/pipeline/formatter.service.ts` (load templates, pick random)
- `src/pipeline/templates/*.txt` (new — handlebars-ish)

**Acceptance**:
- Minimum 3 templates with different copy/emoji variation
- Same product never uses same template twice (random with memory)
- All templates pass through `disclaimer` injection (P0-4)

**Templates** (examples):
```
🔥 *{{title}}*
💰 {{price}} (de {{regular}}) — {{discount}}% OFF
{{shipping}}
👉 {{link}}
```
```
✨ Achado: {{title}}
🏷️ De {{regular}} por {{price}} ({{discount}}% off)
{{shipping}}
🛒 {{link}}
```

---

### P1-12. Multi-category rotation

**Goal**: Don't post 5x of MLB1648 in a row. Rotate categories with weights.

**Files**:
- `src/scheduler/category-rotator.service.ts` (new)
- `.env` (`CATEGORY_WEIGHTS=MLB1648:3,MLB1000:2,MLB1051:2,MLB1276:1`)

**Acceptance**:
- Weighted random pick per cron tick
- No category posted 2× in a row
- Persists "last category" between restarts (via Postgres or simple file)

---

### P1-13. WhatsApp warmup

**Goal**: Avoid immediate Meta flag. Limit msgs/h scales with chip age.

**Files**:
- `src/whatsapp/rate-limiter.service.ts` (new)
- `.env` (`WA_CHIP_FIRST_USE_DATE=2026-05-13`)

**Schedule** (defaults):
| Age (days) | Max msgs/hour | Max msgs/day |
|---|---|---|
| 0-7 | 5 | 30 |
| 8-14 | 10 | 80 |
| 15-30 | 20 | 150 |
| 31+ | 50 | 400 |

**Acceptance**:
- Send attempts blocked when exceeded → returns `{ throttled: true }`
- Counters reset hourly/daily
- Counter persisted (Postgres) to survive restarts

---

### P1-14. DTO validation

**Goal**: Reject malformed requests with clear errors. Prevent crashes.

**Files**:
- `src/pipeline/dto/trigger.dto.ts` (new — class-validator)
- `src/pipeline/dto/preview.dto.ts`
- `src/main.ts` (`app.useGlobalPipes(new ValidationPipe({...}))`)

**Deps**: `class-validator`, `class-transformer`

**Acceptance**:
- `category` must match `/^MLB\d+$/`
- `minDiscount` integer 0-100
- `max` integer 1-50
- 400 with field-level error messages on invalid

---

### P1-15. API auth

**Goal**: Don't expose `/pipeline/trigger` and `/affiliate/*` publicly.

**Files**:
- `src/auth/api-key.guard.ts` (new)
- Apply guard to `pipeline.controller.ts`, `affiliate.controller.ts`
- `.env` (`API_KEY=...`)

**Acceptance**:
- Header `x-api-key: ...` required on protected endpoints
- 401 if missing/wrong
- Constant-time comparison (avoid timing attack)
- `/oauth/*` stays public (OAuth flow needs to be reachable from ML)

---

### P1-16. "Lowest price in N days" badge

**Goal**: Diff vs competitors — explicit transparency about price history.

**Files**:
- `src/curation/curation.service.ts` (compute badge text)
- `src/pipeline/formatter.service.ts` (insert in caption)

**Acceptance**:
- If today's price is the minimum in 30 days → badge `📉 Menor preço em 30 dias`
- Else if minimum in 14d → `📉 Menor preço em 14 dias`
- Else if minimum in 7d → `📉 Menor preço em 7 dias`
- Else: omit badge
- Skip badge when history < 7 days

---

### P1-17. High-res images

**Goal**: WhatsApp posts look polished — current thumbnails are 200×200.

**Files**:
- `src/pipeline/formatter.service.ts` (URL transform)

**Acceptance**:
- Replace `-O.jpg` / `-I.jpg` suffix with `-F.jpg` (full-size)
- Sample URL transform: `https://http2.mlstatic.com/D_NQ_NP_xxx-O.jpg` → `-F.jpg`
- Fallback to original if transform fails

---

### P1-18. Tests

**Goal**: Confidence to refactor. Catch regressions.

**Files**:
- `src/pipeline/formatter.service.spec.ts`
- `src/mercado-livre/ml.service.spec.ts`
- `src/dedup/dedup.service.spec.ts`
- `src/curation/curation.service.spec.ts`

**Acceptance**:
- Unit coverage ≥ 60% on services (excluding controllers and HTTP layers)
- All happy paths + at least 1 error path per service
- `npm test` runs in < 15s
- CI fails when tests fail

---

## Phase P2 — Scale (deploy + observability)

### P2-19. Playwright affiliate adapter

**Goal**: Auto-generate `meli.la/XXX` from URLs. Replace manual JSON cache.

**Files**:
- `src/affiliate/playwright-adapter.ts` (new)
- `src/affiliate/affiliate.module.ts` (swap provider via env)
- `.env` (`AFFILIATE_PROVIDER=json|playwright`)

**Deps**: `playwright` (with chromium download)

**Flow**:
1. First run: opens visible Chromium, user logs in ML painel manually, saves `storageState.json` in `auth_info/`
2. Subsequent runs: headless, loads storage state, opens `/afiliados/linkbuilder`, types URL into textarea, clicks "Gerar", waits for `short_url` in DOM (or intercepts `/affiliate-program/api/v2/affiliates/createLink` response), returns it
3. On 401 / login-redirect → log "session expired, re-login via headed mode" + fall back to JSON adapter

**Acceptance**:
- `affiliate.resolve(permalink)` returns real `meli.la/XXX` for any input
- Cached to `AffiliateLink` table (P1-9) — no regeneration if exists
- Session persists across restarts (`auth_info/playwright-state.json` gitignored)
- Falls back gracefully when ML changes UI

---

### P2-20. BullMQ + Redis queues

**Goal**: Decouple discovery / enrich / publish. Retry safely. Scale workers.

**Files**:
- `src/queues/queues.module.ts` (new)
- `src/queues/discovery.processor.ts`, `enrich.processor.ts`, `publish.processor.ts`
- `docker-compose.yml` (add Redis)

**Deps**: `@nestjs/bullmq`, `bullmq`, `ioredis`

**Pipeline**:
```
[cron] → enqueue("discovery", { category })
         ↓
  [discovery worker] /highlights, /products → enqueue("enrich", { catalogId })
         ↓
  [enrich worker] /products/X/items, price history check → enqueue("publish", { dealId })
         ↓
  [publish worker] formatter + wa.sendImage → mark dedup
```

**Acceptance**:
- Each step idempotent (job ID = `catalogId + window`)
- Failed jobs retry with exponential backoff (BullMQ defaults)
- `/queues/stats` returns queue depth + last completion times
- Worker concurrency configurable per queue

---

### P2-21. Dockerfile + docker-compose

**Files**:
- `Dockerfile` (multi-stage, node:22-alpine)
- `docker-compose.yml` (app + postgres + redis)
- `.dockerignore`

**Acceptance**:
- `docker compose up --build` brings full stack up
- App image < 250MB
- Postgres + Redis volumes persistent
- Healthchecks defined per service

---

### P2-22. CI/CD

**Files**:
- `.github/workflows/ci.yml`

**Steps**:
- Trigger: push to main + PRs
- Jobs: lint, build, test
- Cache npm
- Postgres service for integration tests (optional v2)

**Acceptance**:
- Required status checks before merge
- < 3min total runtime

---

### P2-23. Deploy

**Goal**: Run 24/7 on a VPS with fixed IP. Survive restarts.

**Options** (pick one):
- **Hostinger VPS** — R$ 25-50/month, 2GB RAM, fixed IP
- **Contabo** — €4-6/month, more RAM
- **Railway** — easier, but dynamic IP could trigger Baileys re-auth
- **Fly.io** — Docker-native, free tier may suffice

**Files**:
- `deploy/install.sh` (bootstrap script)
- `deploy/systemd/wpp-bot.service`
- `README.md` (deploy section)

**Acceptance**:
- App auto-restarts on crash (systemd `Restart=always`)
- Logs go to `/var/log/wpp-bot/` rotated daily
- Backup script for Postgres (`pg_dump` cron)
- `.env` provisioned at `/etc/wpp-bot/env` (chmod 600)

---

### P2-24. Metrics

**Goal**: See what's happening without grepping logs.

**Files**:
- `src/metrics/metrics.controller.ts` (Prometheus-format `/metrics` endpoint)
- `src/metrics/counters.service.ts`

**Deps**: `prom-client`

**Metrics**:
- `wpp_messages_sent_total{category=X}` counter
- `wpp_messages_failed_total{reason=Y}` counter
- `ml_api_requests_total{endpoint, status}` counter
- `ml_api_latency_ms` histogram
- `affiliate_cache_hits_total` / `affiliate_cache_misses_total`
- `dedup_skip_total`
- `baileys_connected` gauge (0/1)

**Acceptance**:
- Endpoint protected by API key (P1-15)
- Scrape-friendly format
- Grafana dashboard JSON committed in `deploy/grafana/`

---

### P2-25. Multi-group / Channel

**Goal**: Broadcast to N targets, not just one group.

**Files**:
- `src/whatsapp/wa.service.ts` (accept JID array)
- New table: `WaTarget { jid, name, active }`
- `.env` (`WA_TARGETS=jid1,jid2,jid3` for static config)

**Acceptance**:
- Pipeline sends to all active targets in parallel (with rate-limit respected globally)
- Failures logged per-target without blocking others
- Endpoint `/wa/targets` (POST/GET/DELETE) to manage at runtime

---

### P2-26. In-group commands

**Goal**: User in group types `/ofertas` → bot replies with N latest deals.

**Files**:
- `src/whatsapp/wa.service.ts` (`messages.upsert` handler)
- `src/whatsapp/command.handler.ts` (new — parse, dispatch)

**Commands**:
- `/ofertas` — list 3 deals from any category
- `/ofertas <categoria>` — list 3 from specific category (alias: `tech`, `casa`, `gamer`)
- `/ajuda` — show commands
- `/sair` (P2-27)

**Acceptance**:
- Only admins of the bot's own JID can trigger (config allowlist) OR open to all in dev
- Throttle 1 command/min/user

---

### P2-27. Opt-out

**Goal**: User types `/sair` or `STOP` → bot removes them (in group) or stops DM (1:1).

**Files**:
- `src/whatsapp/optout.service.ts` (new)
- Table `WaOptout { jid, addedAt }`

**Acceptance**:
- Pipeline never targets opted-out JID
- Group remove via `sock.groupParticipantsUpdate(groupJid, [userJid], 'remove')` (requires bot to be admin)
- Confirmation message DM'd to user

---

## Effort Summary

| Phase | Items | Hours | Outcome |
|---|---|---|---|
| P0 | 8 | ~10 | Runs unattended, posts auto, survives restarts |
| P1 | 10 | ~16 | Content quality + safety + tests |
| P2 | 9 | ~20 | Deployed, observable, scalable |
| **Total** | **27** | **~46** | Production-grade affiliate bot |

---

## Ordering Tips

- P0-1 (cron) + P0-2 (dedup) + P0-4 (disclaimer) = biggest immediate value (3h, transforms from manual to autonomous).
- P1-9 (Postgres) unlocks P1-10 (fake-discount), P1-13 (warmup), P1-16 (badge). Do it early in P1.
- P2-19 (Playwright) before P2-23 (deploy) — otherwise you can't run unattended on the VPS without re-uploading the JSON.

---

_Last updated: P0/P1/P2 specs initial draft._
