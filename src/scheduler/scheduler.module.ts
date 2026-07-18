import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { MercadoLivreModule } from '../mercado-livre/ml.module';
import { OpsConfigModule } from '../ops-config/ops-config.module';
import { PipelineModule } from '../pipeline/pipeline.module';
import { SchedulerService } from './scheduler.service';
import { TokenRefresherService } from './token-refresher.service';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    PipelineModule,
    MercadoLivreModule,
    OpsConfigModule,
  ],
  providers: [SchedulerService, TokenRefresherService],
  exports: [SchedulerService, TokenRefresherService],
})
export class SchedulerModule {}
