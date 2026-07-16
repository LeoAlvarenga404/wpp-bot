// src/pipeline/templates/template-ofertas.ts
//
// Single flat caption format cloning the reference deals group ("Ofertas na
// Tela"). Store hashtag, uppercased hook, ML FULL badge, green PIX/à-vista
// price line, coupon code only. No affiliate disclaimer.

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
  if (sd.deal.signals.isFull) lines.push('⚡ FULL');
  lines.push('');

  const pix = priceView?.pixPriceCents ?? null;
  const displayCents = pix ?? priceView?.priceCents ?? raw.priceCents;
  const priceLabel = pix != null ? 'no PIX' : 'à vista';
  lines.push(`✅ ${priceIntBRL(displayCents)} ${priceLabel}`);

  if (couponView) lines.push(`🎟️ Use o cupom: ${couponView.code}`);
  lines.push(`🛒 ${linkLabel(source)} ${link}`);

  return lines.join('\n');
}
