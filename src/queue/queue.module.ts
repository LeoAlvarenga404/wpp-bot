import { Global, Module, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConnectionOptions, Queue } from 'bullmq';
import { SEND_DEAL_QUEUE } from './queue.types';

export const SEND_DEAL_QUEUE_TOKEN = Symbol('SEND_DEAL_QUEUE');

/**
 * Lazily-constructed BullMQ connection options derived from REDIS_URL.
 * BullMQ requires `maxRetriesPerRequest: null` on its ioredis connections so
 * blocking BRPOPLPUSH calls don't hit the default retry cap and crash the
 * worker.
 */
function buildRedisConnection(config: ConfigService): ConnectionOptions {
  const url = config.get<string>('REDIS_URL', 'redis://redis:6379');
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 6379,
    password: parsed.password || undefined,
    username: parsed.username || undefined,
    maxRetriesPerRequest: null,
  };
}

@Global()
@Module({
  providers: [
    {
      provide: SEND_DEAL_QUEUE_TOKEN,
      inject: [ConfigService],
      useFactory: (config: ConfigService): Queue => {
        return new Queue(SEND_DEAL_QUEUE, {
          connection: buildRedisConnection(config),
          defaultJobOptions: {
            attempts: 5,
            backoff: { type: 'exponential', delay: 5_000 },
            removeOnComplete: { age: 24 * 3600, count: 500 },
            removeOnFail: { age: 7 * 24 * 3600 },
          },
        });
      },
    },
    {
      provide: 'REDIS_CONNECTION_OPTIONS',
      inject: [ConfigService],
      useFactory: (config: ConfigService) => buildRedisConnection(config),
    },
  ],
  exports: [SEND_DEAL_QUEUE_TOKEN, 'REDIS_CONNECTION_OPTIONS'],
})
export class QueueModule implements OnModuleDestroy {
  constructor() {}
  // Queue lifecycle is managed by BullMQ — explicit close handled per
  // service. Worker shutdown lives in the worker provider itself.
  async onModuleDestroy(): Promise<void> {
    /* no-op: queues close on Redis connection teardown */
  }
}
