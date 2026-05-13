import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { MercadoLivreModule } from '../mercado-livre/ml.module';
import { PipelineModule } from '../pipeline/pipeline.module';
import { CategoryRotatorService } from './category-rotator.service';
import { SchedulerService } from './scheduler.service';
import { TokenRefresherService } from './token-refresher.service';

@Module({
  imports: [ScheduleModule.forRoot(), PipelineModule, MercadoLivreModule],
  providers: [SchedulerService, CategoryRotatorService, TokenRefresherService],
  exports: [SchedulerService, CategoryRotatorService, TokenRefresherService],
})
export class SchedulerModule {}
