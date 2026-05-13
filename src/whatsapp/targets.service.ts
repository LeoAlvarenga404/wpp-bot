import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * P2-25. Multi-target broadcast registry.
 * Persisted to ./data/wa-targets.json. Seeded with WA_TARGET_JID on first load
 * when set and not already present.
 */
export interface WaTarget {
  jid: string;
  name: string;
  active: boolean;
}

const DEFAULT_FILE = './data/wa-targets.json';

@Injectable()
export class TargetsService implements OnModuleInit {
  private readonly logger = new Logger(TargetsService.name);
  private readonly filePath: string = path.resolve(DEFAULT_FILE);
  private targets: WaTarget[] = [];
  private loaded = false;
  private writeLock: Promise<void> = Promise.resolve();

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    await this.load();
    await this.seedFromEnv();
  }

  list(): WaTarget[] {
    return [...this.targets];
  }

  getActiveJids(): string[] {
    return this.targets.filter((t) => t.active).map((t) => t.jid);
  }

  async add(jid: string, name: string): Promise<WaTarget> {
    if (!jid) throw new Error('jid required');
    if (!this.loaded) await this.load();
    const existing = this.targets.find((t) => t.jid === jid);
    if (existing) {
      existing.name = name || existing.name;
      existing.active = true;
      await this.persist();
      return existing;
    }
    const next: WaTarget = { jid, name: name || jid, active: true };
    this.targets.push(next);
    await this.persist();
    return next;
  }

  async remove(jid: string): Promise<boolean> {
    if (!this.loaded) await this.load();
    const before = this.targets.length;
    this.targets = this.targets.filter((t) => t.jid !== jid);
    if (this.targets.length === before) return false;
    await this.persist();
    return true;
  }

  async setActive(jid: string, active: boolean): Promise<boolean> {
    if (!this.loaded) await this.load();
    const t = this.targets.find((x) => x.jid === jid);
    if (!t) return false;
    t.active = active;
    await this.persist();
    return true;
  }

  private async seedFromEnv(): Promise<void> {
    const seed = this.config.get<string>('WA_TARGET_JID', '');
    if (!seed) return;
    if (this.targets.some((t) => t.jid === seed)) return;
    this.targets.push({ jid: seed, name: 'env:WA_TARGET_JID', active: true });
    await this.persist();
    this.logger.log(`Seeded target from env: ${seed}`);
  }

  private async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        this.targets = parsed.filter(
          (e: any) => e && typeof e.jid === 'string',
        ) as WaTarget[];
      }
      this.logger.log(
        `Loaded ${this.targets.length} WA target(s) from ${this.filePath}`,
      );
    } catch (err: any) {
      if (err && err.code === 'ENOENT') {
        this.logger.warn(`${this.filePath} not found — starting empty list`);
        this.targets = [];
      } else {
        this.logger.error(`Failed to load ${this.filePath}`, err as Error);
        this.targets = [];
      }
    }
    this.loaded = true;
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
    const data = JSON.stringify(this.targets, null, 2);
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
