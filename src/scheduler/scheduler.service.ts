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

  private async tickBatch(): Promise<void> {
    const maxDeals = Number(this.config.get<string>('MAX_DEALS_PER_RUN', '3'));
    const startedAt = Date.now();
    try {
      const allScored = await this.pipeline.collectAllScored();
      const dispatch = await this.pipeline.dispatchScored(allScored, maxDeals);
      const ms = Date.now() - startedAt;
      this.logger.log(
        `Scheduler tick batch - totalScored=${allScored.length} ` +
          `dispatched=${dispatch.sent} failed=${dispatch.failed} ` +
          `topScore=${dispatch.topScore ?? 'n/a'} took=${ms}ms`,
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
      this.logger.warn('Scheduler tick (legacy) skipped - no source registered');
      return;
    }
    const maxDeals = Number(this.config.get<string>('MAX_DEALS_PER_RUN', '3'));
    const startedAt = Date.now();
    try {
      const scored = await this.pipeline.collectScoredOne(sourceId);
      const dispatch = await this.pipeline.dispatchScored(scored, maxDeals);
      const ms = Date.now() - startedAt;
      this.logger.log(
        `Scheduler tick legacy - source=${sourceId} scored=${scored.length} ` +
          `sent=${dispatch.sent} took=${ms}ms`,
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
