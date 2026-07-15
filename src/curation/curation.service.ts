import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs/promises';
import * as path from 'path';
import { analyze } from '../deal-score/price-analytics';
import type { PriceAnalytics, PriceObservation } from '../deal-score/types';
import { CURATION_REPO } from './curation.repo';
import type { CurationRepo, PriceRow } from './curation.repo';

export type { PriceObservation } from '../deal-score/types';

type PriceHistoryStore = Record<string, PriceObservation[]>;

const DEFAULT_JSON_FILE = './data/price-history.json';
const RETENTION_DAYS = 60;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Price-history curation. The repo (`PriceHistory` table) is the durable
 * source of truth; an in-memory `store` is hydrated on boot and write-through
 * keeps it coherent. Sync read methods (`median`, `historyDays`,
 * `getAnalytics`, `getLowestPriceBadge`, `isFakeDiscount`) hit the cache —
 * the dispatch path doesn't tolerate a per-deal DB round trip.
 */
@Injectable()
export class CurationService implements OnModuleInit {
  private readonly logger = new Logger(CurationService.name);
  private readonly jsonBackfillPath: string = path.resolve(DEFAULT_JSON_FILE);
  private store: PriceHistoryStore = {};

  private readonly requireHistory: boolean;
  private readonly discountThreshold: number;
  private readonly minHistoryDays: number;

  constructor(
    private readonly config: ConfigService,
    @Inject(CURATION_REPO) private readonly repo: CurationRepo,
  ) {
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
    await this.maybeBackfillFromJson();
    await this.hydrate();
    await this.gc();
  }

  async record(catalogId: string, priceCents: number): Promise<void> {
    if (!catalogId) return;
    if (!Number.isFinite(priceCents) || priceCents < 0) return;
    const rounded = Math.round(priceCents);
    const now = new Date();
    const list = this.store[catalogId] ?? [];
    list.push({ priceCents: rounded, at: now.toISOString() });
    this.store[catalogId] = list;
    try {
      await this.repo.insert({
        catalogId,
        priceCents: rounded,
        capturedAt: now,
      });
    } catch (err) {
      this.logger.error('curation insert failed', err as Error);
    }
  }

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

  isFakeDiscount(catalogId: string, currentPriceCents: number): boolean {
    const days = this.historyDays(catalogId);
    if (days < this.minHistoryDays) {
      return this.requireHistory;
    }
    const med = this.median(catalogId, 30);
    if (med == null) return this.requireHistory;
    return currentPriceCents >= med * this.discountThreshold;
  }

  getObservations(catalogId: string): PriceObservation[] {
    const list = this.store[catalogId];
    return list ? [...list] : [];
  }

  getAnalytics(catalogId: string, now?: Date): PriceAnalytics {
    return analyze({ observations: this.getObservations(catalogId), now });
  }

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

  private async hydrate(): Promise<void> {
    let rows: PriceRow[];
    try {
      rows = await this.repo.loadAll(RETENTION_DAYS);
    } catch (err) {
      this.logger.error('curation hydrate failed', err as Error);
      return;
    }
    for (const r of rows) {
      const list = this.store[r.catalogId] ?? [];
      list.push({
        priceCents: r.priceCents,
        at: r.capturedAt.toISOString(),
      });
      this.store[r.catalogId] = list;
    }
    const count = rows.length;
    this.logger.log(
      `Hydrated ${count} price observations across ${Object.keys(this.store).length} catalogs`,
    );
  }

  private async gc(): Promise<void> {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * DAY_MS);
    try {
      const pruned = await this.repo.pruneOlderThan(cutoff);
      if (pruned > 0) {
        this.logger.log(`Curation GC: pruned ${pruned} stale observations`);
      }
    } catch (err) {
      this.logger.warn(`Curation GC failed: ${(err as Error).message}`);
    }
    // Mirror pruning in memory too.
    const cutoffMs = cutoff.getTime();
    for (const [id, list] of Object.entries(this.store)) {
      const kept = list.filter((obs) => {
        const t = Date.parse(obs.at);
        return !Number.isNaN(t) && t >= cutoffMs;
      });
      if (kept.length === 0) {
        delete this.store[id];
      } else {
        this.store[id] = kept;
      }
    }
  }

  private async maybeBackfillFromJson(): Promise<void> {
    let existing: number;
    try {
      existing = await this.repo.count();
    } catch (err) {
      this.logger.error('curation count() failed', err as Error);
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
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;

    const rows: PriceRow[] = [];
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(v)) continue;
      const catalogId = k.includes(':') ? k : `ml:${k}`;
      for (const obs of v as Array<{ priceCents?: unknown; at?: unknown }>) {
        const priceCents = Number(obs?.priceCents);
        const ts = typeof obs?.at === 'string' ? Date.parse(obs.at) : NaN;
        if (!Number.isFinite(priceCents) || Number.isNaN(ts)) continue;
        rows.push({
          catalogId,
          priceCents,
          capturedAt: new Date(ts),
        });
      }
    }
    if (rows.length === 0) return;

    try {
      await this.repo.importMany(rows);
      this.logger.log(
        `Backfilled ${rows.length} price observations from ${this.jsonBackfillPath}`,
      );
    } catch (err) {
      this.logger.error('Curation backfill failed', err as Error);
    }
  }
}
