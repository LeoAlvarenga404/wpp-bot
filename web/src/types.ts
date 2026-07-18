// Mirror of the API payload from GET /approval/pending
// (PendingSummary in src/curation/approval-queue.service.ts).

export interface ScoreReason {
  code: string;
  weight: number;
  message: string;
}

export interface PendingDeal {
  id: string;
  catalogId: string;
  score: number;
  level: string;
  reasons: ScoreReason[];
  preview: {
    title: string;
    priceCents: number;
    originalPriceCents: number | null;
    discountPercent: number;
    thumbnail: string;
    permalink: string;
  };
  caption: string;
  imageUrl: string;
  /**
   * Days since this product was last published when inside the dedup window;
   * null otherwise. Non-null renders the "postado há N dias" warning and
   * approving requires the curator's confirmation (dedup override).
   */
  postedDaysAgo: number | null;
  createdAt: string;
  expiresAt: string;
}

/** Options accepted by POST /approval/:id/approve alongside edits. */
export interface ApproveOptions {
  edits?: CuratorEdits;
  /** "Enviar agora": jumps the send queue and pierces quiet hours. */
  urgent?: boolean;
  /** Confirms reposting a product published < 14 days ago. */
  dedupOverride?: boolean;
}

// Mirror of CuratorEditsDto (src/curation/dto/approve-deal.dto.ts) — the
// light-edit contract of the approval card: headline, final price, coupon.
export interface CuratorCouponEdit {
  code: string;
  /** Final price in cents after the coupon. Absent = code-only line. */
  finalCents?: number;
}

export interface CuratorEdits {
  headline?: string;
  priceCents?: number;
  coupon?: CuratorCouponEdit;
}

export interface HistoryItem {
  id: string;
  catalogId: string;
  targetJid: string;
  caption: string;
  variant: string | null;
  score: number | null;
  sentAt: string;
}

export interface CalibrationStats {
  periodDays: number;
  approved: number;
  rejected: number;
  expired: number;
  avgApprovedScore: number | null;
  avgRejectedScore: number | null;
}
