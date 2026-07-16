// src/scheduler/scheduler.service.spec.ts

jest.mock('@whiskeysockets/baileys', () => ({}));
jest.mock('@hapi/boom', () => ({ Boom: class Boom {} }));
jest.mock('@sentry/node', () => ({
  captureException: jest.fn(),
  init: jest.fn(),
}));
jest.mock('../whatsapp/wa.service');

import { ConfigService } from '@nestjs/config';
import { SchedulerService } from './scheduler.service';
import type { PipelineService } from '../pipeline/pipeline.service';
import type { SourceRegistry } from '../sources/source-registry.service';
import type { DealSourcePort } from '../sources/source.port';
import type { ScoredDeal } from '../deal-score/types';

function makeFakeSource(id: 'ml'): DealSourcePort {
  return {
    id,
    discover: jest.fn(async () => []),
    discoverOne: jest.fn(async () => []),
    enrichMany: jest.fn(async () => []),
  };
}

function makePipeline(): PipelineService {
  return {
    collectScored: jest.fn(async (): Promise<ScoredDeal[]> => []),
    collectScoredOne: jest.fn(async (): Promise<ScoredDeal[]> => []),
    collectAllScored: jest.fn(async (): Promise<ScoredDeal[]> => []),
    enqueueScored: jest.fn(async () => ({
      enqueued: 0,
      targets: 0,
      topScore: null,
    })),
    runOnce: jest.fn(async () => ({
      enqueued: 0,
      targets: 0,
      scored: 0,
      topScore: null,
      sourceId: 'ml',
    })),
  } as unknown as PipelineService;
}

function makeRegistry(sources: DealSourcePort[]): SourceRegistry {
  return {
    getAll: jest.fn(() => sources),
    getById: jest.fn((id: string) => sources.find((s) => s.id === id)!),
  } as unknown as SourceRegistry;
}

function makeConfig(env: Record<string, string>): ConfigService {
  return {
    get: (k: string, def?: string) => env[k] ?? def,
  } as unknown as ConfigService;
}

/**
 * Test double exposing the jitter seams: `random()` is fixed and `delay()`
 * records requested waits, resolving via `resolveDelay` (immediately by
 * default) so specs never actually wait.
 */
class TestScheduler extends SchedulerService {
  delays: number[] = [];
  randomValue = 0.5;
  resolveDelay: (() => void) | null = null;
  holdDelay = false;

  protected random(): number {
    return this.randomValue;
  }

  protected delay(ms: number): Promise<void> {
    this.delays.push(ms);
    if (!this.holdDelay) return Promise.resolve();
    return new Promise<void>((res) => {
      this.resolveDelay = res;
    });
  }
}

describe('SchedulerService.tickBatch', () => {
  it('calls pipeline.collectAllScored then enqueueScored', async () => {
    const env = {
      SCHEDULER_ENABLED: 'true',
      SCHEDULER_MODE: 'batch',
      MAX_DEALS_PER_RUN: '3',
      QUIET_START: '23',
      QUIET_END: '7',
      TZ: 'UTC',
      TICK_JITTER_MAX_MIN: '0',
    };
    const pipeline = makePipeline();
    const registry = makeRegistry([makeFakeSource('ml')]);
    const svc = new SchedulerService(pipeline, registry, makeConfig(env));

    jest.useFakeTimers().setSystemTime(new Date('2026-05-14T12:00:00Z'));

    await svc.tick();

    expect(pipeline.collectAllScored).toHaveBeenCalled();
    expect(pipeline.enqueueScored).toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('skips when inside quiet hours', async () => {
    const env = {
      SCHEDULER_ENABLED: 'true',
      SCHEDULER_MODE: 'batch',
      QUIET_START: '23',
      QUIET_END: '7',
      TZ: 'UTC',
      TICK_JITTER_MAX_MIN: '0',
    };
    const pipeline = makePipeline();
    const svc = new SchedulerService(
      pipeline,
      makeRegistry([makeFakeSource('ml')]),
      makeConfig(env),
    );
    jest.useFakeTimers().setSystemTime(new Date('2026-05-14T00:00:00Z'));

    await svc.tick();

    expect(pipeline.collectAllScored).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('fires inside quiet hours when QUIET_HOURS_ENABLED=false', async () => {
    const env = {
      SCHEDULER_ENABLED: 'true',
      SCHEDULER_MODE: 'batch',
      QUIET_START: '23',
      QUIET_END: '7',
      QUIET_HOURS_ENABLED: 'false',
      TZ: 'UTC',
      TICK_JITTER_MAX_MIN: '0',
    };
    const pipeline = makePipeline();
    const svc = new SchedulerService(
      pipeline,
      makeRegistry([makeFakeSource('ml')]),
      makeConfig(env),
    );
    // Midnight UTC = inside the 23->7 window; would normally skip.
    jest.useFakeTimers().setSystemTime(new Date('2026-05-14T00:00:00Z'));

    await svc.tick();

    expect(pipeline.collectAllScored).toHaveBeenCalled();
    expect(pipeline.enqueueScored).toHaveBeenCalled();
    jest.useRealTimers();
  });
});

describe('SchedulerService.tickLegacy', () => {
  it('calls pipeline.collectScoredOne with sourceId from rotator', async () => {
    const env = {
      SCHEDULER_ENABLED: 'true',
      SCHEDULER_MODE: 'legacy',
      MAX_DEALS_PER_RUN: '3',
      TICK_JITTER_MAX_MIN: '0',
    };
    const pipeline = makePipeline();
    const registry = makeRegistry([makeFakeSource('ml')]);
    const svc = new SchedulerService(pipeline, registry, makeConfig(env));
    jest.useFakeTimers().setSystemTime(new Date('2026-05-14T12:00:00Z'));

    await svc.tick();

    expect(pipeline.collectScoredOne).toHaveBeenCalledWith('ml');
    expect(pipeline.enqueueScored).toHaveBeenCalled();
    jest.useRealTimers();
  });
});

describe('SchedulerService tick jitter', () => {
  const baseEnv = {
    SCHEDULER_ENABLED: 'true',
    SCHEDULER_MODE: 'batch',
    QUIET_START: '23',
    QUIET_END: '7',
    TZ: 'UTC',
  };

  function makeSvc(env: Record<string, string>) {
    const pipeline = makePipeline();
    const svc = new TestScheduler(
      pipeline,
      makeRegistry([makeFakeSource('ml')]),
      makeConfig(env),
    );
    return { svc, pipeline };
  }

  afterEach(() => jest.useRealTimers());

  it('delays random*TICK_JITTER_MAX_MIN minutes before the tick body', async () => {
    const { svc, pipeline } = makeSvc({
      ...baseEnv,
      TICK_JITTER_MAX_MIN: '10',
    });
    svc.randomValue = 0.5;
    jest.useFakeTimers().setSystemTime(new Date('2026-05-14T12:00:00Z'));

    await svc.tick();

    expect(svc.delays).toEqual([5 * 60_000]);
    expect(pipeline.collectAllScored).toHaveBeenCalled();
  });

  it('defaults TICK_JITTER_MAX_MIN to 15 minutes', async () => {
    const { svc } = makeSvc(baseEnv);
    svc.randomValue = 1;
    jest.useFakeTimers().setSystemTime(new Date('2026-05-14T12:00:00Z'));

    await svc.tick();

    expect(svc.delays).toEqual([15 * 60_000]);
  });

  it('TICK_JITTER_MAX_MIN=0 disables the delay entirely', async () => {
    const { svc, pipeline } = makeSvc({ ...baseEnv, TICK_JITTER_MAX_MIN: '0' });
    jest.useFakeTimers().setSystemTime(new Date('2026-05-14T12:00:00Z'));

    await svc.tick();

    expect(svc.delays).toEqual([]);
    expect(pipeline.collectAllScored).toHaveBeenCalled();
  });

  it('skips overlapping ticks while a delayed tick is still in flight', async () => {
    const { svc, pipeline } = makeSvc({
      ...baseEnv,
      TICK_JITTER_MAX_MIN: '15',
    });
    svc.holdDelay = true;
    jest.useFakeTimers().setSystemTime(new Date('2026-05-14T12:00:00Z'));

    const first = svc.tick();
    // Second tick fires while the first is still waiting out its jitter.
    await svc.tick();

    expect(pipeline.collectAllScored).not.toHaveBeenCalled();
    expect(svc.delays).toHaveLength(1); // second tick never even delayed

    svc.resolveDelay!();
    await first;

    expect(pipeline.collectAllScored).toHaveBeenCalledTimes(1);
  });

  it('releases the in-flight guard after the tick finishes', async () => {
    const { svc, pipeline } = makeSvc({ ...baseEnv, TICK_JITTER_MAX_MIN: '0' });
    jest.useFakeTimers().setSystemTime(new Date('2026-05-14T12:00:00Z'));

    await svc.tick();
    await svc.tick();

    expect(pipeline.collectAllScored).toHaveBeenCalledTimes(2);
  });
});
