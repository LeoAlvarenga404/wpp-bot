// src/pipeline/pipeline.service.spec.ts

// Mock ESM-only packages and heavy services to keep unit tests runnable under ts-jest CJS mode.
jest.mock('@whiskeysockets/baileys', () => ({}));
jest.mock('@hapi/boom', () => ({ Boom: class Boom {} }));
jest.mock('@sentry/node', () => ({ captureException: jest.fn(), init: jest.fn() }));
jest.mock('../whatsapp/wa.service');

import { ConfigService } from '@nestjs/config';
import { PipelineService } from './pipeline.service';
import { DealItem } from '../mercado-livre/types';
import { EnrichedDeal } from '../enrichment/types';
import { ScoredDeal } from '../deal-score/types';

const baseDeal: DealItem = {
  catalogId: 'MLB1',
  itemId: 'MLBI1',
  title: 'T',
  thumbnail: '',
  price: 100,
  originalPrice: 200,
  sellerId: 7,
  freeShipping: true,
  permalink: 'https://x',
  discountPercent: 50,
};

function makeDeps() {
  const calls: string[] = [];
  const ml = {
    getDealsFromHighlights: jest.fn(async () => [baseDeal]),
  } as any;
  const dedup = {
    wasRecentlyPosted: jest.fn(async () => {
      calls.push('dedup.wasRecentlyPosted');
      return false;
    }),
    markPosted: jest.fn(async () => { calls.push('dedup.markPosted'); }),
  } as any;
  const curation = {
    record: jest.fn(async () => { calls.push('curation.record'); }),
    isFakeDiscount: jest.fn(() => {
      calls.push('curation.isFakeDiscount');
      return false;
    }),
    getLowestPriceBadge: jest.fn(() => null),
    getObservations: jest.fn(() => []),
    getAnalytics: jest.fn(() => ({
      median7d: null, median14d: null, median30d: null,
      min7d: null, min14d: null, min30d: null,
      distinctDays: 0, lastObservedBefore: null, trend: 'unknown' as const,
    })),
  } as any;
  const enrichment = {
    enrichMany: jest.fn(async (deals: DealItem[]) =>
      deals.map((d) => ({ ...d, seller: null, item: null }) as EnrichedDeal),
    ),
  } as any;
  const dealScore = {
    compute: jest.fn(),
    computeWithObservations: jest.fn(
      (deal: EnrichedDeal): ScoredDeal => ({
        deal,
        score: 80,
        rawScore: 80,
        level: 'good',
        reasons: [],
        penalties: [],
        factors: {},
      }),
    ),
  } as any;
  const wa = {
    isReady: () => true,
    sendImage: jest.fn(async () => {}),
    sendText: jest.fn(async () => {}),
  } as any;
  const formatter = {
    formatItem: jest.fn(async () => ({ caption: 'cap', imageUrl: 'img' })),
    formatScored: jest.fn(async () => ({ caption: 'cap', imageUrl: 'img' })),
  } as any;
  const config = {
    get: (k: string, def?: string) => {
      const map: Record<string, string> = {
        WA_TARGET_JID: '5511999999999@s.whatsapp.net',
        ML_CATEGORY: 'MLB1648',
        ML_MIN_DISCOUNT: '25',
        DEDUP_WINDOW_DAYS: '7',
        MAX_DEALS_PER_RUN: '3',
        DEAL_SCORE_MIN: '75',
        DEAL_ENRICH_TOP_N: '10',
      };
      return map[k] ?? def;
    },
  } as unknown as ConfigService;

  const svc = new PipelineService(ml, wa, formatter, config, dedup, curation, enrichment, dealScore);
  return { svc, calls, ml, dedup, curation, enrichment, dealScore, wa, formatter };
}

describe('PipelineService order', () => {
  it('records BEFORE dedup AND BEFORE isFakeDiscount', async () => {
    const { svc, calls } = makeDeps();
    await svc.collectScored('MLB1648', { minDiscount: 25, enrichTopN: 10 });
    const recordIdx = calls.indexOf('curation.record');
    const dedupIdx = calls.indexOf('dedup.wasRecentlyPosted');
    const fakeIdx = calls.indexOf('curation.isFakeDiscount');
    expect(recordIdx).toBeGreaterThanOrEqual(0);
    expect(recordIdx).toBeLessThan(dedupIdx);
    expect(recordIdx).toBeLessThan(fakeIdx);
  });

  it('still records when dedup skips the deal', async () => {
    const { svc, dedup, curation } = makeDeps();
    dedup.wasRecentlyPosted.mockResolvedValue(true);
    await svc.collectScored('MLB1648', { minDiscount: 25, enrichTopN: 10 });
    expect(curation.record).toHaveBeenCalledTimes(1);
  });

  it('still records when isFakeDiscount blocks the deal', async () => {
    const { svc, curation } = makeDeps();
    curation.isFakeDiscount.mockReturnValue(true);
    await svc.collectScored('MLB1648', { minDiscount: 25, enrichTopN: 10 });
    expect(curation.record).toHaveBeenCalledTimes(1);
  });

  it('filters deals below DEAL_SCORE_MIN', async () => {
    const { svc, dealScore } = makeDeps();
    dealScore.computeWithObservations.mockReturnValue({
      deal: { ...baseDeal, seller: null, item: null } as any,
      score: 40,
      rawScore: 40,
      level: 'rejected',
      reasons: [],
      penalties: [],
      factors: {},
    });
    const out = await svc.collectScored('MLB1648', { minDiscount: 25, enrichTopN: 10 });
    expect(out).toHaveLength(0);
  });
});

describe('dispatchScored', () => {
  it('sorts desc and respects max', async () => {
    const { svc, wa } = makeDeps();
    const make = (score: number, id: string): ScoredDeal => ({
      deal: { ...baseDeal, catalogId: id, seller: null, item: null } as any,
      score, rawScore: score, level: 'good', reasons: [], penalties: [], factors: {},
    });
    const r = await svc.dispatchScored([make(70, 'A'), make(90, 'B'), make(85, 'C')], 2);
    expect(r.sent).toBe(2);
    // first send was the top-scored ('B')
    expect(wa.sendImage.mock.calls[0]).toBeTruthy();
  });

  it('marks posted only after successful send', async () => {
    const { svc, dedup, wa } = makeDeps();
    wa.sendImage.mockRejectedValueOnce(new Error('boom'));
    const r = await svc.dispatchScored([{
      deal: { ...baseDeal, seller: null, item: null } as any,
      score: 90, rawScore: 90, level: 'top', reasons: [], penalties: [], factors: {},
    }], 1);
    expect(r.sent).toBe(0);
    expect(dedup.markPosted).not.toHaveBeenCalled();
  });
});
