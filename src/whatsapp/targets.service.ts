import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs/promises';
import * as path from 'path';
import { TARGETS_REPO } from './targets.repo';
import type { TargetsRepo } from './targets.repo';

/**
 * P2-25. Multi-target broadcast registry.
 * Backed by the `WaTarget` Postgres table. On first boot the table is seeded
 * from the legacy ./data/wa-targets.json (if present) and from
 * `WA_TARGET_JID` (if set and not already registered).
 */
export interface WaTarget {
  jid: string;
  name: string;
  active: boolean;
}

const DEFAULT_JSON_FILE = './data/wa-targets.json';

@Injectable()
export class TargetsService implements OnModuleInit {
  private readonly logger = new Logger(TargetsService.name);
  private readonly jsonBackfillPath: string = path.resolve(DEFAULT_JSON_FILE);

  constructor(
    private readonly config: ConfigService,
    @Inject(TARGETS_REPO) private readonly repo: TargetsRepo,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.maybeBackfillFromJson();
    await this.seedFromEnv();
  }

  async list(): Promise<WaTarget[]> {
    return this.repo.findAll();
  }

  async getActiveJids(): Promise<string[]> {
    const all = await this.repo.findAll();
    return all.filter((t) => t.active).map((t) => t.jid);
  }

  async add(jid: string, name: string): Promise<WaTarget> {
    if (!jid) throw new Error('jid required');
    return this.repo.upsert({ jid, name: name || jid, active: true });
  }

  async remove(jid: string): Promise<boolean> {
    return this.repo.delete(jid);
  }

  async setActive(jid: string, active: boolean): Promise<boolean> {
    const existing = await this.repo.findOne(jid);
    if (!existing) return false;
    await this.repo.upsert({ ...existing, active });
    return true;
  }

  private async seedFromEnv(): Promise<void> {
    const seed = this.config.get<string>('WA_TARGET_JID', '');
    if (!seed) return;
    const existing = await this.repo.findOne(seed);
    if (existing) return;
    await this.repo.upsert({
      jid: seed,
      name: 'env:WA_TARGET_JID',
      active: true,
    });
    this.logger.log(`Seeded target from env: ${seed}`);
  }

  private async maybeBackfillFromJson(): Promise<void> {
    let existing: number;
    try {
      existing = await this.repo.count();
    } catch (err) {
      this.logger.error('targets count() failed', err as Error);
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
    if (!Array.isArray(parsed)) return;

    const targets: WaTarget[] = [];
    for (const e of parsed as any[]) {
      if (!e || typeof e.jid !== 'string') continue;
      targets.push({
        jid: e.jid,
        name: typeof e.name === 'string' && e.name ? e.name : e.jid,
        active: e.active !== false,
      });
    }
    if (targets.length === 0) return;

    try {
      await this.repo.importMany(targets);
      this.logger.log(
        `Backfilled ${targets.length} WA target(s) from ${this.jsonBackfillPath}`,
      );
    } catch (err) {
      this.logger.error('Targets backfill failed', err as Error);
    }
  }
}
