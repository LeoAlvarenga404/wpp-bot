import { PriceObservation } from '../types';
const NOW = new Date('2026-05-13T12:00:00Z').getTime();
const DAY = 24 * 60 * 60 * 1000;
export const history30dStable: PriceObservation[] = Array.from({ length: 30 }, (_, i) => ({
  priceCents: 10000,
  at: new Date(NOW - (i + 1) * DAY).toISOString(),
}));
