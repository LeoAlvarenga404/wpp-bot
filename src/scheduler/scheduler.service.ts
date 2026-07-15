import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { PipelineService } from '../pipeline/pipeline.service';
import type { SourceId } from '../sources/source.port';
import { SourceRegistry } from '../sources/source-registry.service';
import { isQuietHours } from './quiet-hours';

@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);

  constructor(
    private readonly pipeline: PipelineService,
    private readonly registry: SourceRegistry,
    private readonly config: ConfigService,
  ) {}

  @Cron(process.env.SCHEDULER_CRON ?? '0 10,13,17,20 * * *')
  async tick(): Promise<void> {
    const enabled =
      (this.config.get<string>('SCHEDULER_ENABLED') ??
        process.env.SCHEDULER_ENABLED) === 'true';
    if (!enabled) {
      this.logger.debug('Scheduler tick skipped - SCHEDULER_ENABLED!=true');
      return;
    }

    const tz =
      this.config.get<string>('TZ') ?? process.env.TZ ?? 'America/Sao_Paulo';
    const quietStart = Number(
      this.config.get<string>('QUIET_START') ?? process.env.QUIET_START ?? '23',
    );
    const quietEnd = Number(
      this.config.get<string>('QUIET_END') ?? process.env.QUIET_END ?? '7',
    );
    if (isQuietHours(new Date(), quietStart, quietEnd, tz)) {
      this.logger.log(`Scheduler tick skipped - quiet hours`);
      return;
    }

    const mode = (
      this.config.get<string>('SCHEDULER_MODE') ??
      process.env.SCHEDULER_MODE ??
      'legacy'
    ).toLowerCase();

    if (mode === 'batch') {
      await this.tickBatch();
      return;
    }
    await this.tickLegacy();
  }

  /**
   * Whether this scheduler tick should enqueue WhatsApp jobs after the
   * collect+score phase. When false (`SCHEDULER_DISPATCH_ENABLED=false`),
   * the tick still drives the full pipeline so price history / seller cache /
   * dedup keep accruing — but no jobs hit the queue. Useful for a "warmup"
   * phase where you want the score / median / lowest-price signals to
   * stabilize before turning sends back on.
   */
  private dispatchEnabled(): boolean {
    // NOTE: no `?? process.env.X` fallback here. ConfigService already reads
    // process.env in production (ConfigModule.forRoot). A direct process.env
    // read makes unit tests environment-dependent: requiring @prisma/client
    // side-loads the repo's .env into process.env, so a local
    // SCHEDULER_DISPATCH_ENABLED=false silently flipped this to collect-only
    // inside Jest.
    const raw = this.config.get<string>('SCHEDULER_DISPATCH_ENABLED') ?? 'true';
    return raw.toLowerCase() !== 'false';
  }

  private async tickBatch(): Promise<void> {
    const startedAt = Date.now();
    const dispatch = this.dispatchEnabled();
    try {
      const allScored = await this.pipeline.collectAllScored();
      const ms = Date.now() - startedAt;
      if (!dispatch) {
        this.logger.log(
          `Scheduler tick batch (collect-only) - totalScored=${allScored.length} ` +
            `topScore=${allScored[0]?.score ?? 'n/a'} took=${ms}ms`,
        );
        return;
      }
      const result = await this.pipeline.enqueueScored(allScored);
      this.logger.log(
        `Scheduler tick batch - totalScored=${allScored.length} ` +
          `enqueued=${result.enqueued} targets=${result.targets} ` +
          `topScore=${result.topScore ?? 'n/a'} took=${ms}ms`,
      );
    } catch (err) {
      const ms = Date.now() - startedAt;
      this.logger.error(
        `Scheduler tick batch failed - took=${ms}ms: ${(err as Error).message}`,
        (err as Error).stack,
      );
    }
  }

  private async tickLegacy(): Promise<void> {
    const sourceId = this.pickSourceId();
    if (!sourceId) {
      this.logger.warn(
        'Scheduler tick (legacy) skipped - no source registered',
      );
      return;
    }
    const startedAt = Date.now();
    const dispatch = this.dispatchEnabled();
    try {
      const scored = await this.pipeline.collectScoredOne(sourceId);
      const ms = Date.now() - startedAt;
      if (!dispatch) {
        this.logger.log(
          `Scheduler tick legacy (collect-only) - source=${sourceId} ` +
            `scored=${scored.length} topScore=${scored[0]?.score ?? 'n/a'} took=${ms}ms`,
        );
        return;
      }
      const result = await this.pipeline.enqueueScored(scored);
      this.logger.log(
        `Scheduler tick legacy - source=${sourceId} scored=${scored.length} ` +
          `enqueued=${result.enqueued} targets=${result.targets} took=${ms}ms`,
      );
    } catch (err) {
      const ms = Date.now() - startedAt;
      this.logger.error(
        `Scheduler tick legacy failed - source=${sourceId} took=${ms}ms: ${(err as Error).message}`,
        (err as Error).stack,
      );
    }
  }

  private pickSourceId(): SourceId | null {
    const all = this.registry.getAll();
    if (all.length === 0) return null;
    return all[0].id;
  }
}
