import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';

/**
 * Thin wrapper around PrismaClient hooked into Nest's lifecycle.
 *
 * Emits Prisma query events to a Nest logger only when LOG_LEVEL=debug, so
 * production logs stay quiet while still being inspectable in development.
 *
 * NOTE: this file deliberately does NOT `import { PrismaClient } from
 * '@prisma/client'` at type-level. Prisma 7 only generates the
 * `PrismaClient` export after `prisma generate` runs against a real schema,
 * which the scaffold (P1-9) does not do automatically — there is no Postgres
 * yet. To keep `tsc --noEmit` green before the first generation, we resolve
 * the class lazily via `require` and treat it as an opaque base. After
 * `npm run prisma:generate` runs (when DATABASE_URL is provisioned) all the
 * generated typed methods will be available at runtime on instances of this
 * class.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PrismaClient } = require('@prisma/client') as {
  PrismaClient: new (opts?: unknown) => {
    $connect(): Promise<void>;
    $disconnect(): Promise<void>;
    $on(event: string, cb: (...args: unknown[]) => void): void;
  };
};

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    const debug = process.env.LOG_LEVEL === 'debug';
    super(
      debug
        ? {
            log: [
              { emit: 'event', level: 'query' },
              { emit: 'stdout', level: 'warn' },
              { emit: 'stdout', level: 'error' },
            ],
          }
        : {
            log: [
              { emit: 'stdout', level: 'warn' },
              { emit: 'stdout', level: 'error' },
            ],
          },
    );

    if (debug) {
      this.$on('query', (e: unknown) => {
        const evt = e as { query: string; params: string; duration: number };
        this.logger.debug(
          `query (${evt.duration}ms) ${evt.query} -- params=${evt.params}`,
        );
      });
    }
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Prisma connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.log('Prisma disconnected');
  }
}
