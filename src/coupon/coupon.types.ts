export type CouponScope = 'SELLER' | 'PRODUCT';
export type CouponType = 'PERCENT' | 'FIXED' | 'FINAL';

/** A manually-registered ML coupon (ml-coupons-v1). Money in integer cents. */
export interface Coupon {
  id: string;
  code: string;
  scope: CouponScope;
  /** SELLER -> ML seller id; PRODUCT -> MLB item id (deal.key.externalId). */
  targetId: string;
  type: CouponType;
  /** PERCENT: whole percent (1-100). FIXED: discount in cents. */
  value: number;
  /** PERCENT only: max discount in cents ("10% até R$50"). null = uncapped. */
  capCents: number | null;
  /** Minimum purchase in cents for the coupon to apply. null = no minimum. */
  minCents: number | null;
  firstBuy: boolean;
  perUser: boolean;
  validUntil: Date;
  active: boolean;
  affiliateSafe: boolean;
}

/** What the formatter needs to render one coupon line. */
export interface CouponView {
  code: string;
  /** PRICE = show final price; CTA = code-only (below minimum). */
  mode: 'PRICE' | 'CTA';
  /** Final price in cents when mode === 'PRICE'; null for CTA. */
  finalCents: number | null;
  /** e.g. "-15%" or "-R$ 20". */
  discountLabel: string;
  /** Minimum in cents for CTA "acima de R$X"; null when no minimum. */
  minCents: number | null;
  /** ISO date for "válido até". */
  validUntil: string;
  /**
   * Discount params carried through to the renderer so it can recompute the
   * final over the *displayed* promo price — the coupon stacks on the PIX
   * price shown in the caption, not the à-vista price used at resolution.
   * FINAL is an absolute informed price and is never recomputed.
   */
  type: CouponType;
  /** PERCENT: whole percent. FIXED: cents off. FINAL: absolute final cents. */
  value: number;
  /** PERCENT only: max discount in cents. null = uncapped. */
  capCents: number | null;
}
