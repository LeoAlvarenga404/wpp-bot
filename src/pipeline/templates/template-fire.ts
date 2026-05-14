import { DealItem } from '../../mercado-livre/types';
import { CaptionTemplate } from './template-fire-types';

export const fireTemplate: CaptionTemplate = (
  d,
  formatBRL,
  link,
  shipping,
  badge,
  hook,
) => {
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
