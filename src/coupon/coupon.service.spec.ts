import { CouponService } from './coupon.service';
import type { Coupon } from './coupon.types';
import type { EnrichedDeal } from '../sources/source.port';

const now = new Date('2026-07-15T00:00:00Z');

const mlDeal = (sellerId: string | null, mlb: string): EnrichedDeal =>
  ({
    key: { source: 'ml', externalId: mlb },
    source: 'ml',
    raw: {} as any,
    seller: sellerId ? ({ externalSellerId: sellerId } as any) : null,
    condition: 'new',
    signals: {
      freeShipping: false,
      installmentsNoInterest: false,
      volumeTier: 'none',
      isVerifiedStore: false,
    },
    extras: {},
  }) as EnrichedDeal;

const coupon = (over: Partial<Coupon>): Coupon => ({
  id: 'c',
  code: 'X',
  scope: 'SELLER',
  targetId: 's1',
  type: 'FIXED',
  value: 1000,
  capCents: null,
  minCents: null,
  firstBuy: false,
  perUser: false,
  validUntil: new Date('2999-01-01'),
  active: true,
  affiliateSafe: true,
  ...over,
});

function svc(matches: Coupon[]): CouponService {
  const repo = { findMatching: jest.fn().mockResolvedValue(matches) } as any;
  return new CouponService(repo);
}

describe('CouponService.resolveForDeal', () => {
  it('skips non-ML deals without hitting the repo', async () => {
    const repo = { findMatching: jest.fn() } as any;
    const s = new CouponService(repo);
    const deal = {
      ...mlDeal('s1', 'MLB1'),
      key: { source: 'shopee', externalId: '1' },
      source: 'shopee',
    } as EnrichedDeal;
    expect(await s.resolveForDeal(deal, 10000, now)).toBeNull();
    expect(repo.findMatching).not.toHaveBeenCalled();
  });

  it('returns PRICE view for a matching seller coupon', async () => {
    const v = await svc([coupon({ type: 'FIXED', value: 2000 })]).resolveForDeal(
      mlDeal('s1', 'MLB1'),
      10000,
      now,
    );
    expect(v).toMatchObject({ mode: 'PRICE', finalCents: 8000 });
  });

  it('PRODUCT scope wins over SELLER scope', async () => {
    const v = await svc([
      coupon({
        scope: 'SELLER',
        targetId: 's1',
        type: 'FIXED',
        value: 1000,
        code: 'SELL',
      }),
      coupon({
        scope: 'PRODUCT',
        targetId: 'MLB1',
        type: 'FIXED',
        value: 500,
        code: 'PROD',
      }),
    ]).resolveForDeal(mlDeal('s1', 'MLB1'), 10000, now);
    expect(v?.code).toBe('PROD');
  });

  it('among same scope, best (lowest final) wins', async () => {
    const v = await svc([
      coupon({ code: 'A', type: 'FIXED', value: 1000 }),
      coupon({ code: 'B', type: 'FIXED', value: 3000 }),
    ]).resolveForDeal(mlDeal('s1', 'MLB1'), 10000, now);
    expect(v?.code).toBe('B'); // 7000 < 9000
  });

  it('returns null when all matches gate out', async () => {
    const v = await svc([coupon({ firstBuy: true })]).resolveForDeal(
      mlDeal('s1', 'MLB1'),
      10000,
      now,
    );
    expect(v).toBeNull();
  });
});
