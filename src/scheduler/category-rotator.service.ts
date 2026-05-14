import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';

interface WeightedCategory {
  category: string;
  weight: number;
}

interface PersistedState {
  lastCategory: string | null;
  updatedAt: string;
}

const DEFAULT_WEIGHTS = 'MLB1648:3,MLB1000:2,MLB1051:2,MLB1276:1';
const STATE_FILE = path.join(process.cwd(), 'data', 'last-category.json');

@Injectable()
export class CategoryRotatorService implements OnModuleInit {
  private readonly logger = new Logger(CategoryRotatorService.name);
  private weights: WeightedCategory[] = [];
  private lastCategory: string | null = null;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    this.weights = this.parseWeights(
      this.config.get<string>('CATEGORY_WEIGHTS', DEFAULT_WEIGHTS) ??
        DEFAULT_WEIGHTS,
    );
    this.loadState();
    this.logger.log(
      `Loaded ${this.weights.length} weighted categor(ies); last=${this.lastCategory ?? 'none'}`,
    );
  }

  /**
   * Parse env string like "MLB1648:3,MLB1000:2" into weighted entries.
   * Invalid pairs are skipped. Empty input falls back to DEFAULT_WEIGHTS.
   */
  parseWeights(raw: string): WeightedCategory[] {
    const out: WeightedCategory[] = [];
    if (!raw || !raw.trim()) return out;
    for (const chunk of raw.split(',')) {
      const trimmed = chunk.trim();
      if (!trimmed) continue;
      const [cat, w] = trimmed.split(':').map((s) => s.trim());
      if (!cat) continue;
      const weight = Number(w);
      if (!Number.isFinite(weight) || weight <= 0) continue;
      out.push({ category: cat, weight });
    }
    return out;
  }

  /**
   * Weighted random pick. Never returns the same category as the previous call
   * (unless only a single category is configured).
   */
  pick(): string | null {
    if (this.weights.length === 0) return null;
    if (this.weights.length === 1) {
      const only = this.weights[0].category;
      this.persist(only);
      return only;
    }

    const candidates =
      this.lastCategory !== null
        ? this.weights.filter((w) => w.category !== this.lastCategory)
        : this.weights;

    const pool = candidates.length > 0 ? candidates : this.weights;
    const total = pool.reduce((s, w) => s + w.weight, 0);
    let roll = Math.random() * total;
    let chosen = pool[pool.length - 1].category;
    for (const w of pool) {
      roll -= w.weight;
      if (roll <= 0) {
        chosen = w.category;
        break;
      }
    }

    this.persist(chosen);
    return chosen;
  }

  getLast(): string | null {
    return this.lastCategory;
  }

  getWeighted(): { category: string; weight: number }[] {
    return this.weights.map((w) => ({ category: w.category, weight: w.weight }));
  }

  private persist(category: string): void {
    this.lastCategory = category;
    try {
      const dir = path.dirname(STATE_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const payload: PersistedState = {
        lastCategory: category,
        updatedAt: new Date().toISOString(),
      };
      fs.writeFileSync(STATE_FILE, JSON.stringify(payload, null, 2), 'utf8');
    } catch (err) {
      this.logger.warn(
        `Failed to persist last category: ${(err as Error).message}`,
      );
    }
  }

  private loadState(): void {
    try {
      if (!fs.existsSync(STATE_FILE)) return;
      const raw = fs.readFileSync(STATE_FILE, 'utf8');
      const parsed = JSON.parse(raw) as PersistedState;
      if (parsed && typeof parsed.lastCategory === 'string') {
        this.lastCategory = parsed.lastCategory;
      }
    } catch (err) {
      this.logger.warn(
        `Failed to load last category state: ${(err as Error).message}`,
      );
    }
  }
}
