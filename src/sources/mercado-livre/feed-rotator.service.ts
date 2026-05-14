// src/sources/mercado-livre/feed-rotator.service.ts

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';

interface WeightedFeed {
  feedId: string;
  weight: number;
}

interface PersistedState {
  lastFeedId: string | null;
  updatedAt: string;
}

const DEFAULT_WEIGHTS = 'MLB1648:3,MLB1000:2,MLB1051:2,MLB1276:1';
const STATE_FILE = path.join(process.cwd(), 'data', 'ml-last-feed.json');
const LEGACY_STATE_FILE = path.join(
  process.cwd(),
  'data',
  'last-category.json',
);

@Injectable()
export class FeedRotatorService implements OnModuleInit {
  private readonly logger = new Logger(FeedRotatorService.name);
  private weights: WeightedFeed[] = [];
  private lastFeedId: string | null = null;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    this.weights = this.parseWeights(
      this.config.get<string>('CATEGORY_WEIGHTS', DEFAULT_WEIGHTS) ??
        DEFAULT_WEIGHTS,
    );
    this.maybeMigrateLegacyState();
    this.loadState();
    this.logger.log(
      `Loaded ${this.weights.length} weighted feed(s); last=${this.lastFeedId ?? 'none'}`,
    );
  }

  parseWeights(raw: string): WeightedFeed[] {
    const out: WeightedFeed[] = [];
    if (!raw || !raw.trim()) return out;
    for (const chunk of raw.split(',')) {
      const trimmed = chunk.trim();
      if (!trimmed) continue;
      const [feedId, w] = trimmed.split(':').map((s) => s.trim());
      if (!feedId) continue;
      const weight = Number(w);
      if (!Number.isFinite(weight) || weight <= 0) continue;
      out.push({ feedId, weight });
    }
    return out;
  }

  pick(): string | null {
    if (this.weights.length === 0) return null;
    if (this.weights.length === 1) {
      const only = this.weights[0].feedId;
      this.persist(only);
      return only;
    }

    const candidates =
      this.lastFeedId !== null
        ? this.weights.filter((w) => w.feedId !== this.lastFeedId)
        : this.weights;

    const pool = candidates.length > 0 ? candidates : this.weights;
    const total = pool.reduce((s, w) => s + w.weight, 0);
    let roll = Math.random() * total;
    let chosen = pool[pool.length - 1].feedId;
    for (const w of pool) {
      roll -= w.weight;
      if (roll <= 0) {
        chosen = w.feedId;
        break;
      }
    }

    this.persist(chosen);
    return chosen;
  }

  getLast(): string | null {
    return this.lastFeedId;
  }

  getWeighted(): { feedId: string; weight: number }[] {
    return this.weights.map((w) => ({ feedId: w.feedId, weight: w.weight }));
  }

  private persist(feedId: string): void {
    this.lastFeedId = feedId;
    try {
      const dir = path.dirname(STATE_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const payload: PersistedState = {
        lastFeedId: feedId,
        updatedAt: new Date().toISOString(),
      };
      fs.writeFileSync(STATE_FILE, JSON.stringify(payload, null, 2), 'utf8');
    } catch (err) {
      this.logger.warn(
        `Failed to persist last feed: ${(err as Error).message}`,
      );
    }
  }

  private loadState(): void {
    try {
      if (!fs.existsSync(STATE_FILE)) return;
      const raw = fs.readFileSync(STATE_FILE, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PersistedState> & {
        lastCategory?: string;
      };
      if (parsed && typeof parsed.lastFeedId === 'string') {
        this.lastFeedId = parsed.lastFeedId;
      } else if (parsed && typeof parsed.lastCategory === 'string') {
        this.lastFeedId = parsed.lastCategory;
      }
    } catch (err) {
      this.logger.warn(
        `Failed to load last feed state: ${(err as Error).message}`,
      );
    }
  }

  private maybeMigrateLegacyState(): void {
    try {
      if (fs.existsSync(STATE_FILE)) return;
      if (!fs.existsSync(LEGACY_STATE_FILE)) return;
      const raw = fs.readFileSync(LEGACY_STATE_FILE, 'utf8');
      const parsed = JSON.parse(raw) as { lastCategory?: string };
      if (parsed && typeof parsed.lastCategory === 'string') {
        const payload: PersistedState = {
          lastFeedId: parsed.lastCategory,
          updatedAt: new Date().toISOString(),
        };
        const dir = path.dirname(STATE_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(STATE_FILE, JSON.stringify(payload, null, 2), 'utf8');
        this.logger.log(
          `Migrated last-category.json -> ml-last-feed.json (lastFeedId=${parsed.lastCategory})`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `Legacy state migration failed: ${(err as Error).message}`,
      );
    }
  }
}
