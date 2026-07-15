import { JudgeVerdictCache } from './verdict-cache';
import type { JudgeVerdict } from './judge.port';

const v: JudgeVerdict = { approve: true, confidence: 0.9, reason: 'ok' };

describe('JudgeVerdictCache', () => {
  it('returns cached verdict within TTL and same price', () => {
    const cache = new JudgeVerdictCache();
    cache.set('ml:MLB1', 10000, v, 1_000);
    expect(cache.get('ml:MLB1', 10000, 2_000)).toEqual(v);
  });

  it('misses after TTL', () => {
    const cache = new JudgeVerdictCache(1000);
    cache.set('ml:MLB1', 10000, v, 1_000);
    expect(cache.get('ml:MLB1', 10000, 2_500)).toBeNull();
  });

  it('invalidates when price moves more than 2%', () => {
    const cache = new JudgeVerdictCache();
    cache.set('ml:MLB1', 10000, v, 1_000);
    expect(cache.get('ml:MLB1', 10300, 1_500)).toBeNull(); // +3%
    expect(cache.get('ml:MLB1', 10000, 1_500)).toBeNull(); // invalidado acima
  });

  it('evicts oldest entry beyond maxEntries', () => {
    const cache = new JudgeVerdictCache(60_000, 2);
    cache.set('a', 100, v, 1);
    cache.set('b', 100, v, 2);
    cache.set('c', 100, v, 3);
    expect(cache.get('a', 100, 4)).toBeNull();
    expect(cache.get('c', 100, 4)).toEqual(v);
  });
});
