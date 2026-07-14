# Fase 0 (Fundação) + Fase 1 (Telegram Publisher) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the foundation (commit in-flight Prisma/BullMQ migration, security hardening, mandatory affiliate disclaimer, honest CI) and put Telegram on the air through a `PublisherPort` abstraction, per spec `docs/superpowers/specs/2026-07-14-deals-platform-design.md`.

**Architecture:** NestJS monolith (app) + BullMQ worker in the same process tree. New `src/publisher/` module introduces `PublisherPort` with two implementations (`BaileysPublisher`, `TelegramPublisher`) resolved by a registry keyed on `Target.channel`. Pipeline enqueues one job per (deal × target); worker resolves the publisher by channel.

**Tech Stack:** NestJS 11, Prisma 6.19.3 (pinned — do NOT upgrade to 7), BullMQ 5 + ioredis, Baileys 7, axios, Jest.

## Global Constraints

- Prisma stays pinned at `6.19.3` (Prisma 7 deprecates `url` in schema — see project memory).
- All user-facing copy is pt-BR.
- Affiliate disclaimer line, exact text: `_🔗 Link de afiliado. Preço visto às HH:mm — sujeito a alteração._` (HH:mm = America/Sao_Paulo time at render).
- Channel union type is exactly `'wa' | 'telegram'`.
- Tests run with `npm test -- --runInBand`. Build with `npm run build`.
- Never run `docker compose restart` to reload env — use `docker compose up -d --force-recreate` (project memory).
- Commit after every task. Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Verify and commit the in-flight Prisma/BullMQ migration

The working tree carries a large uncommitted migration (repos, `src/queue/`, `src/worker/`, `prisma/migrations/`, Docker changes). Nothing else in this plan can be reviewed sanely until it lands.

**Files:**
- No new code. Commit: all modified + untracked files shown by `git status` EXCEPT `docs/superpowers/plans/` and `docs/superpowers/specs/` (already committed) and any local junk (`ANALISE.md` — commit it too, it documents the audit; `scripts/` — inspect first, commit if project-related).

**Interfaces:**
- Consumes: nothing.
- Produces: a clean `git status` so later tasks produce reviewable diffs.

- [ ] **Step 1: Run the build**

Run: `npm run build`
Expected: exit 0.

- [ ] **Step 2: Run the full test suite**

Run: `npm test -- --runInBand`
Expected: all suites pass (baseline was 19 suites / 143 tests; count may have grown).

- [ ] **Step 3: Inspect untracked dirs before committing**

Run: `git status --short` and `ls scripts/`
Read every untracked file top-level (`scripts/*`, `src/queue/*`, `src/worker/*`, `src/**/**.repo.ts`, `prisma/migrations/`). Confirm nothing is a secret or local scratch. If a file contains credentials, stop and ask the user.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(db): land Prisma/BullMQ migration — repos, queue, worker, migrations

State moves from local JSON files to Postgres (dedup, price history,
targets, opt-out, rate-limit counters, ML tokens) with one-time JSON
backfill on boot. Publishing goes through a BullMQ send-deal queue
consumed by SendDealWorker.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Global ValidationPipe

**Files:**
- Modify: `src/main.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: DTOs with `class-validator` decorators are now enforced app-wide (pipeline `dto/` already exists).

- [ ] **Step 1: Add the pipe**

In `src/main.ts`, add the import and the pipe right after `app.useLogger(...)`:

```ts
import { ValidationPipe } from '@nestjs/common';
```

```ts
  app.useLogger(app.get(Logger));
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true }),
  );
```

- [ ] **Step 2: Require API_KEY in production**

Spec: "API_KEY obrigatória em produção". `ApiKeyGuard` currently lets requests through with a warning when `API_KEY` is unset. Fail at boot instead — in `src/main.ts`, before `NestFactory.create`:

```ts
  if (process.env.NODE_ENV === 'production' && !process.env.API_KEY) {
    throw new Error('API_KEY must be set when NODE_ENV=production');
  }
```

(The guard's dev-mode pass-through stays — it only ever triggers outside production now.)

- [ ] **Step 3: Build and test**

Run: `npm run build && npm test -- --runInBand`
Expected: both pass.

- [ ] **Step 4: Commit**

```bash
git add src/main.ts
git commit -m "feat(security): global ValidationPipe + require API_KEY in production

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Mandatory affiliate disclaimer + price timestamp

Spec requires the disclaimer on EVERY caption. Today `formatter.service.spec.ts:54` asserts the opposite — invert it. Single insertion point: `FormatterService`, not each template.

**Files:**
- Modify: `src/pipeline/formatter.service.ts`
- Modify: `src/pipeline/formatter.service.spec.ts`

**Interfaces:**
- Consumes: existing `FormatterService.formatItem` / `formatScored`.
- Produces: every caption ends with `\n\n_🔗 Link de afiliado. Preço visto às HH:mm — sujeito a alteração._`. Later tasks (worker, publishers) rely on captions already carrying the disclaimer — publishers never add it themselves.

- [ ] **Step 1: Rewrite the disclaimer test to assert presence (failing)**

Replace the `it('omits affiliate disclaimer line', ...)` block in `src/pipeline/formatter.service.spec.ts` with:

```ts
  it('appends affiliate disclaimer with price timestamp', async () => {
    const service = new FormatterService(makeAffiliate(), makeHeadline());
    const deal = makeDeal();

    const { caption } = await service.formatItem(deal);

    expect(caption).toContain('Link de afiliado');
    expect(caption).toMatch(/Preço visto às \d{2}:\d{2}/);
    // disclaimer is the last line, italicized
    const lastLine = caption.trimEnd().split('\n').pop() ?? '';
    expect(lastLine.startsWith('_')).toBe(true);
    expect(lastLine.endsWith('_')).toBe(true);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/pipeline/formatter.service.spec.ts -t disclaimer --runInBand`
Expected: FAIL — caption does not contain 'Link de afiliado'.

- [ ] **Step 3: Implement in FormatterService**

In `src/pipeline/formatter.service.ts`, add a private method and append it in BOTH `formatItem` and `formatScored`:

```ts
  private disclaimerLine(now = new Date()): string {
    const hhmm = now.toLocaleTimeString('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: process.env.TZ ?? 'America/Sao_Paulo',
    });
    return `_🔗 Link de afiliado. Preço visto às ${hhmm} — sujeito a alteração._`;
  }
```

In `formatItem`, change the return to:

```ts
    const captionWithDisclaimer = `${caption}\n\n${this.disclaimerLine()}`;
    return { caption: captionWithDisclaimer, imageUrl };
```

In `formatScored`, change the last two lines to:

```ts
    const caption = `${tmpl(scored, formatBRL, link, hook)}\n\n${this.disclaimerLine()}`;
    const imageUrl = this.toHiResImage(raw.thumbnail || '');
    return { caption, imageUrl };
```

- [ ] **Step 4: Run the formatter suite**

Run: `npx jest src/pipeline/formatter.service.spec.ts --runInBand`
Expected: PASS (all tests — if another test asserts exact caption endings, update it to tolerate the trailing disclaimer).

- [ ] **Step 5: Full suite + commit**

Run: `npm test -- --runInBand`

```bash
git add src/pipeline/formatter.service.ts src/pipeline/formatter.service.spec.ts
git commit -m "feat(compliance): mandatory affiliate disclaimer + price timestamp on every caption

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Honest CI (lint without --fix) + audit fix

**Files:**
- Modify: `package.json` (scripts + possibly `overrides`)
- Modify: `.github/workflows/ci.yml:28` (the `npm run lint` step)

**Interfaces:**
- Consumes: nothing.
- Produces: `npm run lint:ci` — the command CI and all future tasks use to gate lint.

- [ ] **Step 1: Add lint:ci script**

In `package.json` scripts, keep `lint` (dev convenience) and add:

```json
    "lint:ci": "eslint \"{src,apps,libs,test}/**/*.ts\"",
```

- [ ] **Step 2: Point CI at it**

In `.github/workflows/ci.yml`, change the lint step:

```yaml
      - name: Run ESLint
        run: npm run lint:ci
```

- [ ] **Step 3: Autofix the existing backlog**

Run: `npm run format && npm run lint`
Expected: prettier rewrites files; eslint --fix clears most of the 349 reported problems.

- [ ] **Step 4: Verify lint:ci is green, fix stragglers**

Run: `npm run lint:ci`
Expected: exit 0. If errors remain they are genuine TS/ESLint issues — fix each one manually (typical leftovers: unused vars → remove; `any` warnings are warnings, they don't fail). Re-run until exit 0.

- [ ] **Step 5: Audit fix (protobufjs critical via @whiskeysockets/libsignal-node)**

Run: `npm audit --omit=dev` to see the current state, then `npm audit fix`.
If the protobufjs critical remains (transitive pin), add to `package.json`:

```json
  "overrides": {
    "protobufjs": "^7.2.5"
  }
```

then `npm install`. Verify: `npm audit --omit=dev` shows no critical. Then `npm test -- --runInBand` — Baileys signal tests must still pass; if the override breaks libsignal at runtime/test, revert the override and instead record the accepted risk in README (do not ship a broken override).

- [ ] **Step 6: Build + test + commit**

Run: `npm run build && npm test -- --runInBand`

```bash
git add -A
git commit -m "chore(ci): lint without --fix in CI; clear lint backlog; audit fix protobufjs

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: `channel` on targets (Prisma + service)

**Files:**
- Modify: `prisma/schema.prisma` (model `WaTarget`)
- Create: migration via `npm run prisma:migrate:dev -- --name add-target-channel`
- Modify: `src/whatsapp/targets.service.ts`
- Modify: `src/whatsapp/targets.repo.ts`
- Test: `src/whatsapp/targets.service.spec.ts` (exists — extend; if it does not exist, create with the cases below)

**Interfaces:**
- Consumes: `PrismaService` (existing).
- Produces (later tasks depend on these exact shapes):

```ts
export type Channel = 'wa' | 'telegram';

export interface WaTarget {
  jid: string;      // WA JID or Telegram chat_id (e.g. "@meucanal" or "-1001234567890")
  name: string;
  active: boolean;
  channel: Channel;
}

// TargetsService
getActiveTargets(): Promise<WaTarget[]>;             // replaces getActiveJids in pipeline
add(jid: string, name: string, channel?: Channel): Promise<WaTarget>;
```

- [ ] **Step 1: Schema change**

In `prisma/schema.prisma`:

```prisma
model WaTarget {
  jid     String  @id
  name    String?
  active  Boolean @default(true)
  channel String  @default("wa")
}
```

- [ ] **Step 2: Generate + migrate**

Run: `npm run prisma:generate && npm run prisma:migrate:dev -- --name add-target-channel`
Expected: migration created under `prisma/migrations/`, applies clean. (Postgres from docker compose must be up: `docker compose up -d postgres`.)

- [ ] **Step 3: Write failing service test**

In `src/whatsapp/targets.service.spec.ts` add (adapting to the existing fake-repo pattern in that file; if creating fresh, build an in-memory `TargetsRepo` fake):

```ts
  it('defaults channel to wa and filters active targets with channel', async () => {
    const svc = makeService(); // existing helper with in-memory repo
    await svc.add('123@g.us', 'grupo');
    await svc.add('-100555', 'canal tg', 'telegram');

    const targets = await svc.getActiveTargets();

    expect(targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ jid: '123@g.us', channel: 'wa' }),
        expect.objectContaining({ jid: '-100555', channel: 'telegram' }),
      ]),
    );
  });

  it('seeds telegram target from TELEGRAM_CHAT_ID env', async () => {
    const svc = makeService({ TELEGRAM_CHAT_ID: '-100999' });
    await svc.onModuleInit();
    const targets = await svc.getActiveTargets();
    expect(targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ jid: '-100999', channel: 'telegram' }),
      ]),
    );
  });
```

- [ ] **Step 4: Run to verify failure**

Run: `npx jest src/whatsapp/targets.service.spec.ts --runInBand`
Expected: FAIL — `channel` missing / `getActiveTargets` undefined.

- [ ] **Step 5: Implement**

`src/whatsapp/targets.service.ts` — extend the interface and service:

```ts
export type Channel = 'wa' | 'telegram';

export interface WaTarget {
  jid: string;
  name: string;
  active: boolean;
  channel: Channel;
}
```

```ts
  async getActiveTargets(): Promise<WaTarget[]> {
    const all = await this.repo.findAll();
    return all.filter((t) => t.active);
  }

  async add(jid: string, name: string, channel: Channel = 'wa'): Promise<WaTarget> {
    if (!jid) throw new Error('jid required');
    return this.repo.upsert({ jid, name: name || jid, active: true, channel });
  }
```

Keep `getActiveJids()` delegating to `getActiveTargets()` for backward compat:

```ts
  async getActiveJids(): Promise<string[]> {
    return (await this.getActiveTargets()).map((t) => t.jid);
  }
```

Extend `seedFromEnv` (same method, after the WA seed):

```ts
    const tg = this.config.get<string>('TELEGRAM_CHAT_ID', '');
    if (tg && !(await this.repo.findOne(tg))) {
      await this.repo.upsert({
        jid: tg,
        name: 'env:TELEGRAM_CHAT_ID',
        active: true,
        channel: 'telegram',
      });
      this.logger.log(`Seeded telegram target from env: ${tg}`);
    }
```

`src/whatsapp/targets.repo.ts` — map `channel` in every method, defaulting `'wa'`:

```ts
  private toDomain(r: any): WaTarget {
    return {
      jid: r.jid,
      name: r.name ?? r.jid,
      active: r.active,
      channel: (r.channel ?? 'wa') as Channel,
    };
  }
```

Use `this.toDomain(r)` in `findAll`, `findOne`, `upsert` returns; include `channel: t.channel` in `create`/`update`/`createMany` payloads. Import `Channel` from `./targets.service`. In `maybeBackfillFromJson` (targets.service), legacy entries get `channel: 'wa'`.

- [ ] **Step 6: Run tests**

Run: `npx jest src/whatsapp/targets.service.spec.ts --runInBand` → PASS, then `npm test -- --runInBand` → PASS (fix any WaTarget literal in other specs by adding `channel: 'wa'`).

- [ ] **Step 7: Commit**

```bash
git add prisma/ src/whatsapp/targets.service.ts src/whatsapp/targets.repo.ts src/whatsapp/targets.service.spec.ts
git commit -m "feat(targets): channel column (wa|telegram) + TELEGRAM_CHAT_ID seeding

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Publisher module — port, registry, BaileysPublisher

**Files:**
- Create: `src/publisher/publisher.port.ts`
- Create: `src/publisher/publisher-registry.service.ts`
- Create: `src/publisher/baileys.publisher.ts`
- Create: `src/publisher/publisher.module.ts`
- Test: `src/publisher/publisher-registry.service.spec.ts`
- Test: `src/publisher/baileys.publisher.spec.ts`

**Interfaces:**
- Consumes: `WhatsappService` (`isReady(): boolean`, `sendText(jid, text)`, `sendImage(jid, url, caption)`), `Channel` from `../whatsapp/targets.service`.
- Produces:

```ts
export const PUBLISHERS = Symbol('PUBLISHERS');

export interface RenderedPost {
  caption: string;
  imageUrl?: string;
}

export interface PublisherPort {
  readonly channel: Channel;
  /** Throws on failure — BullMQ retry semantics ride on exceptions. */
  publish(post: RenderedPost, targetId: string): Promise<void>;
}

// PublisherRegistry
get(channel: Channel): PublisherPort; // throws `no publisher for channel=...`
```

- [ ] **Step 1: Write failing tests**

`src/publisher/publisher-registry.service.spec.ts`:

```ts
import { PublisherRegistry } from './publisher-registry.service';
import type { PublisherPort } from './publisher.port';

const fake = (channel: 'wa' | 'telegram'): PublisherPort => ({
  channel,
  publish: jest.fn().mockResolvedValue(undefined),
});

describe('PublisherRegistry', () => {
  it('resolves publisher by channel', () => {
    const wa = fake('wa');
    const tg = fake('telegram');
    const reg = new PublisherRegistry([wa, tg]);
    expect(reg.get('wa')).toBe(wa);
    expect(reg.get('telegram')).toBe(tg);
  });

  it('throws for unregistered channel', () => {
    const reg = new PublisherRegistry([fake('wa')]);
    expect(() => reg.get('telegram')).toThrow('no publisher for channel=telegram');
  });
});
```

`src/publisher/baileys.publisher.spec.ts`:

```ts
import { BaileysPublisher } from './baileys.publisher';

function makeWa(ready = true) {
  return {
    isReady: jest.fn().mockReturnValue(ready),
    sendText: jest.fn().mockResolvedValue(undefined),
    sendImage: jest.fn().mockResolvedValue(undefined),
  } as any;
}

describe('BaileysPublisher', () => {
  it('sends image with caption when imageUrl present', async () => {
    const wa = makeWa();
    const pub = new BaileysPublisher(wa);
    await pub.publish({ caption: 'oi', imageUrl: 'https://img' }, '123@g.us');
    expect(wa.sendImage).toHaveBeenCalledWith('123@g.us', 'https://img', 'oi');
    expect(wa.sendText).not.toHaveBeenCalled();
  });

  it('sends text when no image', async () => {
    const wa = makeWa();
    const pub = new BaileysPublisher(wa);
    await pub.publish({ caption: 'oi' }, '123@g.us');
    expect(wa.sendText).toHaveBeenCalledWith('123@g.us', 'oi');
  });

  it('throws whatsapp_not_ready when session down', async () => {
    const pub = new BaileysPublisher(makeWa(false));
    await expect(pub.publish({ caption: 'oi' }, 'x')).rejects.toThrow('whatsapp_not_ready');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest src/publisher --runInBand`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`src/publisher/publisher.port.ts`:

```ts
import type { Channel } from '../whatsapp/targets.service';

export const PUBLISHERS = Symbol('PUBLISHERS');

export interface RenderedPost {
  caption: string;
  imageUrl?: string;
}

export interface PublisherPort {
  readonly channel: Channel;
  /** Throws on failure — BullMQ retry semantics ride on exceptions. */
  publish(post: RenderedPost, targetId: string): Promise<void>;
}
```

`src/publisher/publisher-registry.service.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import type { Channel } from '../whatsapp/targets.service';
import { PUBLISHERS } from './publisher.port';
import type { PublisherPort } from './publisher.port';

@Injectable()
export class PublisherRegistry {
  private readonly byChannel = new Map<Channel, PublisherPort>();

  constructor(@Inject(PUBLISHERS) publishers: PublisherPort[]) {
    for (const p of publishers) this.byChannel.set(p.channel, p);
  }

  get(channel: Channel): PublisherPort {
    const p = this.byChannel.get(channel);
    if (!p) throw new Error(`no publisher for channel=${channel}`);
    return p;
  }
}
```

`src/publisher/baileys.publisher.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { WhatsappService } from '../whatsapp/wa.service';
import type { PublisherPort, RenderedPost } from './publisher.port';

@Injectable()
export class BaileysPublisher implements PublisherPort {
  readonly channel = 'wa' as const;

  constructor(private readonly wa: WhatsappService) {}

  async publish(post: RenderedPost, targetId: string): Promise<void> {
    if (!this.wa.isReady()) {
      throw new Error('whatsapp_not_ready');
    }
    if (post.imageUrl) {
      await this.wa.sendImage(targetId, post.imageUrl, post.caption);
    } else {
      await this.wa.sendText(targetId, post.caption);
    }
  }
}
```

`src/publisher/publisher.module.ts` (TelegramPublisher joins in Task 7):

```ts
import { Module } from '@nestjs/common';
import { WhatsappModule } from '../whatsapp/wa.module';
import { BaileysPublisher } from './baileys.publisher';
import { PUBLISHERS } from './publisher.port';
import { PublisherRegistry } from './publisher-registry.service';

@Module({
  imports: [WhatsappModule],
  providers: [
    BaileysPublisher,
    {
      provide: PUBLISHERS,
      inject: [BaileysPublisher],
      useFactory: (...pubs: unknown[]) => pubs,
    },
    PublisherRegistry,
  ],
  exports: [PublisherRegistry],
})
export class PublisherModule {}
```

- [ ] **Step 4: Run tests**

Run: `npx jest src/publisher --runInBand` → PASS. `npm run build` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/publisher
git commit -m "feat(publisher): PublisherPort + registry + BaileysPublisher

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: TelegramPublisher

**Files:**
- Create: `src/publisher/telegram.publisher.ts`
- Modify: `src/publisher/publisher.module.ts`
- Test: `src/publisher/telegram.publisher.spec.ts`

**Interfaces:**
- Consumes: `ConfigService` (`TELEGRAM_BOT_TOKEN`), axios, `PublisherPort`/`RenderedPost` from Task 6.
- Produces: `TelegramPublisher implements PublisherPort` with `channel = 'telegram'`. Error contract: HTTP 429 → throws `Error('throttled:telegram')` (worker's `classifyReason` already labels `throttled:*`); HTTP 400 → one retry without `parse_mode` (bad Markdown entities must not drop a deal).

- [ ] **Step 1: Write failing tests**

`src/publisher/telegram.publisher.spec.ts`:

```ts
import axios from 'axios';
import { TelegramPublisher } from './telegram.publisher';

jest.mock('axios');
const mockedPost = axios.post as jest.Mock;
(axios.isAxiosError as unknown as jest.Mock) = jest.fn(
  (e: any) => !!e?.isAxiosError,
);

function makeConfig(token = 'TOKEN123') {
  return { get: jest.fn().mockReturnValue(token) } as any;
}

function axiosError(status: number) {
  return { isAxiosError: true, response: { status } };
}

describe('TelegramPublisher', () => {
  beforeEach(() => mockedPost.mockReset());

  it('sends photo with Markdown caption when imageUrl present', async () => {
    mockedPost.mockResolvedValue({ data: { ok: true } });
    const pub = new TelegramPublisher(makeConfig());
    await pub.publish({ caption: '*oi*', imageUrl: 'https://img' }, '-100555');
    expect(mockedPost).toHaveBeenCalledWith(
      'https://api.telegram.org/botTOKEN123/sendPhoto',
      expect.objectContaining({
        chat_id: '-100555',
        photo: 'https://img',
        caption: '*oi*',
        parse_mode: 'Markdown',
      }),
    );
  });

  it('sends text message when no image', async () => {
    mockedPost.mockResolvedValue({ data: { ok: true } });
    const pub = new TelegramPublisher(makeConfig());
    await pub.publish({ caption: 'oi' }, '-100555');
    expect(mockedPost).toHaveBeenCalledWith(
      'https://api.telegram.org/botTOKEN123/sendMessage',
      expect.objectContaining({ chat_id: '-100555', text: 'oi', parse_mode: 'Markdown' }),
    );
  });

  it('retries without parse_mode on 400 (bad markdown entities)', async () => {
    mockedPost
      .mockRejectedValueOnce(axiosError(400))
      .mockResolvedValueOnce({ data: { ok: true } });
    const pub = new TelegramPublisher(makeConfig());
    await pub.publish({ caption: 'a_b*c' }, '-100555');
    expect(mockedPost).toHaveBeenCalledTimes(2);
    const secondBody = mockedPost.mock.calls[1][1];
    expect(secondBody.parse_mode).toBeUndefined();
  });

  it('maps 429 to throttled:telegram', async () => {
    mockedPost.mockRejectedValue(axiosError(429));
    const pub = new TelegramPublisher(makeConfig());
    await expect(pub.publish({ caption: 'oi' }, '-100555')).rejects.toThrow(
      'throttled:telegram',
    );
  });

  it('fails fast when token missing', async () => {
    const pub = new TelegramPublisher(makeConfig(''));
    await expect(pub.publish({ caption: 'oi' }, '-100555')).rejects.toThrow(
      'telegram_token_missing',
    );
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest src/publisher/telegram.publisher.spec.ts --runInBand`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/publisher/telegram.publisher.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import type { PublisherPort, RenderedPost } from './publisher.port';

/**
 * Publishes via the official Telegram Bot API. Stateless HTTP — no session,
 * no ban risk. `parse_mode: 'Markdown'` (legacy) matches WhatsApp caption
 * syntax (*bold*, _italic_), so captions render the same on both channels.
 * If Telegram rejects the entities (400) we resend as plain text instead of
 * dropping the deal. 429 surfaces as `throttled:telegram` so the BullMQ
 * worker's retry/backoff and failure metrics treat it as a rate limit.
 */
@Injectable()
export class TelegramPublisher implements PublisherPort {
  readonly channel = 'telegram' as const;
  private readonly logger = new Logger(TelegramPublisher.name);

  constructor(private readonly config: ConfigService) {}

  async publish(post: RenderedPost, targetId: string): Promise<void> {
    try {
      await this.send(post, targetId, 'Markdown');
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 429) {
        throw new Error('throttled:telegram');
      }
      if (axios.isAxiosError(err) && err.response?.status === 400) {
        this.logger.warn(
          `telegram 400 (likely markdown entities) — resending plain, chat=${targetId}`,
        );
        await this.send(post, targetId, undefined);
        return;
      }
      throw err;
    }
  }

  private async send(
    post: RenderedPost,
    chatId: string,
    parseMode?: 'Markdown',
  ): Promise<void> {
    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN', '');
    if (!token) throw new Error('telegram_token_missing');
    const base = `https://api.telegram.org/bot${token}`;
    const modeField = parseMode ? { parse_mode: parseMode } : {};
    if (post.imageUrl) {
      await axios.post(`${base}/sendPhoto`, {
        chat_id: chatId,
        photo: post.imageUrl,
        caption: post.caption,
        ...modeField,
      });
    } else {
      await axios.post(`${base}/sendMessage`, {
        chat_id: chatId,
        text: post.caption,
        ...modeField,
      });
    }
  }
}
```

Register in `src/publisher/publisher.module.ts`:

```ts
import { TelegramPublisher } from './telegram.publisher';
```

```ts
  providers: [
    BaileysPublisher,
    TelegramPublisher,
    {
      provide: PUBLISHERS,
      inject: [BaileysPublisher, TelegramPublisher],
      useFactory: (...pubs: unknown[]) => pubs,
    },
    PublisherRegistry,
  ],
```

- [ ] **Step 4: Run tests**

Run: `npx jest src/publisher --runInBand` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/publisher
git commit -m "feat(publisher): TelegramPublisher via Bot API with 400-fallback and 429 throttle mapping

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Worker routes by channel + SentMessage audit row

**Files:**
- Modify: `src/queue/queue.types.ts`
- Modify: `src/worker/send-deal.worker.ts`
- Modify: `src/worker/worker.module.ts`
- Test: `src/worker/send-deal.worker.spec.ts` (create if missing)

**Interfaces:**
- Consumes: `PublisherRegistry.get(channel)` (Task 6/7), `FormatterService.formatScored`, `DedupService.markPosted`, `PrismaService`.
- Produces: job payload contract used by Task 9:

```ts
export interface SendDealJob {
  targetJid: string;
  /** Publisher channel. Optional so jobs already sitting in Redis (pre-upgrade) still process as WhatsApp. */
  channel?: 'wa' | 'telegram';
  catalogKey: string;
  scored: ScoredDeal;
}
```

- [ ] **Step 1: Extend SendDealJob**

Apply the interface above in `src/queue/queue.types.ts` (add the `channel?` field with the comment).

- [ ] **Step 2: Write failing worker tests**

`src/worker/send-deal.worker.spec.ts` — test `process()` directly (it's private; cast to `any`, pattern used elsewhere in the repo):

```ts
import { SendDealWorker } from './send-deal.worker';

function makeDeps() {
  const publisher = { channel: 'telegram', publish: jest.fn().mockResolvedValue(undefined) };
  const registry = { get: jest.fn().mockReturnValue(publisher) };
  const formatter = {
    formatScored: jest.fn().mockResolvedValue({ caption: 'cap', imageUrl: 'https://img' }),
  };
  const dedup = { markPosted: jest.fn().mockResolvedValue(undefined) };
  const prisma = { sentMessage: { create: jest.fn().mockResolvedValue({}) } };
  const counters = {
    wppMessagesSent: { labels: jest.fn().mockReturnValue({ inc: jest.fn() }) },
    wppMessagesFailed: { labels: jest.fn().mockReturnValue({ inc: jest.fn() }) },
  };
  return { publisher, registry, formatter, dedup, prisma, counters };
}

function makeJob(channel?: 'wa' | 'telegram') {
  return {
    id: 'k:t',
    data: {
      targetJid: '-100555',
      channel,
      catalogKey: 'ml:MLB1',
      scored: { deal: { key: { source: 'ml', externalId: 'MLB1' }, raw: {} }, score: 80, level: 'top' },
    },
  } as any;
}

describe('SendDealWorker.process', () => {
  it('routes to publisher by job channel and records SentMessage', async () => {
    const d = makeDeps();
    const worker = new SendDealWorker(
      {} as any, d.registry as any, d.formatter as any,
      d.dedup as any, d.prisma as any, d.counters as any,
    );
    await (worker as any).process(makeJob('telegram'));
    expect(d.registry.get).toHaveBeenCalledWith('telegram');
    expect(d.publisher.publish).toHaveBeenCalledWith(
      { caption: 'cap', imageUrl: 'https://img' }, '-100555',
    );
    expect(d.dedup.markPosted).toHaveBeenCalledWith('ml:MLB1');
    expect(d.prisma.sentMessage.create).toHaveBeenCalledWith({
      data: { catalogId: 'ml:MLB1', targetJid: '-100555', caption: 'cap' },
    });
  });

  it('defaults channel to wa for legacy jobs', async () => {
    const d = makeDeps();
    const worker = new SendDealWorker(
      {} as any, d.registry as any, d.formatter as any,
      d.dedup as any, d.prisma as any, d.counters as any,
    );
    await (worker as any).process(makeJob(undefined));
    expect(d.registry.get).toHaveBeenCalledWith('wa');
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx jest src/worker --runInBand`
Expected: FAIL — constructor shape / registry not used yet.

- [ ] **Step 4: Implement worker changes**

In `src/worker/send-deal.worker.ts`:

Replace the `WhatsappService` dependency with `PublisherRegistry` + `PrismaService`. New constructor:

```ts
import { PrismaService } from '../db/prisma.service';
import { PublisherRegistry } from '../publisher/publisher-registry.service';
```

```ts
  constructor(
    @Inject('REDIS_CONNECTION_OPTIONS')
    private readonly connection: ConnectionOptions,
    private readonly publishers: PublisherRegistry,
    private readonly formatter: FormatterService,
    private readonly dedup: DedupService,
    private readonly prisma: PrismaService,
    private readonly counters: CountersService,
  ) {}
```

Replace `process()`:

```ts
  private async process(job: Job<SendDealJob>): Promise<void> {
    const { targetJid, scored } = job.data;
    const channel = job.data.channel ?? 'wa';
    const keyStr = keyToString(scored.deal.key);

    const publisher = this.publishers.get(channel);
    const { caption, imageUrl } = await this.formatter.formatScored(scored);
    await publisher.publish({ caption, imageUrl }, targetJid);

    await this.dedup.markPosted(keyStr);
    try {
      await (this.prisma as any).sentMessage.create({
        data: { catalogId: keyStr, targetJid, caption },
      });
    } catch (err) {
      // Audit row must never fail a job that already published.
      this.logger.warn(`sentMessage audit insert failed: ${(err as Error).message}`);
    }
    this.logger.log(
      `send-deal job ${job.id} ok (${keyStr} -> ${targetJid} via ${channel}, level=${scored.level}, score=${scored.score})`,
    );
  }
```

Remove the `WhatsappService` import and the `isReady()` pre-check (BaileysPublisher owns it now). In the `completed` handler, label by channel instead of source:

```ts
    this.worker.on('completed', (job) => {
      const channel = job.data.channel ?? 'wa';
      this.counters.wppMessagesSent.labels(channel).inc();
    });
```

In `src/worker/worker.module.ts`, swap `WhatsappModule` for `PublisherModule`:

```ts
import { Module } from '@nestjs/common';
import { DedupModule } from '../dedup/dedup.module';
import { MetricsModule } from '../metrics/metrics.module';
import { PipelineModule } from '../pipeline/pipeline.module';
import { PublisherModule } from '../publisher/publisher.module';
import { SendDealWorker } from './send-deal.worker';

@Module({
  imports: [PublisherModule, PipelineModule, DedupModule, MetricsModule],
  providers: [SendDealWorker],
})
export class WorkerModule {}
```

- [ ] **Step 5: Run tests**

Run: `npx jest src/worker --runInBand` → PASS, then `npm run build` → clean.

- [ ] **Step 6: Commit**

```bash
git add src/queue/queue.types.ts src/worker src/publisher
git commit -m "feat(worker): route jobs by channel via PublisherRegistry + SentMessage audit

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Pipeline enqueues per-target channel

**Files:**
- Modify: `src/pipeline/pipeline.service.ts` (method `enqueueScored`, lines ~132-184)
- Test: `src/pipeline/pipeline.service.spec.ts` (extend existing enqueue tests)

**Interfaces:**
- Consumes: `TargetsService.getActiveTargets(): Promise<WaTarget[]>` (Task 5), `SendDealJob.channel` (Task 8).
- Produces: every enqueued job carries `channel`; jobId stays `` `${catalogKey}:${targetJid}` ``.

- [ ] **Step 1: Write/extend failing test**

In `src/pipeline/pipeline.service.spec.ts`, in the existing `enqueueScored` describe block (reuse that file's existing service factory and fake queue; adjust names to match):

```ts
  it('enqueues one job per target with the target channel', async () => {
    targets.getActiveTargets = jest.fn().mockResolvedValue([
      { jid: '123@g.us', name: 'g', active: true, channel: 'wa' },
      { jid: '-100555', name: 'tg', active: true, channel: 'telegram' },
    ]);

    await service.enqueueScored([scoredFixture], 3);

    expect(queue.add).toHaveBeenCalledWith(
      'send-deal',
      expect.objectContaining({ targetJid: '123@g.us', channel: 'wa' }),
      { jobId: expect.stringContaining('123@g.us') },
    );
    expect(queue.add).toHaveBeenCalledWith(
      'send-deal',
      expect.objectContaining({ targetJid: '-100555', channel: 'telegram' }),
      { jobId: expect.stringContaining('-100555') },
    );
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest src/pipeline/pipeline.service.spec.ts --runInBand`
Expected: FAIL — jobs missing `channel` / `getActiveTargets` not called.

- [ ] **Step 3: Implement**

In `enqueueScored`, replace the jid-resolution block with targets:

```ts
    let activeTargets = await this.targets.getActiveTargets();
    if (activeTargets.length === 0) {
      const fallback = this.config.get<string>('WA_TARGET_JID', '');
      if (fallback) {
        activeTargets = [
          { jid: fallback, name: 'env:WA_TARGET_JID', active: true, channel: 'wa' },
        ];
      }
    }
    if (activeTargets.length === 0) {
      throw new Error(
        'No active targets and WA_TARGET_JID unset — nothing to publish',
      );
    }
```

and the enqueue loop body with:

```ts
      for (const target of activeTargets) {
        const jobId = `${catalogKey}:${target.jid}`;
        try {
          await this.sendQueue.add(
            'send-deal',
            { targetJid: target.jid, channel: target.channel, catalogKey, scored: sd },
            { jobId },
          );
          enqueued++;
        } catch (err) {
          this.logger.error(`enqueue ${jobId} failed: ${(err as Error).message}`);
        }
      }
```

Update the summary log/return to use `activeTargets.length` where it used `jids.length`. Import `WaTarget` type if needed: `import type { WaTarget } from '../whatsapp/targets.service';`.

- [ ] **Step 4: Run tests**

Run: `npx jest src/pipeline/pipeline.service.spec.ts --runInBand` → PASS, then `npm test -- --runInBand` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pipeline
git commit -m "feat(pipeline): enqueue per-target channel for multi-channel publish

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: Env docs, warmup config, final verification

**Files:**
- Modify: `.env.example`
- Modify: `README.md` (env table / setup section, wherever envs are documented)

**Interfaces:**
- Consumes: everything above.
- Produces: documented envs — `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, warmup combo.

- [ ] **Step 1: Document envs**

Append to `.env.example`:

```bash
# --- Telegram publisher (Fase 1) ---
# BotFather token. Leave empty to disable Telegram publishing.
TELEGRAM_BOT_TOKEN=
# Channel/group chat_id (e.g. -1001234567890 or @meucanal). Seeded as an
# active telegram target on boot.
TELEGRAM_CHAT_ID=

# --- Price-history warmup (Fase 0) ---
# Run the full collect+score pipeline on schedule but DON'T enqueue sends.
# Use for the first 1-2 weeks so PriceHistory medians stabilize before
# automatic posting starts (spec: anti-fake barrier 2 needs >=7 days).
# SCHEDULER_ENABLED=true
# SCHEDULER_DISPATCH_ENABLED=false
```

Mirror the same two Telegram vars in README's env documentation with one-line descriptions.

- [ ] **Step 2: Full verification**

Run: `npm run build && npm run lint:ci && npm test -- --runInBand`
Expected: all green.

- [ ] **Step 3: Smoke test Telegram end-to-end (manual, needs real token)**

With `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` set in `.env` and Postgres/Redis up (`docker compose up -d postgres redis`):

Run: `npm run start:dev`, then hit the pipeline preview/run endpoint (existing `pipeline.controller.ts` route) or wait a scheduler tick with `SCHEDULER_DISPATCH_ENABLED=true`.
Expected: post appears in the Telegram channel with caption + image + disclaimer line.
If no affiliate/ML data is live, alternately verify with a direct queue add from a Node REPL is NOT required — skip and note it; the unit/integration tests above cover routing.

- [ ] **Step 4: Commit**

```bash
git add .env.example README.md
git commit -m "docs(env): Telegram publisher vars + price-history warmup combo

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Out of scope for this plan (next plans)

- Barrier 2 hard rules (`no-history → cap discount`, `price-spike detector`) and `CurationDecision` audit table — next plan (Fase 2 prep). `CurationService.isFakeDiscount` already covers part; extension comes with the LLM judge.
- LLM judge + copy A/B (DeepSeek V4 Flash/Pro via OpenRouter) — Fase 2 plan.
- Sub-ID per channel on affiliate links — depends on ML linkbuilder "etiqueta" support; investigate during Fase 2.
- Redirector `/r/:code` + `ClickEvent` — Fase 3.
- Prometheus counters beyond what exists — instrumented incrementally with each feature above.
