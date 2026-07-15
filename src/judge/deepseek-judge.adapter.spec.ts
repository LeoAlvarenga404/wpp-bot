import { ConfigService } from '@nestjs/config';
import { DeepSeekJudgeAdapter } from './deepseek-judge.adapter';
import type { JudgeInput } from './judge.port';

const input: JudgeInput = {
  title: 'Fone XYZ',
  priceCents: 8990,
  originalPriceCents: 14990,
  discountPercent: 40,
  condition: 'new',
  score: 82,
  level: 'good',
  reasons: ['Desconto de 40%'],
  penalties: [],
  priceRaiseSuspicious: false,
  analytics: {
    median30d: 11000,
    min30d: 9000,
    min14d: 9500,
    min7d: 9800,
    distinctDays: 12,
    trend: 'falling',
  },
  seller: { trust: 'high', isVerifiedStore: true, displayName: 'Loja' },
  volumeTier: 'high',
};

function makeAdapter(overrides: Record<string, string> = {}) {
  const values: Record<string, string> = {
    DEEPSEEK_API_KEY: 'sk-test',
    ...overrides,
  };
  const config = {
    get: (key: string, def?: string) => values[key] ?? def,
  } as unknown as ConfigService;
  return new DeepSeekJudgeAdapter(config);
}

function mockFetchOnce(body: unknown, ok = true, status = 200) {
  (global.fetch as jest.Mock).mockResolvedValueOnce({
    ok,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  });
}

describe('DeepSeekJudgeAdapter', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  it('parses a valid verdict from JSON content', async () => {
    mockFetchOnce({
      choices: [
        {
          message: {
            content:
              '{"approve": true, "confidence": 0.85, "reason": "preço abaixo da mediana"}',
          },
        },
      ],
    });
    const verdict = await makeAdapter().judge(input);
    expect(verdict).toEqual({
      approve: true,
      confidence: 0.85,
      reason: 'preço abaixo da mediana',
    });
    const call = (global.fetch as jest.Mock).mock.calls[0];
    expect(call[0]).toBe('https://api.deepseek.com/chat/completions');
    const payload = JSON.parse(call[1].body);
    expect(payload.response_format).toEqual({ type: 'json_object' });
    expect(payload.temperature).toBe(0);
  });

  it('throws on HTTP error status', async () => {
    mockFetchOnce({ error: 'rate limited' }, false, 429);
    await expect(makeAdapter().judge(input)).rejects.toThrow('status=429');
  });

  it('throws on invalid JSON content', async () => {
    mockFetchOnce({
      choices: [{ message: { content: 'não é json' } }],
    });
    await expect(makeAdapter().judge(input)).rejects.toThrow();
  });

  it('throws on malformed verdict shape', async () => {
    mockFetchOnce({
      choices: [{ message: { content: '{"approve": "sim"}' } }],
    });
    await expect(makeAdapter().judge(input)).rejects.toThrow('invalid verdict');
  });

  it('clamps confidence into 0..1', async () => {
    mockFetchOnce({
      choices: [
        { message: { content: '{"approve": true, "confidence": 3, "reason": "x"}' } },
      ],
    });
    const verdict = await makeAdapter().judge(input);
    expect(verdict.confidence).toBe(1);
  });
});
