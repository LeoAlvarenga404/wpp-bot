import { Module } from '@nestjs/common';
import { DEDUP_REPO } from './dedup.repo';
import { DedupService } from './dedup.service';
import { PrismaDedupRepo } from './prisma-dedup.repo';

@Module({
  providers: [
    PrismaDedupRepo,
    { provide: DEDUP_REPO, useExisting: PrismaDedupRepo },
    DedupService,
  ],
  exports: [DedupService],
})
export class DedupModule {}
