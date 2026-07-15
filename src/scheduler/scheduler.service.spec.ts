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

describe('SchedulerService.tickBatch', () => {
  it('calls pipeline.collectAllScored then enqueueScored', async () => {
    const env = {
      SCHEDULER_ENABLED: 'true',
      SCHEDULER_MODE: 'batch',
      MAX_DEALS_PER_RUN: '3',
      QUIET_START: '23',
      QUIET_END: '7',
      TZ: 'UTC',
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
});

describe('SchedulerService.tickLegacy', () => {
  it('calls pipeline.collectScoredOne with sourceId from rotator', async () => {
    const env = {
      SCHEDULER_ENABLED: 'true',
      SCHEDULER_MODE: 'legacy',
      MAX_DEALS_PER_RUN: '3',
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
