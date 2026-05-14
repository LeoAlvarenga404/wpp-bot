// src/deal-score/price-analytics.ts

import {
  PriceAnalytics,
  PriceAnalyticsInput,
  PriceObservation,
  PriceRaiseOptions,
  PriceRaiseSignal,
} from './types';

const DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_EXCLUSION_MS = 60 * 60 * 1000; // 1 hour: treat as "today's update"

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  }
  return sorted[mid];
}

function min(values: number[]): number | null {
  if (values.length === 0) return null;
  let m = values[0];
  for (let i = 1; i < values.length; i++) if (values[i] < m) m = values[i];
  return m;
}

function pricesWithin(
  obs: PriceObservation[],
  nowMs: number,
  windowDays: number,
): number[] {
  const cutoff = nowMs - windowDays * DAY_MS;
  const out: number[] = [];
  for (const o of obs) {
    const t = Date.parse(o.at);
    if (Number.isNaN(t)) continue;
    if (t >= cutoff) out.push(o.priceCents);
  }
  return out;
}

function pricesInRange(
  obs: PriceObservation[],
  nowMs: number,
  olderDays: number,
  newerDays: number,
): number[] {
  // observations within (now - olderDays) ≤ t < (now - newerDays)
  const older = nowMs - olderDays * DAY_MS;
  const newer = nowMs - newerDays * DAY_MS;
  const out: number[] = [];
  for (const o of obs) {
    const t = Date.parse(o.at);
    if (Number.isNaN(t)) continue;
    if (t >= older && t < newer) out.push(o.priceCents);
  }
  return out;
}

export function analyze(input: PriceAnalyticsInput): PriceAnalytics {
  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  const obs = input.observations;

  const w7 = pricesWithin(obs, nowMs, 7);
  const w14 = pricesWithin(obs, nowMs, 14);
  const w30 = pricesWithin(obs, nowMs, 30);

  const distinctDates = new Set<string>();
  for (const o of obs) {
    const t = Date.parse(o.at);
    if (Number.isNaN(t)) continue;
    distinctDates.add(new Date(t).toISOString().slice(0, 10));
  }

  // lastObservedBefore = most recent observation older than RECENT_EXCLUSION_MS
  let lastBefore: PriceObservation | null = null;
  let lastBeforeT = -Infinity;
  for (const o of obs) {
    const t = Date.parse(o.at);
    if (Number.isNaN(t)) continue;
    if (nowMs - t < RECENT_EXCLUSION_MS) continue;
    if (t > lastBeforeT) {
      lastBeforeT = t;
      lastBefore = o;
    }
  }

  const m7 = median(w7);
  const m14 = median(w14);
  const m30 = median(w30);

  // For trend: compare recent 7-day median against older 7–14 day median.
  // Fall back to full 14-day median when no observations exist in the 7–14 day range.
  const w7to14 = pricesInRange(obs, nowMs, 14, 7);
  const m7to14 = median(w7to14);
  const trendBaseline = m7to14 ?? m14;

  let trend: PriceAnalytics['trend'] = 'unknown';
  if (m7 != null && trendBaseline != null) {
    if (m7 < trendBaseline * 0.95) trend = 'falling';
    else if (m7 > trendBaseline * 1.05) trend = 'rising';
    else trend = 'flat';
  }

  return {
    median7d: m7,
    median14d: m14,
    median30d: m30,
    min7d: min(w7),
    min14d: min(w14),
    min30d: min(w30),
    distinctDays: distinctDates.size,
    lastObservedBefore: lastBefore,
    trend,
  };
}

export function detectPriceRaiseBeforeDiscount(
  input: PriceAnalyticsInput,
  currentPriceCents: number,
  opts: PriceRaiseOptions,
): PriceRaiseSignal {
  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  const obs = input.observations;

  // peak in last `peakWindowDays`, excluding very-recent (within 1 hour)
  let peak: number | null = null;
  const peakCutoff = nowMs - opts.peakWindowDays * DAY_MS;
  for (const o of obs) {
    const t = Date.parse(o.at);
    if (Number.isNaN(t)) continue;
    if (t < peakCutoff) continue;
    if (nowMs - t < RECENT_EXCLUSION_MS) continue;
    if (peak === null || o.priceCents > peak) peak = o.priceCents;
  }

  // baseline = min in range [now - baselineWindowDays, now - peakWindowDays)
  const baselineRange = pricesInRange(
    obs,
    nowMs,
    opts.baselineWindowDays,
    opts.peakWindowDays,
  );
  const baseline = min(baselineRange);

  if (peak === null || baseline === null) {
    return {
      suspicious: false,
      peakInWindowCents: peak,
      baselinePreWindowCents: baseline,
      currentVsBaselineRatio: null,
    };
  }

  const peakRatio = peak / baseline;
  const currentRatio = currentPriceCents / baseline;
  const suspicious =
    peakRatio >= opts.peakRatio && currentRatio >= opts.currentBaselineRatio;

  return {
    suspicious,
    peakInWindowCents: peak,
    baselinePreWindowCents: baseline,
    currentVsBaselineRatio: currentRatio,
    reason: suspicious
      ? `peak ${peak}c is ${Math.round(peakRatio * 100)}% of baseline ${baseline}c; current ${currentPriceCents}c is ${Math.round(currentRatio * 100)}% of baseline`
      : undefined,
  };
}
