import type { Coupon, CouponView } from './coupon.types';

/** Final price in cents after the coupon, clamped to >= 0. */
export function applyCoupon(priceCents: number, coupon: Coupon): number {
  let discount: number;
  if (coupon.type === 'PERCENT') {
    discount = Math.round((priceCents * coupon.value) / 100);
    if (coupon.capCents != null) discount = Math.min(discount, coupon.capCents);
  } else {
    discount = coupon.value;
  }
  return Math.max(0, priceCents - discount);
}

function discountLabel(coupon: Coupon): string {
  if (coupon.type === 'PERCENT') return `-${coupon.value}%`;
  // FIXED: value is cents -> whole reais label, no decimals for round values.
  const reais = coupon.value / 100;
  const n = Number.isInteger(reais)
    ? String(reais)
    : reais.toFixed(2).replace('.', ',');
  return `-R$ ${n}`;
}

/**
 * Per-deal gate. Returns the coupon line to render, or null to render nothing.
 * - inactive / expired / firstBuy / perUser -> null
 * - scope matched + priceCents >= minCents -> PRICE (with finalCents)
 * - below minimum -> CTA (code-only)
 */
export function computeCouponView(
  coupon: Coupon,
  priceCents: number,
  now: Date,
): CouponView | null {
  if (!coupon.active) return null;
  if (coupon.validUntil.getTime() <= now.getTime()) return null;
  if (coupon.firstBuy || coupon.perUser) return null;

  const min = coupon.minCents ?? 0;
  const label = discountLabel(coupon);
  const validUntil = coupon.validUntil.toISOString();

  if (priceCents >= min) {
    return {
      code: coupon.code,
      mode: 'PRICE',
      finalCents: applyCoupon(priceCents, coupon),
      discountLabel: label,
      minCents: coupon.minCents,
      validUntil,
    };
  }
  return {
    code: coupon.code,
    mode: 'CTA',
    finalCents: null,
    discountLabel: label,
    minCents: coupon.minCents,
    validUntil,
  };
}
