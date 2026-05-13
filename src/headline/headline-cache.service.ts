import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs/promises';
import * as path from 'path';

interface CacheEntry {
  headline: string;
  createdAt: string;
}

@Injectable()
export class HeadlineCacheService implements OnModuleInit {
  private readonly logger = new Logger(HeadlineCacheService.name);
  private readonly map = new Map<string, CacheEntry>();
  private readonly filePath: string;
  private readonly ttlMs: number;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly config: ConfigService) {
    this.filePath = path.resolve(
      this.config.get<string>('HEADLINE_CACHE_PATH') ??
        './data/headlines.json',
    );
    const days = Number(this.config.get<string>('HEADLINE_CACHE_DAYS') ?? '30');
    this.ttlMs = Math.max(1, days) * 24 * 60 * 60 * 1000;
  }

  async onModuleInit(): Promise<void> {
    await this.load();
  }

  private async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, CacheEntry>;
      let stale = 0;
      for (const [k, v] of Object.entries(parsed)) {
        if (!v?.headline || !v?.createdAt) continue;
        if (this.isExpired(v.createdAt)) {
          stale++;
          continue;
        }
        this.map.set(k, v);
      }
      this.logger.log(
        `Loaded ${this.map.size} headline cache entries from ${this.filePath}` +
          (stale ? ` (pruned ${stale} stale)` : ''),
      );
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') {
        this.logger.warn(`${this.filePath} not found — starting empty cache`);
      } else {
        this.logger.error(`Failed to load ${this.filePath}`, err as Error);
      }
    }
  }

  private isExpired(createdAt: string): boolean {
    const t = new Date(createdAt).getTime();
    if (Number.isNaN(t)) return true;
    return Date.now() - t > this.ttlMs;
  }

  get(catalogId: string): string | undefined {
    const entry = this.map.get(catalogId);
    if (!entry) return undefined;
    if (this.isExpired(entry.createdAt)) {
      this.map.delete(catalogId);
      return undefined;
    }
    return entry.headline;
  }

  async set(catalogId: string, headline: string): Promise<void> {
    this.map.set(catalogId, {
      headline,
      createdAt: new Date().toISOString(),
    });
    await this.flush();
  }

  private flush(): Promise<void> {
    this.writeQueue = this.writeQueue.then(() => this.persist());
    return this.writeQueue;
  }

  private async persist(): Promise<void> {
    const out: Record<string, CacheEntry> = {};
    for (const [k, v] of this.map.entries()) out[k] = v;
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.writeFile(this.filePath, JSON.stringify(out, null, 2), 'utf-8');
    } catch (err) {
      this.logger.error(
        `Failed to persist headline cache to ${this.filePath}`,
        err as Error,
      );
    }
  }
}
