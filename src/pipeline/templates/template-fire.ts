import { DealItem } from '../../mercado-livre/types';

export const fireTemplate = (
  d: DealItem,
  formatBRL: (n: number) => string,
  link: string,
  shipping: string,
  badge: string | undefined,
  hook: string,
): string => {
  const block: string[] = [
    `~${formatBRL(d.originalPrice)}~`,
    `✅ *${formatBRL(d.price)}* (-${d.discountPercent}% OFF)`,
  ];
  if (shipping) block.push(shipping);
  if (badge) block.push(badge);

  const out = [
    '#MercadoLivre',
    hook,
    '',
    `➡️ *${d.title}*`,
    '',
    ...block,
    '',
    `🛒 ${link}`,
  ];

  return out.join('\n');
};
