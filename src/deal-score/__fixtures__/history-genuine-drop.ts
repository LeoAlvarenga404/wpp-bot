import { PriceObservation } from '../types';
const NOW = new Date('2026-05-13T12:00:00Z').getTime();
const DAY = 24 * 60 * 60 * 1000;
// stable R$100 baseline, no spike, current price will be R$80
export const historyGenuineDrop: PriceObservation[] = Array.from({ length: 25 }, (_, i) => ({
  priceCents: 10000,
  at: new Date(NOW - (i + 1) * DAY).toISOString(),
}));
