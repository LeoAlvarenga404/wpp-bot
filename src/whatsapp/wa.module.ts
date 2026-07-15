import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MetricsModule } from '../metrics/metrics.module';
import { CommandHandler } from './command.handler';
import { OPTOUT_REPO, PrismaOptoutRepo } from './optout.repo';
import { OptoutService } from './optout.service';
import { RATE_LIMITER_REPO, PrismaRateLimiterRepo } from './rate-limiter.repo';
import { RateLimiterService } from './rate-limiter.service';
import { TARGETS_REPO, PrismaTargetsRepo } from './targets.repo';
import { TargetsService } from './targets.service';
import { WaHealthController } from './wa-health.controller';
import { WhatsappService } from './wa.service';

@Module({
  imports: [AuthModule, MetricsModule],
  providers: [
    WhatsappService,
    PrismaRateLimiterRepo,
    { provide: RATE_LIMITER_REPO, useExisting: PrismaRateLimiterRepo },
    RateLimiterService,
    PrismaTargetsRepo,
    { provide: TARGETS_REPO, useExisting: PrismaTargetsRepo },
    TargetsService,
    PrismaOptoutRepo,
    { provide: OPTOUT_REPO, useExisting: PrismaOptoutRepo },
    OptoutService,
    CommandHandler,
  ],
  controllers: [WaHealthController],
  exports: [WhatsappService, TargetsService, OptoutService],
})
export class WhatsappModule {}
