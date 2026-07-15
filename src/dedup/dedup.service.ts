import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as path from 'path';
import { DEDUP_REPO } from './dedup.repo';
import type { DedupRepo } from './dedup.repo';

const DEFAULT_JSON_FILE = './data/posted-log.json';
const DEFAULT_GC_WINDOW_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class DedupService implements OnModuleInit {
  private readonly logger = new Logger(DedupService.name);
  private readonly jsonBackfillPath: string = path.resolve(DEFAULT_JSON_FILE);

  constructor(@Inject(DEDUP_REPO) private readonly repo: DedupRepo) {}

  async onModuleInit(): Promise<void> {
    await this.maybeBackfillFromJson();
    await this.gc();
  }

  /**
   * Mark a catalog id as posted at the current timestamp.
   */
  async markPosted(catalogId: string): Promise<void> {
    if (!catalogId) return;
    await this.repo.markPosted(catalogId, new Date());
  }

  /**
   * Was this catalogId posted within the last `windowDays` days?
   */
  async wasRecentlyPosted(
    catalogId: string,
    windowDays: number,
  ): Promise<boolean> {
    if (!catalogId) return false;
    const postedAt = await this.repo.getPostedAt(catalogId);
    if (!postedAt) return false;
    const ageMs = Date.now() - postedAt.getTime();
    return ageMs < windowDays * DAY_MS;
  }

  /**
   * One-shot import from the legacy posted-log.json into the DB. Runs only
   * when the dedup table is empty and the JSON file is present — repeated
   * boots are no-ops. Keys without the `<source>:` prefix get `ml:` applied
   * (legacy data assumes Mercado Livre as the single source).
   */
  private async maybeBackfillFromJson(): Promise<void> {
    let existing: number;
    try {
      existing = await this.repo.count();
    } catch (err) {
      this.logger.error('dedup count() failed', err as Error);
      return;
    }
    if (existing > 0) return;

    let raw: string;
    try {
      raw = await fs.readFile(this.jsonBackfillPath, 'utf8');
    } catch (err: any) {
      if (err && err.code === 'ENOENT') {
        this.logger.log(
          `No legacy ${this.jsonBackfillPath} — starting empty dedup table`,
        );
        return;
      }
      this.logger.warn(
        `Failed to read ${this.jsonBackfillPath} for backfill: ${(err as Error).message}`,
      );
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.logger.warn(
        `Legacy ${this.jsonBackfillPath} is not valid JSON — skipping backfill`,
      );
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;

    const entries: Array<{ catalogId: string; postedAt: Date }> = [];
    for (const [k, v] of Object.entries(parsed as Record<string, string>)) {
      const catalogId = k.includes(':') ? k : `ml:${k}`;
      const ts = Date.parse(typeof v === 'string' ? v : '');
      if (Number.isNaN(ts)) continue;
      entries.push({ catalogId, postedAt: new Date(ts) });
    }
    if (entries.length === 0) return;

    try {
      await this.repo.importMany(entries);
      this.logger.log(
        `Backfilled ${entries.length} dedup entries from ${this.jsonBackfillPath}`,
      );
    } catch (err) {
      this.logger.error('Dedup backfill failed', err as Error);
    }
  }

  private async gc(): Promise<void> {
    const cutoff = new Date(Date.now() - 2 * DEFAULT_GC_WINDOW_DAYS * DAY_MS);
    try {
      const pruned = await this.repo.pruneOlderThan(cutoff);
      if (pruned > 0)
        this.logger.log(`Dedup GC: pruned ${pruned} stale entries`);
    } catch (err) {
      this.logger.error('Dedup GC failed', err as Error);
    }
  }
}
