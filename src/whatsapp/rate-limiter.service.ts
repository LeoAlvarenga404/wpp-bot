import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs/promises';
import * as path from 'path';
import { RATE_LIMITER_REPO } from './rate-limiter.repo';
import type { RateLimiterRepo, WaCounterRow } from './rate-limiter.repo';

/**
 * P1-13. WhatsApp warmup rate limiter.
 *
 * Caps per chip age (days since WA_CHIP_FIRST_USE_DATE):
 *   0-7d  : 5/h,  30/d
 *   8-14d : 10/h, 80/d
 *   15-30d: 20/h, 150/d
 *   31+d  : 50/h, 400/d
 *
 * Counters bucketed by hour (YYYY-MM-DDTHH) and day (YYYY-MM-DD). The in-memory
 * state is hydrated from the `WaCounter` table on boot and write-through on
 * every recordSend, so the sync `canSend()` path stays a single map lookup
 * with no DB round trip. Legacy ./data/wa-counters.json is imported once if
 * the DB table is empty.
 */

type CounterState = {
  hour: Record<string, number>;
  day: Record<string, number>;
};

const DEFAULT_JSON_FILE = './data/wa-counters.json';
const BUCKET_HOUR = 'wa-hour';
const BUCKET_DAY = 'wa-day';
const HOUR_PREFIX = 'wa:hour:';
const DAY_PREFIX = 'wa:day:';

export type SendCheck =
  | { allowed: true }
  | { allowed: false; reason: 'hour_cap' | 'day_cap' };

export interface RateCaps {
  perHour: number;
  perDay: number;
}

@Injectable()
export class RateLimiterService implements OnModuleInit {
  private readonly logger = new Logger(RateLimiterService.name);
  private readonly jsonBackfillPath: string = path.resolve(DEFAULT_JSON_FILE);
  private state: CounterState = { hour: {}, day: {} };

  constructor(
    private readonly config: ConfigService,
    @Inject(RATE_LIMITER_REPO) private readonly repo: RateLimiterRepo,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.maybeBackfillFromJson();
    await this.hydrate();
    await this.gc();
    this.logger.log(
      `Rate limiter loaded. chipAgeDays=${this.chipAgeDays()} caps=${JSON.stringify(this.getCaps())}`,
    );
  }

  private chipAgeDays(): number {
    const raw = this.config.get<string>('WA_CHIP_FIRST_USE_DATE', '');
    if (!raw) return 9999;
    const start = Date.parse(raw);
    if (Number.isNaN(start)) return 9999;
    const diff = Date.now() - start;
    if (diff < 0) return 0;
    return Math.floor(diff / (24 * 60 * 60 * 1000));
  }

  getCaps(): RateCaps {
    const age = this.chipAgeDays();
    if (age <= 7) return { perHour: 5, perDay: 30 };
    if (age <= 14) return { perHour: 10, perDay: 80 };
    if (age <= 30) return { perHour: 20, perDay: 150 };
    return { perHour: 50, perDay: 400 };
  }

  private hourKey(d = new Date()): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(
      d.getUTCDate(),
    )}T${pad(d.getUTCHours())}`;
  }

  private dayKey(d = new Date()): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(
      d.getUTCDate(),
    )}`;
  }

  canSend(): SendCheck {
    const caps = this.getCaps();
    const hk = this.hourKey();
    const dk = this.dayKey();
    const hCount = this.state.hour[hk] ?? 0;
    const dCount = this.state.day[dk] ?? 0;
    if (hCount >= caps.perHour) return { allowed: false, reason: 'hour_cap' };
    if (dCount >= caps.perDay) return { allowed: false, reason: 'day_cap' };
    return { allowed: true };
  }

  async recordSend(): Promise<void> {
    const hk = this.hourKey();
    const dk = this.dayKey();
    this.state.hour[hk] = (this.state.hour[hk] ?? 0) + 1;
    this.state.day[dk] = (this.state.day[dk] ?? 0) + 1;
    try {
      await this.repo.upsert(
        `${HOUR_PREFIX}${hk}`,
        BUCKET_HOUR,
        this.state.hour[hk],
      );
      await this.repo.upsert(
        `${DAY_PREFIX}${dk}`,
        BUCKET_DAY,
        this.state.day[dk],
      );
    } catch (err) {
      this.logger.error('recordSend upsert failed', err as Error);
    }
  }

  getStatus(): {
    caps: RateCaps;
    usedThisHour: number;
    usedToday: number;
    chipAgeDays: number;
  } {
    const caps = this.getCaps();
    return {
      caps,
      usedThisHour: this.state.hour[this.hourKey()] ?? 0,
      usedToday: this.state.day[this.dayKey()] ?? 0,
      chipAgeDays: this.chipAgeDays(),
    };
  }

  private async hydrate(): Promise<void> {
    try {
      const rows = await this.repo.loadAll();
      for (const r of rows) {
        if (r.id.startsWith(HOUR_PREFIX)) {
          this.state.hour[r.id.slice(HOUR_PREFIX.length)] = r.count;
        } else if (r.id.startsWith(DAY_PREFIX)) {
          this.state.day[r.id.slice(DAY_PREFIX.length)] = r.count;
        }
      }
    } catch (err) {
      this.logger.error('rate-limiter hydrate failed', err as Error);
    }
  }

  /** Drop buckets older than 2 days (hours) / 14 days (days). */
  private async gc(): Promise<void> {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const stale: string[] = [];
    for (const k of Object.keys(this.state.hour)) {
      const t = Date.parse(k + ':00:00Z');
      if (Number.isNaN(t) || now - t > 2 * dayMs) {
        delete this.state.hour[k];
        stale.push(`${HOUR_PREFIX}${k}`);
      }
    }
    for (const k of Object.keys(this.state.day)) {
      const t = Date.parse(k + 'T00:00:00Z');
      if (Number.isNaN(t) || now - t > 14 * dayMs) {
        delete this.state.day[k];
        stale.push(`${DAY_PREFIX}${k}`);
      }
    }
    if (stale.length > 0) {
      try {
        await this.repo.deleteMany(stale);
      } catch (err) {
        this.logger.warn(
          `rate-limiter GC delete failed: ${(err as Error).message}`,
        );
      }
    }
  }

  private async maybeBackfillFromJson(): Promise<void> {
    let existing: number;
    try {
      existing = await this.repo.count();
    } catch (err) {
      this.logger.error('rate-limiter count() failed', err as Error);
      return;
    }
    if (existing > 0) return;

    let raw: string;
    try {
      raw = await fs.readFile(this.jsonBackfillPath, 'utf8');
    } catch (err: any) {
      if (err && err.code === 'ENOENT') return;
      this.logger.warn(
        `Failed to read ${this.jsonBackfillPath}: ${(err as Error).message}`,
      );
      return;
    }

    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.logger.warn(
        `Legacy ${this.jsonBackfillPath} is not valid JSON — skipping backfill`,
      );
      return;
    }

    const rows: WaCounterRow[] = [];
    if (parsed?.hour && typeof parsed.hour === 'object') {
      for (const [k, v] of Object.entries(parsed.hour)) {
        if (typeof v !== 'number') continue;
        rows.push({ id: `${HOUR_PREFIX}${k}`, bucket: BUCKET_HOUR, count: v });
      }
    }
    if (parsed?.day && typeof parsed.day === 'object') {
      for (const [k, v] of Object.entries(parsed.day)) {
        if (typeof v !== 'number') continue;
        rows.push({ id: `${DAY_PREFIX}${k}`, bucket: BUCKET_DAY, count: v });
      }
    }
    if (rows.length === 0) return;

    try {
      await this.repo.importMany(rows);
      this.logger.log(
        `Backfilled ${rows.length} rate-limiter buckets from ${this.jsonBackfillPath}`,
      );
    } catch (err) {
      this.logger.error('rate-limiter backfill failed', err as Error);
    }
  }
}
