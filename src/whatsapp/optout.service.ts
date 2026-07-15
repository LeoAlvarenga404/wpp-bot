import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as path from 'path';
import { OPTOUT_REPO } from './optout.repo';
import type { OptoutRepo } from './optout.repo';

/**
 * P2-27. Opt-out registry — JIDs that must never receive sends.
 * Backed by the `WaOptout` Postgres table. On first boot the table is seeded
 * from the legacy ./data/wa-optout.json if present.
 */
const DEFAULT_JSON_FILE = './data/wa-optout.json';

@Injectable()
export class OptoutService implements OnModuleInit {
  private readonly logger = new Logger(OptoutService.name);
  private readonly jsonBackfillPath: string = path.resolve(DEFAULT_JSON_FILE);

  constructor(@Inject(OPTOUT_REPO) private readonly repo: OptoutRepo) {}

  async onModuleInit(): Promise<void> {
    await this.maybeBackfillFromJson();
  }

  async isOptedOut(jid: string): Promise<boolean> {
    if (!jid) return false;
    return this.repo.has(jid);
  }

  async list(): Promise<string[]> {
    return this.repo.list();
  }

  async add(jid: string): Promise<void> {
    if (!jid) return;
    await this.repo.add(jid);
    this.logger.log(`Opt-out added: ${jid}`);
  }

  async remove(jid: string): Promise<boolean> {
    return this.repo.remove(jid);
  }

  private async maybeBackfillFromJson(): Promise<void> {
    let existing: number;
    try {
      existing = await this.repo.count();
    } catch (err) {
      this.logger.error('optout count() failed', err as Error);
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

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.logger.warn(
        `Legacy ${this.jsonBackfillPath} is not valid JSON — skipping backfill`,
      );
      return;
    }
    const arr =
      parsed &&
      typeof parsed === 'object' &&
      Array.isArray((parsed as any).jids)
        ? ((parsed as any).jids as unknown[])
        : [];
    const jids = arr.filter(
      (j): j is string => typeof j === 'string' && j.length > 0,
    );
    if (jids.length === 0) return;

    try {
      await this.repo.importMany(jids);
      this.logger.log(
        `Backfilled ${jids.length} opt-out entries from ${this.jsonBackfillPath}`,
      );
    } catch (err) {
      this.logger.error('Optout backfill failed', err as Error);
    }
  }
}
