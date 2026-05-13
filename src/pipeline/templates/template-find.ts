import { DealItem } from '../../mercado-livre/types';

export const findTemplate = (
  d: DealItem,
  formatBRL: (n: number) => string,
  link: string,
  shipping: string,
  badge: string | undefined,
  disclaimer: string,
): string => {
  const lines = [
    `✨ Achado: *${d.title}*`,
    '',
    badge ? badge : '',
    `🏷️ De ${formatBRL(d.originalPrice)} por ${formatBRL(d.price)} (${d.discountPercent}% off)`,
    shipping,
    '',
    `🛒 ${link}`,
    '',
    `_${disclaimer}_`,
  ].filter(Boolean);

  return lines.join('\n');
};
