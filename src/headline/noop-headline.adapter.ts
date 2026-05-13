import { Injectable } from '@nestjs/common';
import type { DealItem } from '../mercado-livre/types';
import { HeadlineGenerator } from './headline.port';
import { STATIC_HOOKS } from './static-hook-pool';

@Injectable()
export class NoopHeadlineAdapter implements HeadlineGenerator {
  private readonly lastByCatalog = new Map<string, number>();

  generate(item: DealItem): Promise<string> {
    if (STATIC_HOOKS.length === 0) {
      return Promise.resolve('OFERTA! 🔥');
    }
    let idx = Math.floor(Math.random() * STATIC_HOOKS.length);
    const last = this.lastByCatalog.get(item.catalogId);
    if (last !== undefined && idx === last) {
      idx = (idx + 1) % STATIC_HOOKS.length;
    }
    this.lastByCatalog.set(item.catalogId, idx);
    return Promise.resolve(STATIC_HOOKS[idx]);
  }
}
