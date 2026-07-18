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
  createdAt: string;
  expiresAt: string;
}
