// src/pipeline/templates/template-fire-types.ts

import { DealItem } from '../../mercado-livre/types';

export type CaptionTemplate = (
  d: DealItem,
  formatBRL: (n: number) => string,
  link: string,
  shipping: string,
  badge: string | undefined,
  hook: string,
) => string;
