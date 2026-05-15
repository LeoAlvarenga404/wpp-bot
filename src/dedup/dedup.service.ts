import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as path from 'path';

type PostedLog = Record<string, string>;

const DEFAULT_FILE = './data/posted-log.json';
const DEFAULT_GC_WINDOW_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class DedupService implements OnModuleInit {
  private readonly logger = new Logger(DedupService.name);
  private readonly filePath: string = path.resolve(DEFAULT_FILE);
  private log: PostedLog = {};
  private loaded = false;
  private writeLock: Promise<void> = Promise.resolve();

  async onModuleInit(): Promise<void> {
    await this.load();
  }

  /**
   * Mark a catalog id as posted at the current timestamp.
   */
  async markPosted(catalogId: string): Promise<void> {
    if (!catalogId) return;
    if (!this.loaded) await this.load();
    this.log[catalogId] = new Date().toISOString();
    await this.persist();
  }

  /**
   * Was this catalogId posted within the last `windowDays` days?
   */
  async wasRecentlyPosted(
    catalogId: string,
    windowDays: number,
  ): Promise<boolean> {
    if (!catalogId) return false;
    if (!this.loaded) await this.load();
    const ts = this.log[catalogId];
    if (!ts) return false;
    const postedAt = Date.parse(ts);
    if (Number.isNaN(postedAt)) return false;
    const ageMs = Date.now() - postedAt;
    return ageMs < windowDays * DAY_MS;
  }

  private async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      this.log =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as PostedLog)
          : {};
      this.logger.log(
        `Loaded ${Object.keys(this.log).length} dedup entries from ${this.filePath}`,
      );
    } catch (err: any) {
      if (err && err.code === 'ENOENT') {
        this.logger.warn(
          `${this.filePath} not found — starting empty dedup log`,
        );
        this.log = {};
      } else {
        this.logger.error(`Failed to load ${this.filePath}`, err as Error);
        this.log = {};
      }
    }

    let migrated = 0;
    for (const k of Object.keys(this.log)) {
      if (!k.includes(':')) {
        const newKey = `ml:${k}`;
        if (!this.log[newKey]) this.log[newKey] = this.log[k];
        delete this.log[k];
        migrated++;
      }
    }
    if (migrated > 0) {
      this.logger.log(`Migrated ${migrated} dedup key(s) to ml: prefix`);
      try {
        await this.persist();
      } catch (err) {
        this.logger.error('Failed to persist migrated dedup log', err as Error);
      }
    }

    // GC entries older than 2 * windowDays (default 14d for default window 7d).
    const gcWindowMs = 2 * DEFAULT_GC_WINDOW_DAYS * DAY_MS;
    const now = Date.now();
    let pruned = 0;
    for (const [id, ts] of Object.entries(this.log)) {
      const t = Date.parse(ts);
      if (Number.isNaN(t) || now - t > gcWindowMs) {
        delete this.log[id];
        pruned++;
      }
    }
    if (pruned > 0) {
      this.logger.log(`Dedup GC: pruned ${pruned} stale entries`);
      // Persist pruned state to disk.
      try {
        await this.persist();
      } catch (err) {
        this.logger.error('Failed to persist after GC', err as Error);
      }
    }

    this.loaded = true;
  }

  private async persist(): Promise<void> {
    // Serialize writes to avoid clobbering.
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

    const data = JSON.stringify(this.log, null, 2);
    const tmpPath = `${this.filePath}.tmp`;
    try {
      await fs.writeFile(tmpPath, data, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(tmpPath, this.filePath);
    } catch (err) {
      this.logger.error(`Failed to write ${this.filePath}`, err as Error);
      // Best-effort cleanup of the temp file.
      try {
        await fs.unlink(tmpPath);
      } catch {
        // ignore
      }
      throw err;
    }
  }
}
