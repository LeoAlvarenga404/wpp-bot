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
import type { PriceView } from '../pricing/price-view';
import type { CouponView } from '../coupon/coupon.types';
import { templates } from './templates';
import type { CaptionTemplate } from './templates';
import { ofertasTemplate } from './templates/template-ofertas';

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
    _variant: CopyVariant = 'A',
    _trustBadge?: TrustBadge,
    priceView?: PriceView,
    couponView?: CouponView,
  ): Promise<{ caption: string; imageUrl: string }> {
    const raw = scored.deal.raw;
    const headlineItem = scoredDealToHeadlineItem(scored);
    const [link, hook] = await Promise.all([
      this.resolveLink(raw),
      this.headline.generate(headlineItem),
    ]);
    const caption = ofertasTemplate({
      sd: scored,
      link,
      hook,
      priceView,
      couponView,
    });
    const imageUrl = this.toHiResImage(raw.thumbnail || '');
    return { caption, imageUrl };
  }

  /**
   * Insert the Pix price and no-interest installments lines right under the
   * price line of any template (matched by the "(-N%)" discount tag). Keeps
   * templates untouched. No-op when priceView is absent (API-price fallback).
   */
  private injectPriceExtras(body: string, priceView?: PriceView): string {
    const extras = this.priceExtraLines(priceView);
    if (extras.length === 0) return body;
    const lines = body.split('\n');
    let idx = lines.findIndex((l) => /\(-\d+%\)/.test(l));
    if (idx === -1) idx = lines.findIndex((l) => /R\$/.test(l));
    if (idx === -1) {
      // No price line found — append after the title-ish first block.
      return [body, ...extras].join('\n');
    }
    lines.splice(idx + 1, 0, ...extras);
    return lines.join('\n');
  }

  private priceExtraLines(priceView?: PriceView): string[] {
    if (!priceView) return [];
    const out: string[] = [];
    if (
      priceView.pixPriceCents != null &&
      priceView.pixPriceCents < priceView.priceCents
    ) {
      out.push(`💠 ${this.formatBRL(priceView.pixPriceCents / 100)} no Pix`);
    }
    const inst = priceView.installments;
    if (inst && inst.noInterest) {
      out.push(
        `💳 ou ${inst.count}x de ${this.formatBRL(inst.amountCents / 100)} sem juros`,
      );
    }
    return out;
  }

  /** One coupon line for the caption, or null (ml-coupons-v1). */
  private couponLine(cv?: CouponView): string | null {
    if (!cv) return null;
    const until = this.formatUntil(cv.validUntil);
    if (cv.mode === 'PRICE' && cv.finalCents != null) {
      return `🎟️ Com cupom *${cv.code}*: ${this.formatBRL(cv.finalCents / 100)} (válido até ${until})`;
    }
    // CTA (below minimum) — no price claim.
    const min =
      cv.minCents != null
        ? ` (acima de ${this.formatBRL(cv.minCents / 100)})`
        : '';
    return `🎟️ Cupom *${cv.code}* ${cv.discountLabel}${min} — válido até ${until}`;
  }

  /** Insert the coupon line right under the price block (after Pix/installments). */
  private appendCouponLine(body: string, line: string): string {
    const lines = body.split('\n');
    let idx = lines.findIndex((l) => /no Pix|sem juros/.test(l));
    if (idx === -1) idx = lines.findIndex((l) => /\(-\d+%\)/.test(l));
    if (idx === -1) idx = lines.findIndex((l) => /R\$/.test(l));
    if (idx === -1) return [body, line].join('\n');
    lines.splice(idx + 1, 0, line);
    return lines.join('\n');
  }

  private formatUntil(iso: string): string {
    const d = new Date(iso);
    return d.toLocaleDateString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      timeZone: process.env.TZ ?? 'America/Sao_Paulo',
    });
  }

  /**
   * One WA message bundling several approved deals. Header + one compact
   * block per deal + single disclaimer. Image comes from the first entry
   * (gate returns deals sorted by score desc).
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
    const [links, hooks] = await Promise.all([
      Promise.all(entries.map((e) => this.resolveLink(e.scored.deal.raw))),
      Promise.all(
        entries.map((e) =>
          this.headline.generate(scoredDealToHeadlineItem(e.scored)),
        ),
      ),
    ]);
    const blocks = entries.map((e, i) =>
      ofertasTemplate({
        sd: e.scored,
        link: links[i],
        hook: hooks[i],
        priceView: e.priceView,
        couponView: e.couponView,
      }),
    );
    const header = `🔥 ${entries.length} ACHADOS NUM POST SÓ`;
    const caption = [header, '', blocks.join('\n\n➖➖➖\n\n')].join('\n');
    const imageUrl = this.toHiResImage(
      entries[0].scored.deal.raw.thumbnail || '',
    );
    return { caption, imageUrl };
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
