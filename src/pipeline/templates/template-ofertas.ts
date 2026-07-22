// src/pipeline/templates/template-ofertas.ts
//
// Single flat caption format cloning the reference deals group style:
// uppercased title, ML FULL badge, then a structured price block — struck
// "De" (full price), green "Por" (promo price, tagged PIX or à-vista) with
// the % off, the no-interest card installment line and the coupon line
// (final "com cupom" price when it beats the promo) — then the link.
// No hashtag, no AI headline, no affiliate disclaimer.

import type { ScoredDeal } from '../../deal-score/types';
import type { SourceId } from '../../sources/source.port';
import type { PriceView } from '../../pricing/price-view';
import type { CouponView } from '../../coupon/coupon.types';
import { couponFinalOver, reaisLabel } from '../../coupon/coupon-math';

export interface OfertasTemplateInput {
  sd: ScoredDeal;
  link: string;
  priceView?: PriceView;
  couponView?: CouponView;
}

export function linkLabel(source: SourceId): string {
  return source === 'shopee' ? 'Link do produto:' : 'Link:';
}

/** Integer reais, pt-BR thousands, cents floored: 484699 -> "R$ 4.846". */
function priceIntBRL(cents: number): string {
  return `R$ ${Math.floor(cents / 100).toLocaleString('pt-BR')}`;
}

/**
 * Structured price block. Reads the scraped {@link PriceView} when present,
 * falling back to the API price on the deal. Produces up to three lines:
 *   ❌ De ~R$ 200~            (full price, struck — only when it beats the promo)
 *   ✅ Por R$ 87 no PIX  (-56%)  (promo price, tagged PIX or à vista, with % off)
 *   💳 ou 10x de R$ 9 sem juros  (no-interest card installments, when scraped)
 */
function priceBlock(
  sd: ScoredDeal,
  priceView?: PriceView,
): { lines: string[]; promoCents: number } {
  const raw = sd.deal.raw;
  const lines: string[] = [];

  const pix = priceView?.pixPriceCents ?? null;
  const avista = priceView?.priceCents ?? raw.priceCents;
  const promoCents = pix ?? avista;
  const promoLabel = pix != null ? 'no PIX' : 'à vista';

  const originalCents =
    priceView?.originalPriceCents ?? raw.originalPriceCents ?? null;

  let discount = priceView?.discountPercent ?? raw.discountPercent ?? null;
  if (
    (discount == null || discount <= 0) &&
    originalCents != null &&
    originalCents > promoCents
  ) {
    discount = Math.round((1 - promoCents / originalCents) * 100);
  }

  if (originalCents != null && originalCents > promoCents) {
    lines.push(`❌ De ~${priceIntBRL(originalCents)}~`);
  }

  const off = discount && discount > 0 ? `  (-${discount}%)` : '';
  lines.push(`✅ Por ${priceIntBRL(promoCents)} ${promoLabel}${off}`);

  const inst = priceView?.installments ?? null;
  if (inst && inst.count > 1) {
    const juros = inst.noInterest ? ' sem juros' : '';
    lines.push(
      `💳 ou ${inst.count}x de ${priceIntBRL(inst.amountCents)}${juros}`,
    );
  }

  return { lines, promoCents };
}

/**
 * Coupon line. The coupon stacks on the promo (PIX) price shown above, so the
 * "com cupom" final is recomputed against `promoCents` at render time —
 * PERCENT/FIXED subtract from it, FINAL is the curator's absolute price. The
 * price prints whenever it beats the promo; otherwise a code-only line.
 *   🎟️ Com o cupom SHOW10: R$ 79  (-10%)       (PERCENT over PIX)
 *   🎟️ Com o cupom SHOW10: R$ 706  (-R$ 80)    (FIXED / FINAL)
 *   🎟️ Cupom SHOW10 em compras acima de R$ 200 (CTA, below the minimum)
 *   🎟️ Use o cupom: SHOW10                     (fallback)
 */
function couponLine(view: CouponView, promoCents: number): string {
  if (view.mode === 'PRICE') {
    const final = couponFinalOver(promoCents, view);
    if (final < promoCents) {
      // PERCENT "-15%" / FIXED "-R$ 20" are base-independent; FINAL's implied
      // discount depends on the promo it beats, so recompute it.
      const off =
        view.type === 'FINAL'
          ? reaisLabel(promoCents - final)
          : view.discountLabel;
      return `🎟️ Com o cupom ${view.code}: ${priceIntBRL(final)}  (${off})`;
    }
    return `🎟️ Use o cupom: ${view.code}`;
  }
  if (view.mode === 'CTA' && view.minCents != null) {
    return `🎟️ Cupom ${view.code} em compras acima de ${priceIntBRL(view.minCents)}`;
  }
  return `🎟️ Use o cupom: ${view.code}`;
}

export function ofertasTemplate(input: OfertasTemplateInput): string {
  const { sd, link, priceView, couponView } = input;
  const raw = sd.deal.raw;
  const source = sd.deal.key.source;
  const lines: string[] = [];

  lines.push(`➡️ ${raw.title.toLocaleUpperCase('pt-BR')}`);
  if (sd.deal.signals.isFull) lines.push('⚡ FULL do Mercado Livre');
  lines.push('');

  const price = priceBlock(sd, priceView);
  lines.push(...price.lines);
  if (couponView) lines.push(couponLine(couponView, price.promoCents));
  lines.push('');

  lines.push(`🛒 ${linkLabel(source)} ${link}`);

  return lines.join('\n');
}
