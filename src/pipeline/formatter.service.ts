import { Inject, Injectable, Optional } from '@nestjs/common';
import { AFFILIATE_LINK_PORT } from '../affiliate/affiliate-link.port';
import type { AffiliateLinkPort } from '../affiliate/affiliate-link.port';
import { HEADLINE_GENERATOR } from '../headline/headline.port';
import type { HeadlineGenerator } from '../headline/headline.port';
import { RedirectService } from '../redirect/redirect.service';
import { DealItem } from '../mercado-livre/types';
import type { ScoredDeal } from '../deal-score/types';
import type { CopyVariant } from '../shared/variant';
import type { TrustBadge } from '../queue/queue.types';
import type { RawDeal } from '../sources/source.port';
import type { PriceView } from '../pricing/price-view';
import type { CouponView } from '../coupon/coupon.types';
import { toHiResImage } from '../shared/hi-res-image';
import { templates } from './templates';
import type { CaptionTemplate } from './templates';
import { ofertasTemplate } from './templates/template-ofertas';

@Injectable()
export class FormatterService {
  private readonly templates: CaptionTemplate[];

  constructor(
    @Inject(AFFILIATE_LINK_PORT)
    private readonly affiliate: AffiliateLinkPort,
    @Inject(HEADLINE_GENERATOR)
    private readonly headline: HeadlineGenerator,
    // Provided by the @Global RedirectModule; optional so unit tests (and any
    // context without the module) keep working — absent = links untouched.
    @Optional()
    private readonly redirect?: RedirectService,
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
    const [affiliateLink, hook] = await Promise.all([
      this.affiliate.resolve(item.permalink),
      this.headline.generate(item),
    ]);
    const link = await this.wrapLink(affiliateLink, item.catalogId);
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

    const imageUrl = toHiResImage(item.thumbnail || '');

    return { caption: `${caption}\n\n${this.disclaimerLine()}`, imageUrl };
  }

  async formatScored(
    scored: ScoredDeal,
    _variant: CopyVariant = 'A',
    _trustBadge?: TrustBadge,
    priceView?: PriceView,
    couponView?: CouponView,
  ): Promise<{ caption: string; imageUrl: string }> {
    const raw = scored.deal.raw;
    const link = await this.resolveLink(raw);
    const caption = ofertasTemplate({
      sd: scored,
      link,
      priceView,
      couponView,
    });
    const imageUrl = toHiResImage(raw.thumbnail || '');
    return { caption, imageUrl };
  }

  /**
   * One WA message bundling several approved deals. Header + one clone block
   * per deal (no disclaimer). Image comes from the first entry (gate returns
   * deals sorted by score desc).
   */
  async formatDigest(
    entries: Array<{
      scored: ScoredDeal;
      variant: CopyVariant;
      priceView?: PriceView;
      couponView?: CouponView;
    }>,
  ): Promise<{ caption: string; imageUrl: string }> {
    if (entries.length === 0) {
      throw new Error('formatDigest requires at least one deal');
    }
    const links = await Promise.all(
      entries.map((e) => this.resolveLink(e.scored.deal.raw)),
    );
    const blocks = entries.map((e, i) =>
      ofertasTemplate({
        sd: e.scored,
        link: links[i],
        priceView: e.priceView,
        couponView: e.couponView,
      }),
    );
    const header = `🔥 ${entries.length} ACHADOS NUM POST SÓ`;
    const caption = [header, '', blocks.join('\n\n➖➖➖\n\n')].join('\n');
    const imageUrl = toHiResImage(
      entries[0].scored.deal.raw.thumbnail || '',
    );
    return { caption, imageUrl };
  }

  /**
   * ML precisa do passo de afiliação (painel/planilha). Shopee (e futuras
   * fontes com link já comissionado no feed) usa o permalink como está.
   * Depois, o link (de qualquer fonte) passa pelo redirecionador de cliques
   * quando REDIRECT_BASE_URL está configurada (CTR tracking).
   */
  private async resolveLink(raw: RawDeal): Promise<string> {
    const link =
      raw.key.source === 'ml'
        ? await this.affiliate.resolve(raw.permalink)
        : raw.permalink;
    return this.wrapLink(link, `${raw.key.source}:${raw.key.externalId}`);
  }

  /**
   * CTR short link. No-op when RedirectService is absent or
   * REDIRECT_BASE_URL is empty (default) — captions stay unchanged.
   */
  private async wrapLink(link: string, dealKey: string): Promise<string> {
    if (!this.redirect) return link;
    return this.redirect.wrapIfEnabled(link, { dealKey });
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

}
