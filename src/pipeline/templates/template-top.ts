// src/pipeline/templates/template-top.ts

import type { ScoredDeal } from '../../deal-score/types';

export const topTemplate = (
  sd: ScoredDeal,
  formatBRL: (n: number) => string,
  link: string,
  hook: string,
): string => {
  const d = sd.deal;
  const lines: string[] = [];
  lines.push('🔥 PROMOÇÃO TOP');
  if (hook) lines.push(hook);
  lines.push('');
  lines.push(`📦 ${d.title}`);
  lines.push(`💰 *${formatBRL(d.price)}* (-${d.discountPercent}%)`);
  const extras: string[] = [];
  if (d.item?.hasInstallmentsNoInterest) extras.push(`${pickInstallments(d.price)} sem juros`);
  if (d.freeShipping) extras.push('🚚 frete grátis');
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
    ['lowest_price_30d', 'lowest_price_14d', 'lowest_price_7d', 'below_median_30d'].includes(r.code),
  );
  return hit ? `📉 ${hit.message}` : null;
}

function pickInstallments(price: number): string {
  if (price >= 600) return `12x`;
  if (price >= 200) return `10x`;
  return `6x`;
}
