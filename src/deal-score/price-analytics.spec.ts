// src/deal-score/price-analytics.spec.ts

import { analyze, detectPriceRaiseBeforeDiscount } from './price-analytics';
import { PriceObservation } from './types';

function obs(priceCents: number, daysAgo: number, now: Date): PriceObservation {
  const at = new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  return { priceCents, at };
}

describe('analyze()', () => {
  const now = new Date('2026-05-13T12:00:00Z');

  it('returns all nulls for empty history', () => {
    const r = analyze({ observations: [], now });
    expect(r.median7d).toBeNull();
    expect(r.median14d).toBeNull();
    expect(r.median30d).toBeNull();
    expect(r.min7d).toBeNull();
    expect(r.min14d).toBeNull();
    expect(r.min30d).toBeNull();
    expect(r.distinctDays).toBe(0);
    expect(r.lastObservedBefore).toBeNull();
    expect(r.trend).toBe('unknown');
  });

  it('returns single value for single observation', () => {
    const r = analyze({ observations: [obs(10000, 1, now)], now });
    expect(r.median7d).toBe(10000);
    expect(r.median14d).toBe(10000);
    expect(r.median30d).toBe(10000);
    expect(r.min7d).toBe(10000);
    expect(r.distinctDays).toBe(1);
  });

  it('computes median and min over correct windows', () => {
    const observations = [
      obs(10000, 1, now),
      obs(12000, 3, now),
      obs(8000, 5, now),
      obs(15000, 10, now),
      obs(20000, 20, now),
    ];
    const r = analyze({ observations, now });
    expect(r.min7d).toBe(8000);
    expect(r.min14d).toBe(8000);
    expect(r.min30d).toBe(8000);
    expect(r.median7d).toBe(10000);
    expect(r.median30d).toBe(12000);
  });

  it('counts distinct UTC dates', () => {
    const observations = [
      obs(10000, 0, now),
      obs(11000, 0, now),
      obs(12000, 1, now),
    ];
    const r = analyze({ observations, now });
    expect(r.distinctDays).toBe(2);
  });

  it('detects falling trend when m7 < m14 * 0.95', () => {
    const observations = [
      obs(8000, 1, now),
      obs(8000, 3, now),
      obs(8000, 5, now),
      obs(10000, 10, now),
      obs(10000, 12, now),
    ];
    const r = analyze({ observations, now });
    expect(r.trend).toBe('falling');
  });

  it('detects rising trend when m7 > m14 * 1.05', () => {
    const observations = [
      obs(12000, 1, now),
      obs(12000, 3, now),
      obs(12000, 5, now),
      obs(10000, 10, now),
      obs(10000, 12, now),
    ];
    const r = analyze({ observations, now });
    expect(r.trend).toBe('rising');
  });

  it('returns flat trend when within ±5%', () => {
    const observations = [
      obs(10000, 1, now),
      obs(10100, 3, now),
      obs(10000, 10, now),
      obs(10050, 12, now),
    ];
    const r = analyze({ observations, now });
    expect(r.trend).toBe('flat');
  });

  it('returns flat trend for single observation within 7d (both medians non-null)', () => {
    const observations = [obs(10000, 1, now)];
    const r = analyze({ observations, now });
    // single-day observation: m7 and m14 both equal 10000, ratio = 1.0 → flat,
    // but lastObservedBefore is null and trend should still be flat.
    expect(r.trend).toBe('flat');
  });

  it('lastObservedBefore returns the most recent observation older than 1 hour', () => {
    const observations = [
      obs(10000, 0, now),
      obs(12000, 1, now),
      obs(15000, 5, now),
    ];
    const r = analyze({ observations, now });
    expect(r.lastObservedBefore).not.toBeNull();
    expect(r.lastObservedBefore!.priceCents).toBe(12000);
  });
});
