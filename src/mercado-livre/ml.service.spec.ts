import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { of, throwError } from 'rxjs';
import { MercadoLivreAuthService } from './ml-auth.service';
import { MercadoLivreService } from './ml.service';

function makeConfig(map: Record<string, string> = {}): ConfigService {
  return {
    get: jest
      .fn()
      .mockImplementation((key: string, def?: any) => map[key] ?? def),
  } as unknown as ConfigService;
}

function makeAuth(token = 'TOKEN'): MercadoLivreAuthService {
  return {
    getAccessToken: jest.fn().mockResolvedValue(token),
  } as unknown as MercadoLivreAuthService;
}

function makeHttp(handler: (url: string) => any): HttpService {
  return {
    get: jest.fn().mockImplementation((url: string) => {
      const result = handler(url);
      if (result && typeof result.then === 'function') {
        // shouldn't happen — handler returns observable or throw
        return of({ data: result });
      }
      return result;
    }),
  } as unknown as HttpService;
}

describe('MercadoLivreService.getDealsFromHighlights', () => {
  it('filters by minDiscount, sorts by discount desc, skips inactive products', async () => {
    const http = makeHttp((url) => {
      if (url.includes('/highlights/')) {
        return of({
          data: {
            query_data: {
              highlight_type: 'cat',
              criteria: 'x',
              id: 'MLB1648',
            },
            content: [
              { id: 'CAT-A', position: 1, type: 'PRODUCT' },
              { id: 'CAT-B', position: 2, type: 'PRODUCT' },
              { id: 'CAT-C', position: 3, type: 'PRODUCT' },
              { id: 'CAT-D', position: 4, type: 'PRODUCT' }, // inactive
              { id: 'CAT-SKIP', position: 5, type: 'COLLECTION' }, // not PRODUCT
            ],
          },
        });
      }
      if (url.includes('/products/CAT-A/items')) {
        return of({
          data: {
            paging: { total: 1, offset: 0, limit: 10 },
            results: [
              {
                item_id: 'I-A',
                site_id: 'MLB',
                seller_id: 1,
                price: 50,
                original_price: 100, // 50% off
                category_id: 'X',
                currency_id: 'BRL',
                condition: 'new',
                listing_type_id: 'gold_special',
                shipping: {
                  free_shipping: true,
                  logistic_type: '',
                  mode: '',
                  tags: [],
                },
              },
            ],
          },
        });
      }
      if (url.includes('/products/CAT-A')) {
        return of({
          data: {
            id: 'CAT-A',
            name: 'Product A',
            domain_id: 'D',
            status: 'active',
            pictures: [{ url: 'https://x/a.jpg' }],
          },
        });
      }
      if (url.includes('/products/CAT-B/items')) {
        return of({
          data: {
            paging: { total: 1, offset: 0, limit: 10 },
            results: [
              {
                item_id: 'I-B',
                site_id: 'MLB',
                seller_id: 2,
                price: 80,
                original_price: 100, // 20% off
                category_id: 'X',
                currency_id: 'BRL',
                condition: 'new',
                listing_type_id: 'gold_special',
                shipping: {
                  free_shipping: false,
                  logistic_type: '',
                  mode: '',
                  tags: [],
                },
              },
            ],
          },
        });
      }
      if (url.includes('/products/CAT-B')) {
        return of({
          data: {
            id: 'CAT-B',
            name: 'Product B',
            domain_id: 'D',
            status: 'active',
            pictures: [{ url: 'https://x/b.jpg' }],
          },
        });
      }
      if (url.includes('/products/CAT-C/items')) {
        return of({
          data: {
            paging: { total: 1, offset: 0, limit: 10 },
            results: [
              {
                item_id: 'I-C',
                site_id: 'MLB',
                seller_id: 3,
                price: 95,
                original_price: 100, // 5% off — below minDiscount 10
                category_id: 'X',
                currency_id: 'BRL',
                condition: 'new',
                listing_type_id: 'gold_special',
                shipping: {
                  free_shipping: true,
                  logistic_type: '',
                  mode: '',
                  tags: [],
                },
              },
            ],
          },
        });
      }
      if (url.includes('/products/CAT-C')) {
        return of({
          data: {
            id: 'CAT-C',
            name: 'Product C',
            domain_id: 'D',
            status: 'active',
            pictures: [{ url: 'https://x/c.jpg' }],
          },
        });
      }
      if (url.includes('/products/CAT-D/items')) {
        return of({
          data: {
            paging: { total: 1, offset: 0, limit: 10 },
            results: [
              {
                item_id: 'I-D',
                site_id: 'MLB',
                seller_id: 4,
                price: 10,
                original_price: 100,
                category_id: 'X',
                currency_id: 'BRL',
                condition: 'new',
                listing_type_id: 'gold_special',
                shipping: {
                  free_shipping: true,
                  logistic_type: '',
                  mode: '',
                  tags: [],
                },
              },
            ],
          },
        });
      }
      if (url.includes('/products/CAT-D')) {
        return of({
          data: {
            id: 'CAT-D',
            name: 'Product D inactive',
            domain_id: 'D',
            status: 'paused', // inactive
            pictures: [{ url: 'https://x/d.jpg' }],
          },
        });
      }
      throw new Error(`unexpected url ${url}`);
    });

    const svc = new MercadoLivreService(http, makeConfig(), makeAuth());

    const deals = await svc.getDealsFromHighlights({
      category: 'MLB1648',
      minDiscount: 10,
      max: 5,
    });

    // CAT-C filtered out (5% < 10%); CAT-D filtered out (inactive); COLLECTION filtered.
    expect(deals.map((d) => d.catalogId)).toEqual(['CAT-A', 'CAT-B']);
    // Sort: A (50%) > B (20%)
    expect(deals[0].discountPercent).toBe(50);
    expect(deals[1].discountPercent).toBe(20);
    expect(deals[0].freeShipping).toBe(true);
    expect(deals[1].freeShipping).toBe(false);
  });

  it('honors max parameter', async () => {
    const make = (id: string, disc: number) => ({
      product: {
        id,
        name: `P-${id}`,
        domain_id: 'D',
        status: 'active',
        pictures: [{ url: 'https://x/y.jpg' }],
      },
      items: {
        paging: { total: 1, offset: 0, limit: 10 },
        results: [
          {
            item_id: `I-${id}`,
            site_id: 'MLB',
            seller_id: 1,
            price: 100 - disc,
            original_price: 100,
            category_id: 'X',
            currency_id: 'BRL',
            condition: 'new',
            listing_type_id: 'gold_special',
            shipping: {
              free_shipping: true,
              logistic_type: '',
              mode: '',
              tags: [],
            },
          },
        ],
      },
    });

    const products = ['A', 'B', 'C', 'D'].map((id, i) => make(id, 20 + i * 10));

    const http = makeHttp((url) => {
      if (url.includes('/highlights/')) {
        return of({
          data: {
            query_data: { highlight_type: '', criteria: '', id: 'MLB1' },
            content: products.map((p, i) => ({
              id: p.product.id,
              position: i,
              type: 'PRODUCT',
            })),
          },
        });
      }
      for (const p of products) {
        if (url.endsWith(`/products/${p.product.id}/items?limit=10`)) {
          return of({ data: p.items });
        }
        if (url.endsWith(`/products/${p.product.id}`)) {
          return of({ data: p.product });
        }
      }
      throw new Error(`unexpected ${url}`);
    });

    const svc = new MercadoLivreService(http, makeConfig(), makeAuth());

    const deals = await svc.getDealsFromHighlights({
      category: 'MLB1',
      minDiscount: 10,
      max: 2,
    });

    expect(deals).toHaveLength(2);
    // Sorted descending — should be the two highest discount entries.
    expect(deals[0].discountPercent).toBeGreaterThanOrEqual(
      deals[1].discountPercent,
    );
  });

  it('returns empty array when highlights has no PRODUCT entries (error-ish edge)', async () => {
    const http = makeHttp((url) => {
      if (url.includes('/highlights/')) {
        return of({
          data: {
            query_data: { highlight_type: '', criteria: '', id: 'MLB1' },
            content: [{ id: 'X', position: 1, type: 'COLLECTION' }],
          },
        });
      }
      throw new Error('should not fetch products');
    });

    const svc = new MercadoLivreService(http, makeConfig(), makeAuth());
    const deals = await svc.getDealsFromHighlights({
      category: 'MLB1',
      minDiscount: 10,
      max: 5,
    });
    expect(deals).toEqual([]);
  });

  it('continues when one product fetch fails (single deal gone, others survive)', async () => {
    const http = makeHttp((url) => {
      if (url.includes('/highlights/')) {
        return of({
          data: {
            query_data: { highlight_type: '', criteria: '', id: 'MLB1' },
            content: [
              { id: 'GOOD', position: 1, type: 'PRODUCT' },
              { id: 'BAD', position: 2, type: 'PRODUCT' },
            ],
          },
        });
      }
      if (url.includes('/products/BAD')) {
        // Non-retryable error (404) so withRetry surfaces it immediately.
        const err: any = new Error('not found');
        err.response = { status: 404 };
        return throwError(() => err);
      }
      if (url.endsWith('/products/GOOD/items?limit=10')) {
        return of({
          data: {
            paging: { total: 1, offset: 0, limit: 10 },
            results: [
              {
                item_id: 'I-GOOD',
                site_id: 'MLB',
                seller_id: 1,
                price: 50,
                original_price: 100,
                category_id: 'X',
                currency_id: 'BRL',
                condition: 'new',
                listing_type_id: 'gold_special',
                shipping: {
                  free_shipping: true,
                  logistic_type: '',
                  mode: '',
                  tags: [],
                },
              },
            ],
          },
        });
      }
      if (url.endsWith('/products/GOOD')) {
        return of({
          data: {
            id: 'GOOD',
            name: 'Good',
            domain_id: 'D',
            status: 'active',
            pictures: [{ url: 'https://x/g.jpg' }],
          },
        });
      }
      throw new Error(`unexpected ${url}`);
    });

    const svc = new MercadoLivreService(http, makeConfig(), makeAuth());

    const deals = await svc.getDealsFromHighlights({
      category: 'MLB1',
      minDiscount: 10,
      max: 5,
    });

    expect(deals.map((d) => d.catalogId)).toEqual(['GOOD']);
  });
});
