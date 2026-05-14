import { Inject, Injectable } from '@nestjs/common';
import { AFFILIATE_LINK_PORT } from '../affiliate/affiliate-link.port';
import type { AffiliateLinkPort } from '../affiliate/affiliate-link.port';
import { HEADLINE_GENERATOR } from '../headline/headline.port';
import type { HeadlineGenerator } from '../headline/headline.port';
import { DealItem } from '../mercado-livre/types';
import type { ScoredDeal } from '../deal-score/types';
import { CaptionTemplate, templates, templatesByLevel } from './templates';

@Injectable()
export class FormatterService {
  private readonly templates: CaptionTemplate[];

  constructor(
    @Inject(AFFILIATE_LINK_PORT)
    private readonly affiliate: AffiliateLinkPort,
    @Inject(HEADLINE_GENERATOR)
    private readonly headline: HeadlineGenerator,
  ) {
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
    const [link, hook] = await Promise.all([
      this.affiliate.resolve(item.permalink),
      this.headline.generate(item),
    ]);
    const shipping = item.freeShipping ? '🚚 Frete grátis' : '';

    if (this.templates.length === 0) {
      throw new Error('No caption templates available');
    }
    const template = this.templates[0];
    const caption = template(
      item,
      (n: number) => this.formatBRL(n),
      link,
      shipping,
      lowestPriceBadge,
      hook,
    );

    const imageUrl = this.toHiResImage(item.thumbnail || '');

    return { caption, imageUrl };
  }

  async formatScored(scored: ScoredDeal): Promise<{ caption: string; imageUrl: string }> {
    const [link, hook] = await Promise.all([
      this.affiliate.resolve(scored.deal.permalink),
      this.headline.generate(scored.deal),
    ]);
    const formatBRL = (n: number) => this.formatBRL(n);

    const tmpl =
      scored.level === 'super' ? templatesByLevel.super :
      scored.level === 'top'   ? templatesByLevel.top :
      templatesByLevel.good;
    // 'rejected' level never reaches dispatch; fall back to good template defensively.

    const caption = tmpl(scored, formatBRL, link, hook);
    const imageUrl = this.toHiResImage(scored.deal.thumbnail || '');
    return { caption, imageUrl };
  }

  private toHiResImage(original: string): string {
    if (!original) return original;
    const transformed = original
      .replace('-I.jpg', '-F.jpg')
      .replace('-O.jpg', '-F.jpg')
      .replace('http://', 'https://');
    if (!transformed || transformed === original) {
      const httpsOnly = original.replace('http://', 'https://');
      return httpsOnly || original;
    }
    return transformed;
  }
}
