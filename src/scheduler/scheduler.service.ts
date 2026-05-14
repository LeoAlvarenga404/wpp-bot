import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import type { ScoredDeal } from '../deal-score/types';
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
    const categories = this.rotator.getWeighted();
    if (categories.length === 0) {
      this.logger.warn(
        'Scheduler tick (batch) skipped — no categories configured',
      );
      return;
    }
    const enrichTopN = Number(
      this.config.get<string>('DEAL_ENRICH_TOP_N', '10'),
    );
    const minDiscount = Number(
      this.config.get<string>('ML_MIN_DISCOUNT', '25'),
    );
    const maxDeals = Number(this.config.get<string>('MAX_DEALS_PER_RUN', '3'));

    const startedAt = Date.now();
    const allScored: ScoredDeal[] = [];
    for (const { category } of categories) {
      const t0 = Date.now();
      try {
        const scored = await this.pipeline.collectScored(category, {
          minDiscount,
          enrichTopN,
        });
        allScored.push(...scored);
        this.logger.log(
          `batch collect ${category}: ${scored.length} passing (${Date.now() - t0}ms)`,
        );
      } catch (err) {
        this.logger.error(
          `batch collect ${category} failed: ${(err as Error).message}`,
        );
      }
    }

    allScored.sort((a, b) => b.score - a.score);
    try {
      const dispatch = await this.pipeline.dispatchScored(allScored, maxDeals);
      const ms = Date.now() - startedAt;
      this.logger.log(
        `Scheduler tick batch — categories=${categories.length} ` +
          `totalScored=${allScored.length} dispatched=${dispatch.sent} ` +
          `failed=${dispatch.failed} topScore=${dispatch.topScore ?? 'n/a'} took=${ms}ms`,
      );
    } catch (err) {
      const ms = Date.now() - startedAt;
      this.logger.error(
        `Scheduler tick batch dispatch failed — took=${ms}ms: ${(err as Error).message}`,
        (err as Error).stack,
      );
    }
  }

  private async tickLegacy(): Promise<void> {
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
