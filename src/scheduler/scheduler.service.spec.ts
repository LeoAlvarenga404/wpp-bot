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
import { OpsConfigService } from '../ops-config/ops-config.service';
import type { OpsConfigRepo } from '../ops-config/ops-config.repo';
import type { ApprovalQueueService } from '../curation/approval-queue.service';

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

/** Bifurcation seam the scheduler now dispatches through (issue #4). */
function makeApproval(): ApprovalQueueService {
  return {
    dispatchScored: jest.fn(async () => ({
      enqueued: 0,
      targets: 0,
      topScore: null,
      pending: 0,
      threshold: 999,
    })),
  } as unknown as ApprovalQueueService;
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
 * Real OpsConfigService over an in-memory repo: `dbRows` plays the OpsConfig
 * table, `env` keeps the db → env → default fallback observable in specs.
 */
function makeOpsConfig(
  env: Record<string, string>,
  dbRows: Record<string, string> = {},
): OpsConfigService {
  const store = new Map(Object.entries(dbRows));
  const repo = {
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, value: string) => {
      store.set(key, value);
    },
    getAll: async () =>
      [...store.entries()].map(([key, value]) => ({ key, value })),
  } as unknown as OpsConfigRepo;
  return new OpsConfigService(repo, makeConfig(env));
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
  it('calls pipeline.collectAllScored then approvalQueue.dispatchScored', async () => {
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
    const approval = makeApproval();
    const registry = makeRegistry([makeFakeSource('ml')]);
    const svc = new SchedulerService(
      pipeline,
      registry,
      makeConfig(env),
      makeOpsConfig(env),
      approval,
    );

    jest.useFakeTimers().setSystemTime(new Date('2026-05-14T12:00:00Z'));

    await svc.tick();

    expect(pipeline.collectAllScored).toHaveBeenCalled();
    expect(approval.dispatchScored).toHaveBeenCalled();
    // The scheduler no longer enqueues directly — the approval queue decides.
    expect(pipeline.enqueueScored).not.toHaveBeenCalled();
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
      makeOpsConfig(env),
      makeApproval(),
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
    const approval = makeApproval();
    const svc = new SchedulerService(
      pipeline,
      makeRegistry([makeFakeSource('ml')]),
      makeConfig(env),
      makeOpsConfig(env),
      approval,
    );
    // Midnight UTC = inside the 23->7 window; would normally skip.
    jest.useFakeTimers().setSystemTime(new Date('2026-05-14T00:00:00Z'));

    await svc.tick();

    expect(pipeline.collectAllScored).toHaveBeenCalled();
    expect(approval.dispatchScored).toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('db row QUIET_HOURS_ENABLED=false overrides env true with immediate effect', async () => {
    const env = {
      SCHEDULER_ENABLED: 'true',
      SCHEDULER_MODE: 'batch',
      QUIET_START: '23',
      QUIET_END: '7',
      QUIET_HOURS_ENABLED: 'true',
      TZ: 'UTC',
      TICK_JITTER_MAX_MIN: '0',
    };
    const pipeline = makePipeline();
    const svc = new SchedulerService(
      pipeline,
      makeRegistry([makeFakeSource('ml')]),
      makeConfig(env),
      makeOpsConfig(env, { QUIET_HOURS_ENABLED: 'false' }),
      makeApproval(),
    );
    // Midnight UTC = inside the 23->7 window; env alone would skip.
    jest.useFakeTimers().setSystemTime(new Date('2026-05-14T00:00:00Z'));

    await svc.tick();

    expect(pipeline.collectAllScored).toHaveBeenCalled();
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
    const approval = makeApproval();
    const registry = makeRegistry([makeFakeSource('ml')]);
    const svc = new SchedulerService(
      pipeline,
      registry,
      makeConfig(env),
      makeOpsConfig(env),
      approval,
    );
    jest.useFakeTimers().setSystemTime(new Date('2026-05-14T12:00:00Z'));

    await svc.tick();

    expect(pipeline.collectScoredOne).toHaveBeenCalledWith('ml');
    expect(approval.dispatchScored).toHaveBeenCalled();
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
      makeOpsConfig(env),
      makeApproval(),
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
