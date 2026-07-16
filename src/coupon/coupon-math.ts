import type { Coupon, CouponView } from './coupon.types';

/** Final price in cents after the coupon, clamped to >= 0. */
export function applyCoupon(priceCents: number, coupon: Coupon): number {
  // FINAL: value IS the final price, never above the current price.
  if (coupon.type === 'FINAL') {
    return Math.max(0, Math.min(coupon.value, priceCents));
  }
  let discount: number;
  if (coupon.type === 'PERCENT') {
    discount = Math.round((priceCents * coupon.value) / 100);
    if (coupon.capCents != null) discount = Math.min(discount, coupon.capCents);
  } else {
    discount = coupon.value;
  }
  return Math.max(0, priceCents - discount);
}

function reaisLabel(cents: number): string {
  const reais = cents / 100;
  const n = Number.isInteger(reais)
    ? String(reais)
    : reais.toFixed(2).replace('.', ',');
  return `-R$ ${n}`;
}

function discountLabel(coupon: Coupon, priceCents: number): string {
  if (coupon.type === 'PERCENT') return `-${coupon.value}%`;
  // FINAL: value is the final price -> label is the implied discount.
  if (coupon.type === 'FINAL') return reaisLabel(priceCents - coupon.value);
  // FIXED: value is cents -> whole reais label, no decimals for round values.
  return reaisLabel(coupon.value);
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

  // FINAL: informed final price. Per-product only; suppressed once the
  // scraped price catches up (a "coupon" must never read as a markup).
  // minCents is ignored — the final price is already product-specific.
  if (coupon.type === 'FINAL') {
    if (coupon.scope !== 'PRODUCT') return null;
    if (priceCents <= coupon.value) return null;
    return {
      code: coupon.code,
      mode: 'PRICE',
      finalCents: coupon.value,
      discountLabel: discountLabel(coupon, priceCents),
      minCents: null,
      validUntil: coupon.validUntil.toISOString(),
    };
  }

  const min = coupon.minCents ?? 0;
  const label = discountLabel(coupon, priceCents);
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
