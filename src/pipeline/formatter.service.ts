import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AFFILIATE_LINK_PORT } from '../affiliate/affiliate-link.port';
import type { AffiliateLinkPort } from '../affiliate/affiliate-link.port';
import { DealItem } from '../mercado-livre/types';
import { CaptionTemplate, templates } from './templates';

const DEFAULT_DISCLAIMER =
  'Link de afiliado. Posso receber comissão sem custo extra pra você.';

@Injectable()
export class FormatterService {
  private readonly disclaimer: string;
  private readonly templates: CaptionTemplate[];
  private readonly lastTemplateByCatalog = new Map<string, number>();

  constructor(
    @Inject(AFFILIATE_LINK_PORT)
    private readonly affiliate: AffiliateLinkPort,
    private readonly config: ConfigService,
  ) {
    this.disclaimer = this.config.get<string>(
      'AFFILIATE_DISCLAIMER',
      DEFAULT_DISCLAIMER,
    );
    this.templates = templates;
  }

  formatBRL(value: number): string {
    return value.toLocaleString('pt-BR', {
      style: 'currency',
      currency: 'BRL',
      minimumFractionDigits: 2,
    });
  }

  async formatItem(
    item: DealItem,
    lowestPriceBadge?: string,
  ): Promise<{ caption: string; imageUrl: string }> {
    const link = await this.affiliate.resolve(item.permalink);
    const shipping = item.freeShipping ? '🚚 Frete grátis' : '';

    const template = this.pickTemplate(item.catalogId);
    const caption = template(
      item,
      (n: number) => this.formatBRL(n),
      link,
      shipping,
      lowestPriceBadge,
      this.disclaimer,
    );

    const imageUrl = this.toHiResImage(item.thumbnail || '');

    return { caption, imageUrl };
  }

  private pickTemplate(catalogId: string): CaptionTemplate {
    if (this.templates.length === 0) {
      throw new Error('No caption templates available');
    }
    if (this.templates.length === 1) {
      return this.templates[0];
    }

    const lastIdx = this.lastTemplateByCatalog.get(catalogId);
    let idx = Math.floor(Math.random() * this.templates.length);
    if (lastIdx !== undefined && idx === lastIdx) {
      idx = (idx + 1) % this.templates.length;
    }
    this.lastTemplateByCatalog.set(catalogId, idx);
    return this.templates[idx];
  }

  private toHiResImage(original: string): string {
    if (!original) return original;
    const transformed = original
      .replace('-I.jpg', '-F.jpg')
      .replace('-O.jpg', '-F.jpg')
      .replace('http://', 'https://');
    if (!transformed || transformed === original) {
      // Still upgrade scheme even if suffix didn't change
      const httpsOnly = original.replace('http://', 'https://');
      return httpsOnly || original;
    }
    return transformed;
  }
}
