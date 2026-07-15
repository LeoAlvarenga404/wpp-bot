import { ShopeeSource } from './shopee-source.service';
import type { ShopeeOfferNode } from './mapping';

function node(id: number, name = 'Produto'): ShopeeOfferNode {
  return {
    itemId: id,
    productName: `${name} ${id}`,
    price: '49.90',
    priceDiscountRate: 40,
    imageUrl: 'https://img',
    offerLink: `https://s.shopee.com.br/${id}`,
    productLink: `https://shopee.com.br/p/${id}`,
    sales: 200,
    ratingStar: '4.6',
    shopName: 'Loja',
    shopType: null,
  };
}

function makeDeps(nodesByCall: ShopeeOfferNode[][]) {
  let call = 0;
  const client = {
    query: jest.fn(async () => ({
      productOfferV2: { nodes: nodesByCall[call++] ?? [] },
    })),
  } as any;
  const source = new ShopeeSource(client, {
    keywords: ['teclado', 'mouse'],
    limitPerKeyword: 20,
  });
  return { client, source };
}

describe('ShopeeSource', () => {
  it('discover: one query per keyword, maps nodes to RawDeal', async () => {
    const { client, source } = makeDeps([[node(1)], [node(2)]]);

    const raws = await source.discover();

    expect(client.query).toHaveBeenCalledTimes(2);
    expect(raws.map((r) => r.key.externalId)).toEqual(['1', '2']);
    expect(raws[0].key.source).toBe('shopee');
  });

  it('discover: a failing keyword does not kill the others', async () => {
    const { client, source } = makeDeps([[node(1)]]);
    client.query
      .mockRejectedValueOnce(new Error('shopee status=500'))
      .mockResolvedValueOnce({ productOfferV2: { nodes: [node(2)] } });

    const raws = await source.discover();

    expect(raws.map((r) => r.key.externalId)).toEqual(['2']);
  });

  it('enrichMany reuses feed nodes without extra API calls', async () => {
    const { client, source } = makeDeps([[node(1)], []]);
    const raws = await source.discover();
    client.query.mockClear();

    const enriched = await source.enrichMany(raws);

    expect(client.query).not.toHaveBeenCalled();
    expect(enriched[0].seller?.sellerTrust).toBe('high');
    expect(enriched[0].source).toBe('shopee');
  });

  it('discoverOne rotates keywords between calls', async () => {
    const { client, source } = makeDeps([[node(1)], [node(2)]]);

    await source.discoverOne();
    await source.discoverOne();

    const kws = (client.query as jest.Mock).mock.calls.map(
      ([req]: any[]) => req.variables.keyword,
    );
    expect(kws).toEqual(['teclado', 'mouse']);
  });
});
