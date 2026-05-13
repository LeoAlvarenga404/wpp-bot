import { Module } from '@nestjs/common';
import { CommandHandler } from './command.handler';
import { OptoutService } from './optout.service';
import { RateLimiterService } from './rate-limiter.service';
import { TargetsService } from './targets.service';
import { WaHealthController } from './wa-health.controller';
import { WhatsappService } from './wa.service';

@Module({
  providers: [
    WhatsappService,
    RateLimiterService,
    TargetsService,
    CommandHandler,
    OptoutService,
  ],
  controllers: [WaHealthController],
  exports: [WhatsappService, TargetsService, OptoutService],
})
export class WhatsappModule {}
