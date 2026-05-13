import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * P1-13. WhatsApp warmup rate limiter.
 *
 * Caps per chip age (days since WA_CHIP_FIRST_USE_DATE):
 *   0-7d  : 5/h,  30/d
 *   8-14d : 10/h, 80/d
 *   15-30d: 20/h, 150/d
 *   31+d  : 50/h, 400/d
 *
 * Counters bucketed by hour (YYYY-MM-DDTHH) and day (YYYY-MM-DD), persisted
 * to ./data/wa-counters.json so they survive process restarts.
 */

type CounterState = {
  hour: Record<string, number>;
  day: Record<string, number>;
};

const DEFAULT_FILE = './data/wa-counters.json';

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
  private readonly filePath: string = path.resolve(DEFAULT_FILE);
  private state: CounterState = { hour: {}, day: {} };
  private loaded = false;
  private writeLock: Promise<void> = Promise.resolve();

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    await this.load();
  }

  /** Days since WA_CHIP_FIRST_USE_DATE. Returns 0 if env not set. */
  private chipAgeDays(): number {
    const raw = this.config.get<string>('WA_CHIP_FIRST_USE_DATE', '');
    if (!raw) return 9999; // unknown -> assume mature
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
    if (!this.loaded) await this.load();
    const hk = this.hourKey();
    const dk = this.dayKey();
    this.state.hour[hk] = (this.state.hour[hk] ?? 0) + 1;
    this.state.day[dk] = (this.state.day[dk] ?? 0) + 1;
    await this.persist();
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

  private async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        this.state = {
          hour:
            parsed.hour && typeof parsed.hour === 'object' ? parsed.hour : {},
          day: parsed.day && typeof parsed.day === 'object' ? parsed.day : {},
        };
      }
      this.gc();
      this.logger.log(
        `Rate limiter loaded. chipAgeDays=${this.chipAgeDays()} caps=${JSON.stringify(this.getCaps())}`,
      );
    } catch (err: any) {
      if (err && err.code === 'ENOENT') {
        this.logger.warn(`${this.filePath} not found — starting fresh`);
        this.state = { hour: {}, day: {} };
      } else {
        this.logger.error(`Failed to load ${this.filePath}`, err as Error);
        this.state = { hour: {}, day: {} };
      }
    }
    this.loaded = true;
  }

  /** Drop buckets older than 2 days (hours) / 14 days (days). */
  private gc(): void {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    for (const k of Object.keys(this.state.hour)) {
      const t = Date.parse(k.replace('T', 'T') + ':00:00Z');
      if (Number.isNaN(t) || now - t > 2 * dayMs) {
        delete this.state.hour[k];
      }
    }
    for (const k of Object.keys(this.state.day)) {
      const t = Date.parse(k + 'T00:00:00Z');
      if (Number.isNaN(t) || now - t > 14 * dayMs) {
        delete this.state.day[k];
      }
    }
  }

  private async persist(): Promise<void> {
    const next = this.writeLock.then(() => this.persistNow());
    this.writeLock = next.catch(() => undefined);
    return next;
  }

  private async persistNow(): Promise<void> {
    const dir = path.dirname(this.filePath);
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (err) {
      this.logger.error(`Failed to ensure dir ${dir}`, err as Error);
      throw err;
    }
    const data = JSON.stringify(this.state, null, 2);
    const tmpPath = `${this.filePath}.tmp`;
    try {
      await fs.writeFile(tmpPath, data, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(tmpPath, this.filePath);
    } catch (err) {
      this.logger.error(`Failed to write ${this.filePath}`, err as Error);
      try {
        await fs.unlink(tmpPath);
      } catch {
        // ignore
      }
      throw err;
    }
  }
}
