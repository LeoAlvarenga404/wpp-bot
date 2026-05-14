// src/sources/mercado-livre/feed-rotator.service.spec.ts

import { ConfigService } from '@nestjs/config';
import { FeedRotatorService } from './feed-rotator.service';

function makeService(weights?: string): FeedRotatorService {
  const config = {
    get: (key: string, def?: string) => {
      if (key === 'CATEGORY_WEIGHTS') return weights ?? def;
      return def;
    },
  } as unknown as ConfigService;
  const svc = new FeedRotatorService(config);
  svc.onModuleInit();
  return svc;
}

describe('FeedRotatorService', () => {
  it('parseWeights handles well-formed input', () => {
    const svc = makeService('A:2,B:3');
    expect(svc.getWeighted()).toEqual([
      { feedId: 'A', weight: 2 },
      { feedId: 'B', weight: 3 },
    ]);
  });

  it('parseWeights drops malformed entries', () => {
    const svc = makeService('A:2, :3 ,B:abc,C:4');
    expect(svc.getWeighted()).toEqual([
      { feedId: 'A', weight: 2 },
      { feedId: 'C', weight: 4 },
    ]);
  });

  it('pick() returns null on empty weights', () => {
    const svc = makeService('');
    expect(svc.pick()).toBeNull();
  });

  it('pick() never repeats when more than one feed is configured', () => {
    const svc = makeService('A:1,B:1,C:1');
    const first = svc.pick()!;
    const second = svc.pick()!;
    expect(second).not.toBe(first);
  });

  it('getWeighted returns the parsed entries', () => {
    const svc = makeService('A:2,B:3');
    expect(svc.getWeighted()).toEqual([
      { feedId: 'A', weight: 2 },
      { feedId: 'B', weight: 3 },
    ]);
  });
});
