import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs/promises';
import * as path from 'path';

interface PriceObservation {
  priceCents: number;
  at: string; // ISO timestamp
}

type PriceHistoryStore = Record<string, PriceObservation[]>;

const DEFAULT_FILE = './data/price-history.json';
const RETENTION_DAYS = 60;
const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class CurationService implements OnModuleInit {
  private readonly logger = new Logger(CurationService.name);
  private readonly filePath: string = path.resolve(DEFAULT_FILE);
  private store: PriceHistoryStore = {};
  private loaded = false;
  private writeLock: Promise<void> = Promise.resolve();

  private readonly requireHistory: boolean;
  private readonly discountThreshold: number;
  private readonly minHistoryDays: number;

  constructor(private readonly config: ConfigService) {
    this.requireHistory =
      this.config.get<string>('CURATION_REQUIRE_HISTORY', 'false') === 'true';
    this.discountThreshold = Number(
      this.config.get<string>('CURATION_DISCOUNT_THRESHOLD', '0.85'),
    );
    this.minHistoryDays = Number(
      this.config.get<string>('CURATION_MIN_HISTORY_DAYS', '7'),
    );
  }

  async onModuleInit(): Promise<void> {
    await this.load();
  }

  /**
   * Append a price observation for `catalogId` at the current time and persist.
   * Old entries (> RETENTION_DAYS) are pruned on every write.
   */
  async record(catalogId: string, priceCents: number): Promise<void> {
    if (!catalogId) return;
    if (!Number.isFinite(priceCents) || priceCents < 0) return;
    if (!this.loaded) await this.load();

    const list = this.store[catalogId] ?? [];
    list.push({
      priceCents: Math.round(priceCents),
      at: new Date().toISOString(),
    });
    this.store[catalogId] = list;

    this.pruneOlderThan(RETENTION_DAYS);
    await this.persist();
  }

  /**
   * Median priceCents over the last `days` days for a catalog id.
   * Returns null when no observations are in window.
   */
  median(catalogId: string, days: number): number | null {
    const prices = this.pricesWithinDays(catalogId, days);
    if (prices.length === 0) return null;
    const sorted = [...prices].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 0) {
      return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
    }
    return sorted[mid];
  }

  /**
   * Count of distinct calendar days observed for a catalog id (UTC date keys).
   */
  historyDays(catalogId: string): number {
    const list = this.store[catalogId];
    if (!list || list.length === 0) return 0;
    const distinct = new Set<string>();
    for (const obs of list) {
      const t = Date.parse(obs.at);
      if (Number.isNaN(t)) continue;
      distinct.add(new Date(t).toISOString().slice(0, 10));
    }
    return distinct.size;
  }

  /**
   * Return `true` when the current price looks like a fake discount:
   * currentPriceCents >= median(30d) * threshold AND historyDays >= minHistoryDays.
   *
   * When history is below the minimum:
   *  - if CURATION_REQUIRE_HISTORY=true  → treat as fake (block publish)
   *  - otherwise                          → return false (allow publish)
   */
  isFakeDiscount(catalogId: string, currentPriceCents: number): boolean {
    const days = this.historyDays(catalogId);
    if (days < this.minHistoryDays) {
      return this.requireHistory;
    }
    const med = this.median(catalogId, 30);
    if (med == null) return this.requireHistory;
    return currentPriceCents >= med * this.discountThreshold;
  }

  /**
   * Returns a badge string when the current price is at-or-below the historical
   * minimum for the longest applicable window (30 > 14 > 7). Returns null when
   * history is below the minimum.
   */
  getLowestPriceBadge(
    catalogId: string,
    currentPriceCents: number,
  ): string | null {
    const days = this.historyDays(catalogId);
    if (days < this.minHistoryDays) return null;

    const min30 = this.minWithinDays(catalogId, 30);
    if (min30 != null && currentPriceCents <= min30) {
      return '📉 Menor preço em 30 dias';
    }
    const min14 = this.minWithinDays(catalogId, 14);
    if (min14 != null && currentPriceCents <= min14) {
      return '📉 Menor preço em 14 dias';
    }
    const min7 = this.minWithinDays(catalogId, 7);
    if (min7 != null && currentPriceCents <= min7) {
      return '📉 Menor preço em 7 dias';
    }
    return null;
  }

  private pricesWithinDays(catalogId: string, days: number): number[] {
    const list = this.store[catalogId];
    if (!list || list.length === 0) return [];
    const cutoff = Date.now() - days * DAY_MS;
    const out: number[] = [];
    for (const obs of list) {
      const t = Date.parse(obs.at);
      if (Number.isNaN(t)) continue;
      if (t >= cutoff) out.push(obs.priceCents);
    }
    return out;
  }

  private minWithinDays(catalogId: string, days: number): number | null {
    const prices = this.pricesWithinDays(catalogId, days);
    if (prices.length === 0) return null;
    let m = prices[0];
    for (let i = 1; i < prices.length; i++) {
      if (prices[i] < m) m = prices[i];
    }
    return m;
  }

  private pruneOlderThan(days: number): void {
    const cutoff = Date.now() - days * DAY_MS;
    let removed = 0;
    for (const [id, list] of Object.entries(this.store)) {
      const kept = list.filter((obs) => {
        const t = Date.parse(obs.at);
        return !Number.isNaN(t) && t >= cutoff;
      });
      removed += list.length - kept.length;
      if (kept.length === 0) {
        delete this.store[id];
      } else {
        this.store[id] = kept;
      }
    }
    if (removed > 0) {
      this.logger.debug(`Pruned ${removed} stale price observations`);
    }
  }

  private async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        this.store = parsed as PriceHistoryStore;
      } else {
        this.store = {};
      }
      const count = Object.values(this.store).reduce(
        (acc, v) => acc + (Array.isArray(v) ? v.length : 0),
        0,
      );
      this.logger.log(
        `Loaded ${count} price observations across ${Object.keys(this.store).length} catalogs from ${this.filePath}`,
      );
    } catch (err: any) {
      if (err && err.code === 'ENOENT') {
        this.logger.warn(
          `${this.filePath} not found — starting empty price history`,
        );
        this.store = {};
      } else {
        this.logger.error(`Failed to load ${this.filePath}`, err as Error);
        this.store = {};
      }
    }

    this.pruneOlderThan(RETENTION_DAYS);
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

    const data = JSON.stringify(this.store, null, 2);
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
