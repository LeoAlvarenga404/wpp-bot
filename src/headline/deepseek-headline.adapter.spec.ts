import type { DealItem } from '../mercado-livre/types';
import { DeepSeekHeadlineAdapter } from './deepseek-headline.adapter';
import { COPY_CONFIG_DEFAULT } from './headline-copy.defaults';

function makeItem(overrides: Partial<DealItem> = {}): DealItem {
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
    ...overrides,
  };
}

function makeDeps(env: Record<string, string>) {
  const config = {
    get: (k: string) => env[k],
  } as any;
  const cache = { get: jest.fn(() => null), set: jest.fn() } as any;
  const fallback = { generate: jest.fn(async () => 'STATIC HOOK 🔥🔥') } as any;
  const copy = { get: jest.fn(() => COPY_CONFIG_DEFAULT) } as any;
  const counters = { headlineFrameUsed: { inc: jest.fn() } } as any;
  return { config, cache, fallback, copy, counters };
}

function build(d: ReturnType<typeof makeDeps>) {
  return new DeepSeekHeadlineAdapter(
    d.config,
    d.cache,
    d.fallback,
    d.copy,
    d.counters,
  );
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
    const adapter = build(d);

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

  it('increments the frame counter once per generation', async () => {
    const d = makeDeps({ DEEPSEEK_API_KEY: 'k' });
    global.fetch = jest.fn().mockResolvedValue(okResponse('CORRE AI 🔥🔥'));
    const adapter = build(d);

    await adapter.generate(makeItem());

    expect(d.counters.headlineFrameUsed.inc).toHaveBeenCalledTimes(1);
    const label = d.counters.headlineFrameUsed.inc.mock.calls[0][0];
    expect(typeof label.frame).toBe('string');
    expect(label.frame.length).toBeGreaterThan(0);
  });

  it('rejects a hook with no emoji, then keeps the retry', async () => {
    const d = makeDeps({ DEEPSEEK_API_KEY: 'k' });
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(okResponse('CORRE QUE TA BARATO')) // no emoji
      .mockResolvedValueOnce(okResponse('CORRE AI MEU CHAPA 🔥🔥'));
    const adapter = build(d);

    const out = await adapter.generate(makeItem());

    expect(out).toBe('CORRE AI MEU CHAPA 🔥🔥');
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(d.fallback.generate).not.toHaveBeenCalled();
  });

  it('rejects a forbidden word, then keeps the retry', async () => {
    const d = makeDeps({ DEEPSEEK_API_KEY: 'k' });
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(okResponse('OFERTA BOA DEMAIS 🔥🔥')) // forbidden
      .mockResolvedValueOnce(okResponse('ACHADO BÃO DEMAIS 🔥🔥'));
    const adapter = build(d);

    const out = await adapter.generate(makeItem());

    expect(out).toBe('ACHADO BÃO DEMAIS 🔥🔥');
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('falls back when the hook just copies the product title (both tries)', async () => {
    const d = makeDeps({ DEEPSEEK_API_KEY: 'k' });
    const item = makeItem({ title: 'Air Fryer Mondial Cesta 5 Litros Preta' });
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        okResponse('AIR FRYER MONDIAL CESTA LITROS PRETA 🔥🔥'),
      );
    const adapter = build(d);

    const out = await adapter.generate(item);

    expect(out).toBe('STATIC HOOK 🔥🔥');
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(d.fallback.generate).toHaveBeenCalled();
    expect(d.cache.set).not.toHaveBeenCalled();
  });

  it('falls back to static pool on HTTP error', async () => {
    const d = makeDeps({ DEEPSEEK_API_KEY: 'k' });
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' });
    const adapter = build(d);

    const out = await adapter.generate(makeItem());

    expect(out).toBe('STATIC HOOK 🔥🔥');
    expect(d.fallback.generate).toHaveBeenCalled();
  });

  it('falls back without calling fetch when key is missing', async () => {
    const d = makeDeps({});
    global.fetch = jest.fn();
    const adapter = build(d);

    const out = await adapter.generate(makeItem());

    expect(out).toBe('STATIC HOOK 🔥🔥');
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
