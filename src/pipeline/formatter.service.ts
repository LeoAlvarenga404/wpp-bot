import { Inject, Injectable } from '@nestjs/common';
import { AFFILIATE_LINK_PORT } from '../affiliate/affiliate-link.port';
import type { AffiliateLinkPort } from '../affiliate/affiliate-link.port';
import { HEADLINE_GENERATOR } from '../headline/headline.port';
import type { HeadlineGenerator } from '../headline/headline.port';
import { DealItem } from '../mercado-livre/types';
import type { ScoredDeal } from '../deal-score/types';
import type { CopyVariant } from '../shared/variant';
import type { TrustBadge } from '../queue/queue.types';
import type { RawDeal } from '../sources/source.port';
import { CaptionTemplate, templates, templatesByLevel } from './templates';
import { variantBByLevel } from './templates/variants';

function scoredDealToHeadlineItem(scored: ScoredDeal): DealItem {
  const raw = scored.deal.raw;
  const externalId = scored.deal.key.externalId;
  return {
    catalogId: externalId,
    itemId: externalId,
    title: raw.title,
    thumbnail: raw.thumbnail,
    price: raw.priceCents / 100,
    originalPrice: (raw.originalPriceCents ?? raw.priceCents) / 100,
    sellerId: 0,
    freeShipping: scored.deal.signals.freeShipping,
    permalink: raw.permalink,
    discountPercent: raw.discountPercent,
  };
}

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

    return { caption: `${caption}\n\n${this.disclaimerLine()}`, imageUrl };
  }

  async formatScored(
    scored: ScoredDeal,
    variant: CopyVariant = 'A',
    trustBadge?: TrustBadge,
  ): Promise<{ caption: string; imageUrl: string }> {
    const raw = scored.deal.raw;
    const headlineItem = scoredDealToHeadlineItem(scored);
    const [link, hook] = await Promise.all([
      this.resolveLink(raw),
      this.headline.generate(headlineItem),
    ]);
    const formatBRL = (n: number) => this.formatBRL(n);

    // 'rejected' level never reaches dispatch; fall back to good template defensively.
    const level =
      scored.level === 'super' || scored.level === 'top'
        ? scored.level
        : 'good';
    const byLevel = variant === 'B' ? variantBByLevel : templatesByLevel;
    const tmpl = byLevel[level];

    const trustLine = trustBadge
      ? `${trustBadge.label} ✓ monitorado há ${trustBadge.monitoredDays} dias`
      : null;

    const caption = `${tmpl(scored, formatBRL, link, hook, trustLine)}\n\n${this.disclaimerLine()}`;
    const imageUrl = this.toHiResImage(raw.thumbnail || '');
    return { caption, imageUrl };
  }

  /**
   * One WA message bundling several approved deals. Header + one compact
   * block per deal + single disclaimer. Image comes from the first entry
   * (gate returns deals sorted by score desc).
   */
  async formatDigest(
    entries: Array<{ scored: ScoredDeal; variant: CopyVariant }>,
  ): Promise<{ caption: string; imageUrl: string }> {
    if (entries.length === 0) {
      throw new Error('formatDigest requires at least one deal');
    }
    const links = await Promise.all(
      entries.map((e) => this.resolveLink(e.scored.deal.raw)),
    );
    const blocks = entries.map((e, i) =>
      this.digestBlock(e.scored, e.variant, links[i]),
    );
    const header = `🔥 ${entries.length} ACHADOS NUM POST SÓ`;
    const caption = [
      header,
      '',
      blocks.join('\n\n➖➖➖\n\n'),
      '',
      this.disclaimerLine(),
    ].join('\n');
    const imageUrl = this.toHiResImage(
      entries[0].scored.deal.raw.thumbnail || '',
    );
    return { caption, imageUrl };
  }

  private digestBlock(
    sd: ScoredDeal,
    variant: CopyVariant,
    link: string,
  ): string {
    const raw = sd.deal.raw;
    const emoji =
      sd.level === 'super' ? '🚨' : sd.level === 'top' ? '🔥' : '✅';
    const price = raw.priceCents / 100;
    const original =
      raw.originalPriceCents != null ? raw.originalPriceCents / 100 : null;
    const lines = [`${emoji} *${raw.title}*`];
    if (variant === 'B' && original != null && original > price) {
      lines.push(`❌ De: ~${this.formatBRL(original)}~`);
      lines.push(
        `✅ Por: *${this.formatBRL(price)}* (-${raw.discountPercent}%)`,
      );
    } else {
      lines.push(`💰 *${this.formatBRL(price)}* (-${raw.discountPercent}%)`);
    }
    if (sd.deal.signals.freeShipping) lines.push('🚚 Frete grátis');
    lines.push(`👉 ${link}`);
    return lines.join('\n');
  }

  /**
   * ML precisa do passo de afiliação (painel/planilha). Shopee (e futuras
   * fontes com link já comissionado no feed) usa o permalink como está.
   */
  private resolveLink(raw: RawDeal): Promise<string> {
    if (raw.key.source === 'ml') return this.affiliate.resolve(raw.permalink);
    return Promise.resolve(raw.permalink);
  }

  /**
   * Mandatory on every caption (affiliate compliance): discloses the
   * affiliate link and timestamps the price so a later price change doesn't
   * read as a fake promo.
   */
  private disclaimerLine(now = new Date()): string {
    const hhmm = now.toLocaleTimeString('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: process.env.TZ ?? 'America/Sao_Paulo',
    });
    return `_🔗 Link de afiliado. Preço visto às ${hhmm} — sujeito a alteração._`;
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
