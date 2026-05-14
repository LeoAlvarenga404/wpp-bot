import { ConfigService } from '@nestjs/config';
import { DealScoreService } from './deal-score.service';
import { enrichedDealOfficialStore } from './__fixtures__/enriched-deal-official-store';
import { enrichedDealUnknownSeller } from './__fixtures__/enriched-deal-unknown-seller';
import { historyClassicTrap } from './__fixtures__/history-classic-trap';
import { history30dStable } from './__fixtures__/history-30d-stable';
import { historyEmpty } from './__fixtures__/history-empty';
import { analyze } from './price-analytics';

function makeService(overrides: Record<string, string> = {}): DealScoreService {
  const cfg = {
    get: (k: string, def?: string) => overrides[k] ?? def,
  } as unknown as ConfigService;
  return new DealScoreService(cfg);
}

describe('DealScoreService', () => {
  const now = new Date('2026-05-13T12:00:00Z');

  it('rejects when score < DEAL_SCORE_MIN', () => {
    const svc = makeService({ DEAL_SCORE_MIN: '75' });
    const analytics = analyze({ observations: historyEmpty, now });
    const r = svc.compute(enrichedDealUnknownSeller, analytics);
    expect(r.level).toBe('rejected');
  });

  it('caps score at 100', () => {
    const svc = makeService();
    const analytics = analyze({ observations: history30dStable, now });
    const deal = { ...enrichedDealOfficialStore, price: 30, discountPercent: 70 };
    const r = svc.compute(deal, analytics);
    expect(r.score).toBeLessThanOrEqual(100);
    expect(r.score).toBeGreaterThanOrEqual(0);
  });

  it('floors score at 0 when penalties exceed positives', () => {
    const svc = makeService({ DEAL_SCORE_MIN: '0' });
    const analytics = analyze({ observations: historyEmpty, now });
    const r = svc.compute(enrichedDealUnknownSeller, analytics);
    expect(r.score).toBeGreaterThanOrEqual(0);
  });

  it('clamps level to top when history insufficient even with high score', () => {
    const svc = makeService({
      DEAL_SCORE_MIN: '0',
      DEAL_SCORE_SUPER: '0',
      CURATION_MIN_HISTORY_DAYS: '7',
    });
    const analytics = analyze({ observations: historyEmpty, now });
    const deal = { ...enrichedDealOfficialStore };
    const r = svc.compute(deal, analytics);
    expect(['good', 'top', 'rejected']).toContain(r.level);
    expect(r.level).not.toBe('super');
  });

  it('labels super when score >= DEAL_SCORE_SUPER AND history sufficient', () => {
    const svc = makeService({
      DEAL_SCORE_MIN: '0',
      DEAL_SCORE_TOP: '90',
      DEAL_SCORE_SUPER: '40',
      CURATION_MIN_HISTORY_DAYS: '0',
    });
    const analytics = analyze({ observations: history30dStable, now });
    const deal = { ...enrichedDealOfficialStore, price: 50, discountPercent: 50 };
    const r = svc.compute(deal, analytics);
    expect(r.score).toBeGreaterThanOrEqual(40);
    expect(r.level).toBe('super');
  });

  it('penalises priceRaiseBeforeDiscount classic trap', () => {
    const svc = makeService({ DEAL_SCORE_MIN: '0' });
    const analytics = analyze({ observations: historyClassicTrap, now });
    const deal = { ...enrichedDealOfficialStore, price: 120 };
    const r = svc.computeWithObservations(deal, analytics, historyClassicTrap, { now });
    expect(r.penalties.some((p) => p.code === 'price_raise_before_discount')).toBe(true);
  });

  it('reasons are sorted by weight desc and contain only positives', () => {
    const svc = makeService({
      DEAL_SCORE_MIN: '0',
      CURATION_MIN_HISTORY_DAYS: '0',
    });
    const analytics = analyze({ observations: history30dStable, now });
    const r = svc.compute(enrichedDealOfficialStore, analytics);
    for (let i = 1; i < r.reasons.length; i++) {
      expect(r.reasons[i].weight).toBeLessThanOrEqual(r.reasons[i - 1].weight);
    }
    expect(r.reasons.every((x) => x.weight >= 0)).toBe(true);
    expect(r.penalties.every((x) => x.weight <= 0)).toBe(true);
  });

  it('factors sum matches rawScore', () => {
    const svc = makeService({ DEAL_SCORE_MIN: '0' });
    const analytics = analyze({ observations: history30dStable, now });
    const r = svc.compute(enrichedDealOfficialStore, analytics);
    const sum = Object.values(r.factors).reduce((a, b) => a + b, 0);
    expect(sum).toBe(r.rawScore);
  });
});
