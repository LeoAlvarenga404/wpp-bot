import { Module } from '@nestjs/common';
import { DealScoreService } from './deal-score.service';

@Module({
  providers: [DealScoreService],
  exports: [DealScoreService],
})
export class DealScoreModule {}
