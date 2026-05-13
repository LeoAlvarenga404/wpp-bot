import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { PipelineService } from '../pipeline/pipeline.service';
import { CategoryRotatorService } from './category-rotator.service';
import { isQuietHours } from './quiet-hours';

@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);

  constructor(
    private readonly pipeline: PipelineService,
    private readonly rotator: CategoryRotatorService,
    private readonly config: ConfigService,
  ) {}

  @Cron(process.env.SCHEDULER_CRON ?? '0 10,13,17,20 * * *')
  async tick(): Promise<void> {
    const enabled =
      (this.config.get<string>('SCHEDULER_ENABLED') ??
        process.env.SCHEDULER_ENABLED) === 'true';
    if (!enabled) {
      this.logger.debug('Scheduler tick skipped — SCHEDULER_ENABLED!=true');
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
      this.logger.log(
        `Scheduler tick skipped — quiet hours (${quietStart}-${quietEnd} ${tz})`,
      );
      return;
    }

    const category = this.rotator.pick();
    if (!category) {
      this.logger.warn(
        'Scheduler tick skipped — no category available from rotator',
      );
      return;
    }

    const startedAt = Date.now();
    this.logger.log(`Scheduler tick start — category=${category}`);
    try {
      const result = await this.pipeline.runOnce({ category });
      const ms = Date.now() - startedAt;
      this.logger.log(
        `Scheduler tick done — category=${category} sent=${result.sent} took=${ms}ms`,
      );
    } catch (err) {
      const ms = Date.now() - startedAt;
      this.logger.error(
        `Scheduler tick failed — category=${category} took=${ms}ms: ${(err as Error).message}`,
        (err as Error).stack,
      );
    }
  }
}
