import { PriceObservation } from '../types';
const NOW = new Date('2026-05-13T12:00:00Z').getTime();
const DAY = 24 * 60 * 60 * 1000;
// 100 → 150 → 120: baseline R$100 between 30..14d, peak R$150 between 14..1d
export const historyClassicTrap: PriceObservation[] = [
  ...Array.from({ length: 10 }, (_, i) => ({ priceCents: 10000, at: new Date(NOW - (15 + i) * DAY).toISOString() })),
  ...Array.from({ length: 10 }, (_, i) => ({ priceCents: 15000, at: new Date(NOW - (1 + i) * DAY).toISOString() })),
];
