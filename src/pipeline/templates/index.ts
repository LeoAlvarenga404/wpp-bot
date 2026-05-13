import { DealItem } from '../../mercado-livre/types';
import { fireTemplate } from './template-fire';

export type CaptionTemplate = (
  d: DealItem,
  formatBRL: (n: number) => string,
  link: string,
  shipping: string,
  badge: string | undefined,
  hook: string,
) => string;

export const templates: CaptionTemplate[] = [fireTemplate];
