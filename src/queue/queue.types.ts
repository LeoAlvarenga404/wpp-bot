import type { ScoredDeal } from '../deal-score/types';

export const SEND_DEAL_QUEUE = 'send-deal';

export interface SendDealJob {
  targetJid: string;
  /** Catalog key string (source:externalId) — also doubles as the BullMQ
   *  job id so duplicate enqueues for the same (deal, target) coalesce. */
  catalogKey: string;
  scored: ScoredDeal;
}
