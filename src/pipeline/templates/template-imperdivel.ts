// src/pipeline/templates/template-imperdivel.ts

import type { ScoredDeal } from '../../deal-score/types';

export const imperdivelTemplate = (
  sd: ScoredDeal,
  formatBRL: (n: number) => string,
  link: string,
  hook: string,
): string => {
  const d = sd.deal;
  const lines: string[] = [];
  lines.push('🚨 PROMOÇÃO IMPERDÍVEL');
  if (hook) lines.push(hook);
  lines.push('');
  lines.push(`📦 ${d.title}`);
  lines.push('');
  lines.push(`💰 *${formatBRL(d.price)}* (-${d.discountPercent}%)`);
  if (d.item?.hasInstallmentsNoInterest) {
    lines.push(`💳 ${pickInstallments(d.price, formatBRL)} sem juros`);
  }
  if (d.freeShipping) lines.push('🚚 Frete grátis');
  lines.push('');

  const historyLine = pickHistoryLine(sd);
  if (historyLine) lines.push(historyLine);

  const sellerLine = pickSellerLine(sd);
  if (sellerLine) lines.push(sellerLine);

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

function pickSellerLine(sd: ScoredDeal): string | null {
  const seller = sd.deal.seller;
  if (!seller) return null;
  const parts: string[] = [];
  if (seller.isOfficialStore) parts.push('Loja oficial');
  if (seller.powerSellerStatus) parts.push(`MercadoLíder ${capitalize(seller.powerSellerStatus)}`);
  if (typeof seller.ratingAverage === 'number') parts.push(`${seller.ratingAverage.toFixed(1)}★`);
  return parts.length > 0 ? `✅ ${parts.join(' · ')}` : null;
}

function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function pickInstallments(price: number, formatBRL: (n: number) => string): string {
  if (price >= 600) return `12x ${formatBRL(price / 12)}`;
  if (price >= 200) return `10x ${formatBRL(price / 10)}`;
  return `até 6x`;
}
