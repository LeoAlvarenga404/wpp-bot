import type { DealItem } from '../mercado-livre/types';
import { DeepSeekHeadlineAdapter } from './deepseek-headline.adapter';

function makeItem(): DealItem {
  return {
    catalogId: 'MLB1',
    itemId: 'MLB1',
    title: 'Produto X',
    thumbnail: '',
    price: 89.9,
    originalPrice: 149.9,
    sellerId: 0,
    freeShipping: false,
    permalink: 'https://ml/p',
    discountPercent: 40,
  };
}

function makeDeps(env: Record<string, string>) {
  const config = {
    get: (k: string) => env[k],
  } as any;
  const cache = { get: jest.fn(() => null), set: jest.fn() } as any;
  const fallback = { generate: jest.fn(async () => 'STATIC HOOK 🔥🔥') } as any;
  return { config, cache, fallback };
}

function okResponse(content: string) {
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
  } as any;
}

describe('DeepSeekHeadlineAdapter', () => {
  afterEach(() => jest.restoreAllMocks());

  it('returns sanitized headline and caches it', async () => {
    const d = makeDeps({ DEEPSEEK_API_KEY: 'k' });
    global.fetch = jest
      .fn()
      .mockResolvedValue(okResponse('"CORRE QUE TA BARATO 🔥🔥"'));
    const adapter = new DeepSeekHeadlineAdapter(d.config, d.cache, d.fallback);

    const out = await adapter.generate(makeItem());

    expect(out).toBe('CORRE QUE TA BARATO 🔥🔥');
    expect(d.cache.set).toHaveBeenCalledWith(
      'MLB1',
      'CORRE QUE TA BARATO 🔥🔥',
    );
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://api.deepseek.com/chat/completions');
    expect(JSON.parse(init.body).model).toBe('deepseek-chat');
  });

  it('falls back to static pool on HTTP error', async () => {
    const d = makeDeps({ DEEPSEEK_API_KEY: 'k' });
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' });
    const adapter = new DeepSeekHeadlineAdapter(d.config, d.cache, d.fallback);

    const out = await adapter.generate(makeItem());

    expect(out).toBe('STATIC HOOK 🔥🔥');
    expect(d.fallback.generate).toHaveBeenCalled();
  });

  it('falls back without calling fetch when key is missing', async () => {
    const d = makeDeps({});
    global.fetch = jest.fn();
    const adapter = new DeepSeekHeadlineAdapter(d.config, d.cache, d.fallback);

    const out = await adapter.generate(makeItem());

    expect(out).toBe('STATIC HOOK 🔥🔥');
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
