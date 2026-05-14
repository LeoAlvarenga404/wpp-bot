// src/enrichment/types.ts — stub, fleshed out in Milestone B

import { DealItem } from '../mercado-livre/types';

export interface SellerInfo {
  sellerId: number;
  nickname: string | null;
  powerSellerStatus: string | null; // platinum, gold, silver, etc.
  reputationLevel: string | null; // '5_green', '4_light_green', etc.
  isOfficialStore: boolean;
  officialStoreId: number | null;
  ratingAverage: number | null;
  fetchedAt: string; // ISO
}

export interface ItemDetails {
  itemId: string;
  soldQuantity: number | null;
  condition: 'new' | 'used' | 'refurbished' | 'not_specified';
  hasInstallmentsNoInterest: boolean;
}

export interface EnrichedDeal extends DealItem {
  seller: SellerInfo | null;
  item: ItemDetails | null;
}
