export interface HighlightsResponse {
  query_data: { highlight_type: string; criteria: string; id: string };
  content: { id: string; position: number; type: string }[];
}

export interface MLProduct {
  id: string;
  name: string;
  domain_id: string;
  status: string;
  pictures: { url: string; suggested_for_picker?: boolean }[];
  buy_box_winner?: { item_id?: string; price?: number };
}

export interface MLProductItem {
  item_id: string;
  site_id: string;
  seller_id: number;
  price: number;
  original_price: number | null;
  category_id: string;
  currency_id: string;
  condition: string;
  listing_type_id: string;
  official_store_id?: number | null;
  shipping: {
    free_shipping: boolean;
    logistic_type: string;
    mode: string;
    tags: string[];
  };
}

export interface MLProductItemsResponse {
  paging: { total: number; offset: number; limit: number };
  results: MLProductItem[];
}

export interface DealItem {
  catalogId: string;
  itemId: string;
  title: string;
  thumbnail: string;
  price: number;
  originalPrice: number;
  sellerId: number;
  freeShipping: boolean;
  permalink: string;
  discountPercent: number;
  /** ML fulfillment (logistic_type === 'fulfillment'). */
  isFull?: boolean;
}
