// src/deal-score/types.ts

import type { EnrichedDeal } from '../sources/source.port';
import type { CuratorEdits } from '../shared/curator-edits';

export interface PriceObservation {
  priceCents: number;
  at: string; // ISO timestamp
}

export interface PriceAnalytics {
  median7d: number | null;
  median14d: number | null;
  median30d: number | null;
  min7d: number | null;
  min14d: number | null;
  min30d: number | null;
  distinctDays: number;
  lastObservedBefore: PriceObservation | null;
  trend: 'falling' | 'rising' | 'flat' | 'unknown';
}

export interface PriceRaiseSignal {
  suspicious: boolean;
  peakInWindowCents: number | null;
  baselinePreWindowCents: number | null;
  currentVsBaselineRatio: number | null;
  reason?: string;
}

export interface PriceAnalyticsInput {
  observations: PriceObservation[];
  now?: Date;
}

export type DealLevel = 'rejected' | 'good' | 'top' | 'super';

export interface ScoreReason {
  code: string;
  weight: number;
  message: string;
}

export interface ScoredDeal {
  deal: EnrichedDeal;
  score: number;
  rawScore: number;
  level: DealLevel;
  reasons: ScoreReason[];
  penalties: ScoreReason[];
  factors: Record<string, number>;
  /**
   * Present only on deals approved through the curation panel with light
   * edits (headline / final price / coupon). Rides the BullMQ job JSON so the
   * pipeline and the send worker can honor the curator's values (skip the
   * price scrape, override the coupon). Absent = the deal flows exactly as
   * before the approval queue existed.
   */
  curatorEdits?: CuratorEdits;
}

export interface PriceRaiseOptions {
  peakWindowDays: number;
  baselineWindowDays: number;
  peakRatio: number;
  currentBaselineRatio: number;
}
