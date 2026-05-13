import { DealItem } from '../../mercado-livre/types';

export const fireTemplate = (
  d: DealItem,
  formatBRL: (n: number) => string,
  link: string,
  shipping: string,
  badge: string | undefined,
  disclaimer: string,
): string => {
  const lines = [
    `🔥 *${d.title}*`,
    '',
    badge ? badge : '',
    `💰 ${formatBRL(d.price)} (de ${formatBRL(d.originalPrice)}) — ${d.discountPercent}% OFF`,
    shipping,
    '',
    `👉 ${link}`,
    '',
    `_${disclaimer}_`,
  ].filter(Boolean);

  return lines.join('\n');
};
