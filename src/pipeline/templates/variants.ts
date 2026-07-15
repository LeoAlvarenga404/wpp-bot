// Variante B do copy A/B (Fase 2): âncora "De/Por" explícita + CTA direto,
// contra a variante A (templates atuais, hook-first). Mesma assinatura.
import type { ScoredDeal } from '../../deal-score/types';
import type { ScoredCaptionTemplate } from './index';

function dePorBlock(
  sd: ScoredDeal,
  formatBRL: (n: number) => string,
): string[] {
  const raw = sd.deal.raw;
  const price = raw.priceCents / 100;
  const original =
    raw.originalPriceCents != null ? raw.originalPriceCents / 100 : null;
  const lines: string[] = [];
  if (original != null && original > price) {
    lines.push(`❌ De: ~${formatBRL(original)}~`);
    lines.push(`✅ Por: *${formatBRL(price)}* (-${raw.discountPercent}%)`);
  } else {
    lines.push(`✅ *${formatBRL(price)}* (-${raw.discountPercent}%)`);
  }
  return lines;
}

const goodB: ScoredCaptionTemplate = (sd, formatBRL, link, hook, trustLine) => {
  const lines: string[] = [];
  if (hook) lines.push(hook, '');
  lines.push(`📦 ${sd.deal.raw.title}`, '');
  lines.push(...dePorBlock(sd, formatBRL));
  if (sd.deal.signals.freeShipping) lines.push('🚚 Frete grátis');
  if (trustLine) lines.push('', trustLine);
  lines.push('', `👉 Garante aqui: ${link}`);
  return lines.join('\n');
};

const topB: ScoredCaptionTemplate = (sd, formatBRL, link, hook, trustLine) => {
  const lines: string[] = ['🔥 ACHADO DO DIA'];
  if (hook) lines.push(hook);
  lines.push('', `📦 ${sd.deal.raw.title}`, '');
  lines.push(...dePorBlock(sd, formatBRL));
  if (sd.deal.signals.freeShipping) lines.push('🚚 Frete grátis');
  if (sd.deal.signals.isVerifiedStore) lines.push('🏬 Loja oficial');
  if (trustLine) lines.push('', trustLine);
  lines.push('', `👉 Corre: ${link}`);
  return lines.join('\n');
};

const superB: ScoredCaptionTemplate = (sd, formatBRL, link, hook, trustLine) => {
  const lines: string[] = ['🚨 RARO DE VER 🚨'];
  if (hook) lines.push(hook);
  lines.push('', `📦 ${sd.deal.raw.title}`, '');
  lines.push(...dePorBlock(sd, formatBRL));
  if (sd.deal.signals.freeShipping) lines.push('🚚 Frete grátis');
  if (sd.deal.signals.isVerifiedStore) lines.push('🏬 Loja oficial');
  if (trustLine) lines.push('', trustLine);
  lines.push('', '⏳ Preço assim não dura.', `👉 ${link}`);
  return lines.join('\n');
};

export const variantBByLevel: Record<
  'good' | 'top' | 'super',
  ScoredCaptionTemplate
> = { good: goodB, top: topB, super: superB };
