// src/pipeline/templates/template-good.ts

import type { ScoredDeal } from '../../deal-score/types';

export const goodTemplate = (
  sd: ScoredDeal,
  formatBRL: (n: number) => string,
  link: string,
  hook: string,
): string => {
  const d = sd.deal;
  const lines: string[] = [];
  lines.push('💸 Promoção');
  if (hook) lines.push(hook);
  lines.push('');
  lines.push(`📦 ${d.title}`);
  lines.push(`💰 *${formatBRL(d.price)}* (-${d.discountPercent}%)`);
  if (d.freeShipping) lines.push('🚚 Frete grátis');
  lines.push('');
  lines.push(`🛒 ${link}`);
  return lines.join('\n');
};
