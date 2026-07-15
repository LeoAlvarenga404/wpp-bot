import { createHash } from 'node:crypto';
import { ShopeeClient } from './shopee-client';

function makeConfig(env: Record<string, string>) {
  return { get: (k: string) => env[k] } as any;
}

describe('ShopeeClient', () => {
  afterEach(() => jest.restoreAllMocks());

  it('signs with sha256(appId + timestamp + payload + secret)', () => {
    const client = new ShopeeClient(
      makeConfig({ SHOPEE_APP_ID: 'app1', SHOPEE_APP_SECRET: 'sec1' }),
    );
    const expected = createHash('sha256')
      .update('app1' + '1752580800' + '{"query":"q"}' + 'sec1')
      .digest('hex');
    expect(client.sign(1752580800, '{"query":"q"}')).toBe(expected);
  });

  it('sends Authorization header and returns data', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { productOfferV2: { nodes: [] } } }),
    });
    const client = new ShopeeClient(
      makeConfig({ SHOPEE_APP_ID: 'app1', SHOPEE_APP_SECRET: 'sec1' }),
    );

    const out = await client.query<{ productOfferV2: { nodes: unknown[] } }>({
      query: 'q',
    });

    expect(out.productOfferV2.nodes).toEqual([]);
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://open-api.affiliate.shopee.com.br/graphql');
    expect(init.headers.Authorization).toMatch(
      /^SHA256 Credential=app1, Timestamp=\d+, Signature=[0-9a-f]{64}$/,
    );
  });

  it('throws on graphql errors payload', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ errors: [{ message: 'invalid signature' }] }),
    });
    const client = new ShopeeClient(
      makeConfig({ SHOPEE_APP_ID: 'app1', SHOPEE_APP_SECRET: 'sec1' }),
    );

    await expect(client.query({ query: 'q' })).rejects.toThrow(
      /invalid signature/,
    );
  });
});
