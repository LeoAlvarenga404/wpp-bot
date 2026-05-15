// src/deal-score/types.ts

import type { EnrichedDeal } from '../sources/source.port';

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
}

export interface PriceRaiseOptions {
  peakWindowDays: number;
  baselineWindowDays: number;
  peakRatio: number;
  currentBaselineRatio: number;
}
