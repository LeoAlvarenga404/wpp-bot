import { DealItem } from '../../mercado-livre/types';

export const dealTemplate = (
  d: DealItem,
  formatBRL: (n: number) => string,
  link: string,
  shipping: string,
  badge: string | undefined,
  disclaimer: string,
): string => {
  const lines = [
    `⚡ *OFERTA* — ${d.title}`,
    '',
    badge ? badge : '',
    `Agora: ${formatBRL(d.price)}`,
    `Antes: ~${formatBRL(d.originalPrice)}~`,
    `Economia: ${d.discountPercent}%`,
    shipping,
    '',
    `🔗 ${link}`,
    '',
    `_${disclaimer}_`,
  ].filter(Boolean);

  return lines.join('\n');
};
