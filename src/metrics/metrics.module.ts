import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CountersService } from './counters.service';
import { MetricsController } from './metrics.controller';

@Module({
  imports: [AuthModule],
  providers: [CountersService],
  controllers: [MetricsController],
  exports: [CountersService],
})
export class MetricsModule {}
