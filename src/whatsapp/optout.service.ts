import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * P2-27. Opt-out registry. File-backed JIDs that should never receive sends.
 */
const DEFAULT_FILE = './data/wa-optout.json';

interface OptoutState {
  jids: string[];
}

@Injectable()
export class OptoutService implements OnModuleInit {
  private readonly logger = new Logger(OptoutService.name);
  private readonly filePath: string = path.resolve(DEFAULT_FILE);
  private state: OptoutState = { jids: [] };
  private loaded = false;
  private writeLock: Promise<void> = Promise.resolve();

  async onModuleInit(): Promise<void> {
    await this.load();
  }

  isOptedOut(jid: string): boolean {
    if (!jid) return false;
    return this.state.jids.includes(jid);
  }

  list(): string[] {
    return [...this.state.jids];
  }

  async add(jid: string): Promise<void> {
    if (!jid) return;
    if (!this.loaded) await this.load();
    if (this.state.jids.includes(jid)) return;
    this.state.jids.push(jid);
    await this.persist();
    this.logger.log(`Opt-out added: ${jid}`);
  }

  async remove(jid: string): Promise<boolean> {
    if (!this.loaded) await this.load();
    const before = this.state.jids.length;
    this.state.jids = this.state.jids.filter((j) => j !== jid);
    if (this.state.jids.length === before) return false;
    await this.persist();
    return true;
  }

  private async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.jids)) {
        this.state = {
          jids: parsed.jids.filter((j: any) => typeof j === 'string'),
        };
      }
      this.logger.log(
        `Loaded ${this.state.jids.length} opt-out entries from ${this.filePath}`,
      );
    } catch (err: any) {
      if (err && err.code === 'ENOENT') {
        this.logger.warn(`${this.filePath} not found — starting empty`);
        this.state = { jids: [] };
      } else {
        this.logger.error(`Failed to load ${this.filePath}`, err as Error);
        this.state = { jids: [] };
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
