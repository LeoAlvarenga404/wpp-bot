import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CurationService } from '../curation/curation.service';
import { DedupService } from '../dedup/dedup.service';
import { MercadoLivreService } from '../mercado-livre/ml.service';
import { DealItem } from '../mercado-livre/types';
import { WhatsappService } from '../whatsapp/wa.service';
import { FormatterService } from './formatter.service';

const DEFAULT_CATEGORIES = [
  'MLB1648', // Informatica
  'MLB1000', // Eletronicos
  'MLB1051', // Celulares
  'MLB5726', // Eletrodomesticos
  'MLB1276', // Esportes
  'MLB1246', // Beleza
  'MLB1144', // Games
  'MLB1430', // Calcados, Roupas
];

@Injectable()
export class PipelineService {
  private readonly logger = new Logger(PipelineService.name);

  constructor(
    private readonly ml: MercadoLivreService,
    private readonly wa: WhatsappService,
    private readonly formatter: FormatterService,
    private readonly config: ConfigService,
    private readonly dedup: DedupService,
    private readonly curation: CurationService,
  ) {}

  async runOnce(opts?: {
    category?: string;
    minDiscount?: number;
    max?: number;
  }) {
    const category =
      opts?.category ?? this.config.get<string>('ML_CATEGORY', 'MLB1648');
    const minDiscount =
      opts?.minDiscount ??
      Number(this.config.get<string>('ML_MIN_DISCOUNT', '25'));
    const max = opts?.max ?? 1;
    const targetJid = this.config.get<string>('WA_TARGET_JID', '');

    if (!targetJid) throw new Error('WA_TARGET_JID not set in .env');
    if (!this.wa.isReady())
      throw new Error('WhatsApp not ready — scan QR first');

    const deals = await this.ml.getDealsFromHighlights({
      category,
      minDiscount,
      max,
    });
    this.logger.log(`Found ${deals.length} deal(s) for ${category}`);

    const windowDays = Number(
      this.config.get<string>('DEDUP_WINDOW_DAYS', '7'),
    );

    let sent = 0;
    let skipped = 0;
    let curationSkipped = 0;

    for (const deal of deals) {
      if (await this.dedup.wasRecentlyPosted(deal.catalogId, windowDays)) {
        this.logger.log(
          `dedup skip ${deal.catalogId} (posted within ${windowDays}d)`,
        );
        skipped++;
        continue;
      }

      // Convert reais (float) → cents (integer) and record observation FIRST so
      // we always capture price history even when we end up skipping the post.
      const priceCents = Math.round(deal.price * 100);
      await this.curation.record(deal.catalogId, priceCents);

      if (this.curation.isFakeDiscount(deal.catalogId, priceCents)) {
        this.logger.log(
          `curation skip fake-discount ${deal.catalogId} (price ${priceCents}c)`,
        );
        curationSkipped++;
        continue;
      }

      const badge = this.curation.getLowestPriceBadge(
        deal.catalogId,
        priceCents,
      );

      const { caption, imageUrl } = await this.formatter.formatItem(
        deal,
        badge ?? undefined,
      );
      try {
        if (imageUrl) {
          await this.wa.sendImage(targetJid, imageUrl, caption);
        } else {
          await this.wa.sendText(targetJid, caption);
        }
        await this.dedup.markPosted(deal.catalogId);
        sent++;
      } catch (err) {
        this.logger.error(`send failed for ${deal.itemId}`, err as Error);
      }
      await this.sleep(2000);
    }

    return { sent, skipped, curationSkipped, category, minDiscount };
  }

  async preview(opts?: {
    categories?: string[];
    minDiscount?: number;
    perCategory?: number;
  }) {
    const categories = opts?.categories?.length
      ? opts.categories
      : DEFAULT_CATEGORIES;
    const minDiscount =
      opts?.minDiscount ??
      Number(this.config.get<string>('ML_MIN_DISCOUNT', '25'));
    const perCategory = opts?.perCategory ?? 5;

    const results: Record<
      string,
      {
        permalink: string;
        title: string;
        price: number;
        discountPercent: number;
      }[]
    > = {};
    const flatUrls: string[] = [];

    for (const cat of categories) {
      const deals = await this.ml.getDealsFromHighlights({
        category: cat,
        minDiscount,
        max: perCategory,
      });
      results[cat] = deals.map((d: DealItem) => ({
        permalink: d.permalink,
        title: d.title,
        price: d.price,
        discountPercent: d.discountPercent,
      }));
      for (const d of deals) flatUrls.push(d.permalink);
    }

    return {
      minDiscount,
      perCategory,
      totalUrls: flatUrls.length,
      pasteIntoAffiliatePanel: flatUrls.join('\n'),
      byCategory: results,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
