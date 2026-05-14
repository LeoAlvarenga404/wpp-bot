
import { of, throwError } from 'rxjs';
import { EnrichmentService } from './enrichment.service';
import { DealItem } from '../mercado-livre/types';

function fakeHttp(handlers: Record<string, any>) {
  return {
    get: jest.fn((url: string) => {
      for (const key of Object.keys(handlers)) {
        if (url.includes(key)) return handlers[key];
      }
      return throwError(() => new Error('no handler for ' + url));
    }),
  } as any;
}

const fakeAuth = {
  getAccessToken: jest.fn(async () => 'TOKEN'),
} as any;

const dealA: DealItem = {
  catalogId: 'MLB1',
  itemId: 'MLBI1',
  title: 'Foo',
  thumbnail: '',
  price: 99.9,
  originalPrice: 199.9,
  sellerId: 7,
  freeShipping: true,
  permalink: 'https://x',
  discountPercent: 50,
};

const fakeCache = (() => {
  const map = new Map<number, any>();
  return {
    get: (id: number) => map.get(id) ?? null,
    set: async (info: any) => { map.set(info.sellerId, info); },
    _map: map,
  };
})();

describe('EnrichmentService', () => {
  beforeEach(() => {
    fakeCache._map.clear();
    jest.clearAllMocks();
  });

  it('uses cache when present', async () => {
    fakeCache._map.set(7, {
      sellerId: 7,
      nickname: 'X',
      powerSellerStatus: 'platinum',
      reputationLevel: '5_green',
      isOfficialStore: false,
      officialStoreId: null,
      ratingAverage: 4.8,
      fetchedAt: new Date().toISOString(),
    });
    const http = fakeHttp({
      '/items/MLBI1': of({ data: { id: 'MLBI1', sold_quantity: 10, condition: 'new', installments: { rate: 0 } } }),
    });
    const svc = new EnrichmentService(http, fakeAuth, fakeCache as any);
    const out = await svc.enrich(dealA);
    expect(out.seller?.sellerId).toBe(7);
    expect(http.get).toHaveBeenCalledTimes(1); // only items, not users
  });

  it('fetches /users/{id} on cache miss', async () => {
    const http = fakeHttp({
      '/users/7': of({ data: {
        id: 7,
        nickname: 'SHOP',
        seller_reputation: { level_id: '5_green', power_seller_status: 'platinum', metrics: { rating: 4.7 } },
        eshop: { eshop_id: 9001 },
      } }),
      '/items/MLBI1': of({ data: { id: 'MLBI1', sold_quantity: 100, condition: 'new', installments: { rate: 0 } } }),
    });
    const svc = new EnrichmentService(http, fakeAuth, fakeCache as any);
    const out = await svc.enrich(dealA);
    expect(out.seller?.reputationLevel).toBe('5_green');
    expect(out.seller?.isOfficialStore).toBe(true);
    expect(out.item?.soldQuantity).toBe(100);
  });

  it('returns deal with seller=null on 404 for /users', async () => {
    const notFound = throwError(() => ({ response: { status: 404 } }));
    const http = fakeHttp({
      '/users/7': notFound,
      '/items/MLBI1': of({ data: { id: 'MLBI1', sold_quantity: 5, condition: 'new', installments: null } }),
    });
    const svc = new EnrichmentService(http, fakeAuth, fakeCache as any);
    const out = await svc.enrich(dealA);
    expect(out.seller).toBeNull();
    expect(out.item?.soldQuantity).toBe(5);
  });

  it('propagates 5xx from /users so caller can decide', async () => {
    const err500 = throwError(() => ({ response: { status: 503 } }));
    const http = fakeHttp({
      '/users/7': err500,
      '/items/MLBI1': of({ data: { id: 'MLBI1' } }),
    });
    const svc = new EnrichmentService(http, fakeAuth, fakeCache as any);
    await expect(svc.enrich(dealA)).rejects.toBeTruthy();
  });

  it('enrichMany processes deals in batches', async () => {
    const http = fakeHttp({
      '/users/': of({ data: { id: 7, nickname: 'X', seller_reputation: { level_id: '4_light_green' } } }),
      '/items/': of({ data: { sold_quantity: 1, condition: 'new' } }),
    });
    const svc = new EnrichmentService(http, fakeAuth, fakeCache as any);
    const out = await svc.enrichMany([
      { ...dealA, catalogId: 'A' },
      { ...dealA, catalogId: 'B' },
      { ...dealA, catalogId: 'C' },
    ]);
    expect(out).toHaveLength(3);
  });
});
