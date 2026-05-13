import { defaultShouldRetry, withRetry } from './retry';

describe('retry / withRetry', () => {
  it('succeeds on first try without delay', async () => {
    const fn = jest.fn().mockResolvedValue('ok');

    const result = await withRetry(fn, { baseMs: 1, maxMs: 5 });

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on 429 then succeeds', async () => {
    const err429: any = new Error('rate limited');
    err429.response = { status: 429 };

    const fn = jest
      .fn()
      .mockRejectedValueOnce(err429)
      .mockResolvedValueOnce('ok');

    const result = await withRetry(fn, { baseMs: 1, maxMs: 5 });

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry on 400', async () => {
    const err400: any = new Error('bad request');
    err400.response = { status: 400 };
    const fn = jest.fn().mockRejectedValue(err400);

    await expect(
      withRetry(fn, { baseMs: 1, maxMs: 5, maxAttempts: 5 }),
    ).rejects.toBe(err400);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry on 401', async () => {
    const err: any = new Error('unauthorized');
    err.response = { status: 401 };
    const fn = jest.fn().mockRejectedValue(err);

    await expect(withRetry(fn, { baseMs: 1, maxMs: 5 })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws after maxAttempts exhausted', async () => {
    const err: any = new Error('boom');
    err.response = { status: 503 };
    const fn = jest.fn().mockRejectedValue(err);

    await expect(
      withRetry(fn, { baseMs: 1, maxMs: 5, maxAttempts: 3 }),
    ).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('retries on network code ECONNRESET', async () => {
    const err: any = new Error('reset');
    err.code = 'ECONNRESET';
    const fn = jest
      .fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce('after-reset');

    const result = await withRetry(fn, { baseMs: 1, maxMs: 5 });

    expect(result).toBe('after-reset');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('exponential delay grows between attempts (jitter mocked off)', async () => {
    // Pin Math.random so jitter == 0, making delays deterministic.
    const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.5);

    const err: any = new Error('flaky');
    err.response = { status: 502 };
    const fn = jest
      .fn()
      .mockRejectedValueOnce(err)
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce('ok');

    const delays: number[] = [];
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation(((
      cb: any,
      ms?: number,
    ) => {
      delays.push(ms ?? 0);
      // Fire immediately so tests don't hang.
      cb();
      return 0 as any;
    }) as any);

    const result = await withRetry(fn, {
      baseMs: 100,
      maxMs: 60_000,
      jitterPct: 0, // remove jitter entirely
    });

    expect(result).toBe('ok');
    expect(delays.length).toBe(2);
    // base * 2^0 = 100, base * 2^1 = 200 — growth observed.
    expect(delays[1]).toBeGreaterThan(delays[0]);

    randomSpy.mockRestore();
    setTimeoutSpy.mockRestore();
  });

  it('defaultShouldRetry: classification matches spec', () => {
    const make = (status?: number, code?: string): any => {
      const e: any = new Error('x');
      if (status !== undefined) e.response = { status };
      if (code) e.code = code;
      return e;
    };

    expect(defaultShouldRetry(make(429))).toBe(true);
    expect(defaultShouldRetry(make(500))).toBe(true);
    expect(defaultShouldRetry(make(503))).toBe(true);
    expect(defaultShouldRetry(make(400))).toBe(false);
    expect(defaultShouldRetry(make(401))).toBe(false);
    expect(defaultShouldRetry(make(403))).toBe(false);
    expect(defaultShouldRetry(make(404))).toBe(false);
    expect(defaultShouldRetry(make(undefined, 'ECONNRESET'))).toBe(true);
    expect(defaultShouldRetry(make(undefined, 'ETIMEDOUT'))).toBe(true);
    // Unknown status (e.g. 418) -> no retry.
    expect(defaultShouldRetry(make(418))).toBe(false);
  });
});
