import { DealItem } from '../../mercado-livre/types';
import { dealTemplate } from './template-deal';
import { findTemplate } from './template-find';
import { fireTemplate } from './template-fire';

export type CaptionTemplate = (
  d: DealItem,
  formatBRL: (n: number) => string,
  link: string,
  shipping: string,
  badge: string | undefined,
  disclaimer: string,
) => string;

export const templates: CaptionTemplate[] = [
  fireTemplate,
  findTemplate,
  dealTemplate,
];
