// src/pipeline/templates/template-ofertas.ts
//
// Single flat caption format cloning the reference deals group ("Ofertas na
// Tela"). Store hashtag, uppercased hook, ML FULL badge, then a structured
// price block — struck "De" (full price), green "Por" (promo price, tagged PIX
// or à-vista) with the % off, and the no-interest card installment line — then
// coupon code only. No affiliate disclaimer.

import type { ScoredDeal, DealLevel } from '../../deal-score/types';
import type { SourceId } from '../../sources/source.port';
import type { PriceView } from '../../pricing/price-view';
import type { CouponView } from '../../coupon/coupon.types';

export interface OfertasTemplateInput {
  sd: ScoredDeal;
  link: string;
  hook: string;
  priceView?: PriceView;
  couponView?: CouponView;
}

export function sourceHashtag(source: SourceId): string {
  return source === 'shopee' ? '#Shopee' : '#MercadoLivre';
}

export function linkLabel(source: SourceId): string {
  return source === 'shopee' ? 'Link do produto:' : 'Link:';
}

function hookEmoji(level: DealLevel): string {
  if (level === 'super') return '🚨';
  if (level === 'top') return '🔥🔥';
  return '🔥';
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
function priceBlock(sd: ScoredDeal, priceView?: PriceView): string[] {
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

  return lines;
}

export function ofertasTemplate(input: OfertasTemplateInput): string {
  const { sd, link, hook, priceView, couponView } = input;
  const raw = sd.deal.raw;
  const source = sd.deal.key.source;
  const lines: string[] = [];

  lines.push(sourceHashtag(source));
  if (hook) {
    lines.push(`${hook.toLocaleUpperCase('pt-BR')} ${hookEmoji(sd.level)}`);
  }
  lines.push('');

  lines.push(`➡️ ${raw.title}`);
  if (sd.deal.signals.isFull) lines.push('⚡ FULL do Mercado Livre');
  lines.push('');

  lines.push(...priceBlock(sd, priceView));
  lines.push('');

  if (couponView) lines.push(`🎟️ Use o cupom: ${couponView.code}`);
  lines.push(`🛒 ${linkLabel(source)} ${link}`);

  return lines.join('\n');
}
