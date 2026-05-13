import type { DealItem } from '../mercado-livre/types';

export const HEADLINE_GENERATOR = Symbol('HEADLINE_GENERATOR');

export interface HeadlineGenerator {
  generate(item: DealItem): Promise<string>;
}
