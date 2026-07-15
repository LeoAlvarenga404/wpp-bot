// src/enrichment/seller-cache.service.ts

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { SellerInfo } from './types';

type SellerStore = Record<string, SellerInfo>;

@Injectable()
export class SellerCacheService implements OnModuleInit {
  private readonly logger = new Logger(SellerCacheService.name);
  private filePath: string;
  private store: SellerStore = {};
  private loaded = false;
  private writeLock: Promise<void> = Promise.resolve();
  private readonly ttlMs: number;

  constructor(private readonly config: ConfigService) {
    const hours = Number(
      this.config.get<string>('SELLER_CACHE_TTL_HOURS', '24'),
    );
    this.ttlMs = hours * 60 * 60 * 1000;
    this.filePath = path.resolve(
      this.config.get<string>(
        'SELLER_CACHE_FILE',
        './data/seller-cache.json',
      ) ?? './data/seller-cache.json',
    );
  }

  async onModuleInit(): Promise<void> {
    await this.load();
  }

  get(sellerId: number, now?: Date): SellerInfo | null {
    if (!this.loaded) return null;
    const entry = this.store[String(sellerId)];
    if (!entry) return null;
    const fetchedMs = Date.parse(entry.fetchedAt);
    if (Number.isNaN(fetchedMs)) return null;
    const nowMs = (now ?? new Date()).getTime();
    if (nowMs - fetchedMs > this.ttlMs) return null;
    return entry;
  }

  async set(info: SellerInfo): Promise<void> {
    if (!this.loaded) await this.load();
    this.store[String(info.sellerId)] = info;
    await this.persist();
  }

  private async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      this.store =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as SellerStore)
          : {};
    } catch (err: any) {
      if (err && err.code === 'ENOENT') {
        this.store = {};
      } else {
        this.logger.warn(`Failed to load ${this.filePath}: ${err?.message}`);
        this.store = {};
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

    const tmp = `${this.filePath}.tmp`;
    const data = JSON.stringify(this.store, null, 2);
    try {
      await fs.writeFile(tmp, data, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(tmp, this.filePath);
    } catch (err) {
      this.logger.error(`Failed to write ${this.filePath}`, err as Error);
      try {
        await fs.unlink(tmp);
      } catch {
        // ignore
      }
      throw err;
    }
  }
}
