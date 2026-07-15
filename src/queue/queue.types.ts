import type { ScoredDeal } from '../deal-score/types';

export const SEND_DEAL_QUEUE = 'send-deal';

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
  scored: ScoredDeal;
}

export interface DigestDealEntry {
  catalogKey: string;
  variant: 'A' | 'B';
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
