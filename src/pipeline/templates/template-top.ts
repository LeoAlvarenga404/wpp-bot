// src/pipeline/templates/template-top.ts

import type { ScoredDeal } from '../../deal-score/types';

export const topTemplate = (
  sd: ScoredDeal,
  formatBRL: (n: number) => string,
  link: string,
  hook: string,
): string => {
  const raw = sd.deal.raw;
  const price = raw.priceCents / 100;
  const lines: string[] = [];
  lines.push('🔥 PROMOÇÃO TOP');
  if (hook) lines.push(hook);
  lines.push('');
  lines.push(`📦 ${raw.title}`);
  lines.push(`💰 *${formatBRL(price)}* (-${raw.discountPercent}%)`);
  const extras: string[] = [];
  if (sd.deal.signals.installmentsNoInterest)
    extras.push(`${pickInstallments(price)} sem juros`);
  if (sd.deal.signals.freeShipping) extras.push('🚚 frete grátis');
  if (extras.length) lines.push(extras.join(' · '));
  lines.push('');
  const historyLine = pickHistoryLine(sd);
  if (historyLine) lines.push(historyLine);
  lines.push('');
  lines.push(`🛒 ${link}`);
  return lines.join('\n');
};

function pickHistoryLine(sd: ScoredDeal): string | null {
  const hit = sd.reasons.find((r) =>
    [
      'lowest_price_30d',
      'lowest_price_14d',
      'lowest_price_7d',
      'below_median_30d',
    ].includes(r.code),
  );
  return hit ? `📉 ${hit.message}` : null;
}

function pickInstallments(price: number): string {
  if (price >= 600) return `12x`;
  if (price >= 200) return `10x`;
  return `6x`;
}
