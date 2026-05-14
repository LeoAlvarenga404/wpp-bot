import type { ScoredDeal } from '../../deal-score/types';
import { goodTemplate } from './template-good';
import { imperdivelTemplate } from './template-imperdivel';
import { topTemplate } from './template-top';

export type ScoredCaptionTemplate = (
  sd: ScoredDeal,
  formatBRL: (n: number) => string,
  link: string,
  hook: string,
) => string;

export const templatesByLevel: Record<'good' | 'top' | 'super', ScoredCaptionTemplate> = {
  good: goodTemplate,
  top: topTemplate,
  super: imperdivelTemplate,
};

// Legacy template kept for the existing fireTemplate consumer (formatItem)
export { fireTemplate } from './template-fire';
export { templates } from './legacy';
export type { CaptionTemplate } from './template-fire-types';
