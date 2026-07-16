// src/sources/source.port.ts

export type SourceId = 'ml' | 'shopee';

export interface ProductKey {
  source: SourceId;
  externalId: string;
}

export interface RawDeal {
  key: ProductKey;
  title: string;
  priceCents: number;
  originalPriceCents: number | null;
  discountPercent: number;
  thumbnail: string;
  permalink: string;
  feedId: string;
  condition?: 'new' | 'used' | 'refurbished';
}

export interface NormalizedSeller {
  externalSellerId: string;
  displayName: string | null;
  sellerTrust: 'high' | 'medium' | 'low' | 'unknown';
  isVerifiedStore: boolean;
  ratingAverage: number | null;
  fetchedAt: string;
}

export interface EnrichedDeal {
  key: ProductKey;
  source: SourceId;
  raw: RawDeal;
  seller: NormalizedSeller | null;
  condition: 'new' | 'used' | 'refurbished' | 'unknown';
  signals: {
    freeShipping: boolean;
    installmentsNoInterest: boolean;
    volumeTier: 'high' | 'mid' | 'low' | 'none';
    isVerifiedStore: boolean;
    /** ML fulfillment. Absent/false for Shopee and API-fallback deals. */
    isFull?: boolean;
  };
  extras: Record<string, unknown>;
}

export interface DealSourcePort {
  readonly id: SourceId;
  discover(): Promise<RawDeal[]>;
  discoverOne(): Promise<RawDeal[]>;
  enrichMany(raws: RawDeal[]): Promise<EnrichedDeal[]>;
  ping?(): Promise<{ ok: boolean; message?: string }>;
}

export const SOURCES_TOKEN = Symbol('SOURCES_TOKEN');

export function keyToString(k: ProductKey): string {
  return `${k.source}:${k.externalId}`;
}

export function parseKey(s: string): ProductKey | null {
  if (!s) return null;
  const idx = s.indexOf(':');
  if (idx <= 0) return null;
  const source = s.slice(0, idx);
  const externalId = s.slice(idx + 1);
  if (!externalId) return null;
  return { source: source as SourceId, externalId };
}
