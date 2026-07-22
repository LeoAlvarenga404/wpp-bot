// Light edits a curator applies on the approval card before approving
// (curation panel, issue #6). Editable contract v1: headline, final price and
// coupon (code + final price). Image and template are NOT editable.

import type { CouponView } from '../coupon/coupon.types';

/** Curator coupon override: code plus optional "com cupom" final price. */
export interface CuratorCouponEdit {
  code: string;
  /** Final price in cents after the coupon. Absent = code-only CTA line. */
  finalCents?: number;
}

export interface CuratorEdits {
  /** Replaces the deal title (the template's first line). */
  headline?: string;
  /**
   * Curator-confirmed final price in cents. A human just read it off the
   * product page, so it beats the enqueue-time scrape AND the stale-price
   * re-scrape at send time.
   */
  priceCents?: number;
  /** Replaces whatever coupon the automatic resolver would pick. */
  coupon?: CuratorCouponEdit;
}

/** True when at least one editable field is present. */
export function hasCuratorEdits(edits?: CuratorEdits): edits is CuratorEdits {
  return (
    edits != null &&
    (edits.headline != null || edits.priceCents != null || edits.coupon != null)
  );
}

/** "-R$ 80" / "-R$ 79,90" — same shape coupon-math prints. */
function reaisLabel(cents: number): string {
  const reais = cents / 100;
  const n = Number.isInteger(reais)
    ? String(reais)
    : reais.toFixed(2).replace('.', ',');
  return `-R$ ${n}`;
}

/**
 * The send path never expiry-checks an edited coupon (the human decision IS
 * the validity), so this synthetic validUntil is informational only.
 */
export const EDITED_COUPON_TTL_MS = 24 * 3_600_000;

/**
 * CouponView for a curator-edited coupon, mirroring the FINAL-type semantics
 * of coupon-math: prints the "com cupom" price only when it beats the deal's
 * à-vista price (the same basis the automatic resolver uses), otherwise falls
 * back to the code-only line.
 */
export function couponViewFromCuratorEdit(
  edit: CuratorCouponEdit,
  promoCents: number,
  now: Date = new Date(),
): CouponView {
  const final = edit.finalCents ?? null;
  const beatsPromo = final != null && final < promoCents;
  return {
    code: edit.code,
    mode: beatsPromo ? 'PRICE' : 'CTA',
    finalCents: beatsPromo ? final : null,
    discountLabel: beatsPromo ? reaisLabel(promoCents - final) : '',
    minCents: null,
    validUntil: new Date(now.getTime() + EDITED_COUPON_TTL_MS).toISOString(),
    // A curator-entered final is an absolute informed price → FINAL semantics
    // (the renderer never recomputes it over the promo).
    type: 'FINAL',
    value: final ?? 0,
    capCents: null,
  };
}
