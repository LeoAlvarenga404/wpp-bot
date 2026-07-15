// src/pipeline/templates/template-good.ts

import type { ScoredDeal } from '../../deal-score/types';

export const goodTemplate = (
  sd: ScoredDeal,
  formatBRL: (n: number) => string,
  link: string,
  hook: string,
  trustLine?: string | null,
): string => {
  const raw = sd.deal.raw;
  const price = raw.priceCents / 100;
  const lines: string[] = [];
  lines.push('💸 Promoção');
  if (hook) lines.push(hook);
  lines.push('');
  lines.push(`📦 ${raw.title}`);
  lines.push(`💰 *${formatBRL(price)}* (-${raw.discountPercent}%)`);
  if (sd.deal.signals.freeShipping) lines.push('🚚 Frete grátis');
  if (trustLine) {
    lines.push('');
    lines.push(trustLine);
  }
  lines.push('');
  lines.push(`🛒 ${link}`);
  return lines.join('\n');
};
