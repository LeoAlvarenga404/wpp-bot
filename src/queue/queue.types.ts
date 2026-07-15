import type { ScoredDeal } from '../deal-score/types';

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
  scored: ScoredDeal;
}
