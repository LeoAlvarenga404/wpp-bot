import { Module } from '@nestjs/common';
import { DedupService } from './dedup.service';

@Module({
  providers: [DedupService],
  exports: [DedupService],
})
export class DedupModule {}
