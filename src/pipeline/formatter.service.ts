import { Inject, Injectable } from '@nestjs/common';
import { AFFILIATE_LINK_PORT } from '../affiliate/affiliate-link.port';
import type { AffiliateLinkPort } from '../affiliate/affiliate-link.port';
import { DealItem } from '../mercado-livre/types';

@Injectable()
export class FormatterService {
  constructor(
    @Inject(AFFILIATE_LINK_PORT)
    private readonly affiliate: AffiliateLinkPort,
  ) {}

  formatBRL(value: number): string {
    return value.toLocaleString('pt-BR', {
      style: 'currency',
      currency: 'BRL',
      minimumFractionDigits: 2,
    });
  }

  async formatItem(item: DealItem): Promise<{ caption: string; imageUrl: string }> {
    const link = await this.affiliate.resolve(item.permalink);
    const shipping = item.freeShipping ? '🚚 Frete grátis' : '';

    const lines = [
      `🔥 *${item.title}*`,
      '',
      `💰 ${this.formatBRL(item.price)} (de ${this.formatBRL(item.originalPrice)}) — ${item.discountPercent}% OFF`,
      shipping,
      '',
      `👉 ${link}`,
    ].filter(Boolean);

    const imageUrl = (item.thumbnail || '')
      .replace('-I.jpg', '-O.jpg')
      .replace('http://', 'https://');

    return { caption: lines.join('\n'), imageUrl };
  }
}
