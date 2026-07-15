import { Injectable } from '@nestjs/common';
import type { JudgeVerdict } from './judge.port';

interface Entry {
  verdict: JudgeVerdict;
  priceCents: number;
  at: number;
}

/**
 * In-memory verdict cache: a gray-zone deal recurring on every tick doesn't
 * pay one LLM call per tick. Invalidated by TTL or price drift > 2%.
 * Insertion-ordered Map => first key is the oldest (eviction).
 */
@Injectable()
export class JudgeVerdictCache {
  private readonly map = new Map<string, Entry>();

  constructor(
    private readonly ttlMs = 6 * 60 * 60 * 1000,
    private readonly maxEntries = 500,
    private readonly maxPriceDrift = 0.02,
  ) {}

  get(
    catalogId: string,
    priceCents: number,
    now = Date.now(),
  ): JudgeVerdict | null {
    const e = this.map.get(catalogId);
    if (!e) return null;
    if (now - e.at > this.ttlMs) {
      this.map.delete(catalogId);
      return null;
    }
    if (
      e.priceCents > 0 &&
      Math.abs(priceCents - e.priceCents) / e.priceCents > this.maxPriceDrift
    ) {
      this.map.delete(catalogId);
      return null;
    }
    return e.verdict;
  }

  set(
    catalogId: string,
    priceCents: number,
    verdict: JudgeVerdict,
    now = Date.now(),
  ): void {
    if (this.map.size >= this.maxEntries && !this.map.has(catalogId)) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(catalogId, { verdict, priceCents, at: now });
  }
}
