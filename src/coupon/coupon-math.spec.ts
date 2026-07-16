import { applyCoupon, computeCouponView } from './coupon-math';
import type { Coupon } from './coupon.types';

const base: Coupon = {
  id: 'c1',
  code: 'ABC',
  scope: 'SELLER',
  targetId: 's1',
  type: 'PERCENT',
  value: 10,
  capCents: null,
  minCents: null,
  firstBuy: false,
  perUser: false,
  validUntil: new Date('2999-01-01'),
  active: true,
  affiliateSafe: true,
};
const now = new Date('2026-07-15T00:00:00Z');

describe('applyCoupon', () => {
  it('percent off', () => {
    expect(applyCoupon(10000, { ...base, type: 'PERCENT', value: 10 })).toBe(
      9000,
    );
  });
  it('percent capped at capCents', () => {
    expect(
      applyCoupon(100000, {
        ...base,
        type: 'PERCENT',
        value: 10,
        capCents: 5000,
      }),
    ).toBe(95000);
  });
  it('fixed off in cents', () => {
    expect(applyCoupon(10000, { ...base, type: 'FIXED', value: 2000 })).toBe(
      8000,
    );
  });
  it('never goes below zero', () => {
    expect(applyCoupon(1000, { ...base, type: 'FIXED', value: 5000 })).toBe(0);
  });
});

describe('computeCouponView gate', () => {
  it('inactive -> null', () => {
    expect(
      computeCouponView({ ...base, active: false }, 10000, now),
    ).toBeNull();
  });
  it('expired -> null', () => {
    expect(
      computeCouponView(
        { ...base, validUntil: new Date('2020-01-01') },
        10000,
        now,
      ),
    ).toBeNull();
  });
  it('firstBuy -> null (never render)', () => {
    expect(
      computeCouponView({ ...base, firstBuy: true }, 10000, now),
    ).toBeNull();
  });
  it('perUser -> null (never render)', () => {
    expect(computeCouponView({ ...base, perUser: true }, 10000, now)).toBeNull();
  });
  it('applies -> PRICE with finalCents', () => {
    const v = computeCouponView(
      { ...base, type: 'FIXED', value: 2000 },
      10000,
      now,
    );
    expect(v).toMatchObject({ mode: 'PRICE', finalCents: 8000, code: 'ABC' });
  });
  it('below minimum -> CTA, no finalCents', () => {
    const v = computeCouponView({ ...base, minCents: 20000 }, 10000, now);
    expect(v).toMatchObject({ mode: 'CTA', finalCents: null, minCents: 20000 });
  });
  it('at/above minimum -> PRICE', () => {
    const v = computeCouponView(
      { ...base, minCents: 5000, type: 'FIXED', value: 1000 },
      10000,
      now,
    );
    expect(v).toMatchObject({ mode: 'PRICE', finalCents: 9000 });
  });
  it('discountLabel percent', () => {
    expect(
      computeCouponView({ ...base, type: 'PERCENT', value: 15 }, 10000, now)
        ?.discountLabel,
    ).toBe('-15%');
  });
  it('discountLabel fixed', () => {
    expect(
      computeCouponView({ ...base, type: 'FIXED', value: 2000 }, 10000, now)
        ?.discountLabel,
    ).toBe('-R$ 20');
  });
});
