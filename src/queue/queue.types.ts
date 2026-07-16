import type { ScoredDeal } from '../deal-score/types';
import type { PriceView } from '../pricing/price-view';
import type { CouponView } from '../coupon/coupon.types';

export const SEND_DEAL_QUEUE = 'send-deal';

/** Prova de proveniência do histórico de preço, calculada no enqueue. */
export interface TrustBadge {
  /** Retorno literal de CurationService.getLowestPriceBadge. */
  label: string;
  /** CurationService.historyDays(catalogId) no momento do enqueue. */
  monitoredDays: number;
}

export interface SendDealJob {
  targetJid: string;
  /** Publisher channel. Optional so jobs already sitting in Redis
   *  (pre-upgrade) still process as WhatsApp. */
  channel?: 'wa' | 'telegram';
  /** Catalog key string (source:externalId) — also doubles as the BullMQ
   *  job id so duplicate enqueues for the same (deal, target) coalesce. */
  catalogKey: string;
  /** Copy A/B variant. Optional: jobs enqueued pre-Fase-2 default to 'A'. */
  variant?: 'A' | 'B';
  /** Selo de preço monitorado. Optional: absent = render like today. */
  trustBadge?: TrustBadge;
  /** Scraped accurate price (Pix + installments). Absent = API-price fallback. */
  priceView?: PriceView;
  /** Matched ML coupon line (ml-coupons-v1). Absent = no coupon for this deal. */
  couponView?: CouponView;
  scored: ScoredDeal;
}

export interface DigestDealEntry {
  catalogKey: string;
  variant: 'A' | 'B';
  priceView?: PriceView;
  /** Matched ML coupon line (ml-coupons-v1). Absent = no coupon for this deal. */
  couponView?: CouponView;
  scored: ScoredDeal;
}

/** Several deals bundled into a single WA message (job name 'send-digest'). */
export interface SendDigestJob {
  targetJid: string;
  channel: 'wa';
  /** Groups the SentMessage audit rows of one digest. */
  digestId: string;
  deals: DigestDealEntry[];
}

export type SendJob = SendDealJob | SendDigestJob;
