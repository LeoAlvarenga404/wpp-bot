import { Module } from '@nestjs/common';
import { CouponModule } from '../coupon/coupon.module';
import { DbModule } from '../db/db.module';
import { DedupModule } from '../dedup/dedup.module';
import { OpsConfigModule } from '../ops-config/ops-config.module';
import { PipelineModule } from '../pipeline/pipeline.module';
import {
  APPROVAL_QUEUE_REPO,
  PrismaApprovalQueueRepo,
} from './approval-queue.repo';
import { ApprovalQueueService } from './approval-queue.service';
import { ApprovalController } from './approval.controller';
import { CurationModule } from './curation.module';

/**
 * Lives in the curation area but is a separate module from CurationModule:
 * ApprovalQueueService needs PipelineService (approve → enqueueScored), and
 * PipelineModule already imports CurationModule — folding this service into
 * CurationModule would create an import cycle.
 */
@Module({
  imports: [
    DbModule,
    PipelineModule,
    OpsConfigModule,
    CurationModule,
    CouponModule,
    DedupModule,
  ],
  controllers: [ApprovalController],
  providers: [
    PrismaApprovalQueueRepo,
    { provide: APPROVAL_QUEUE_REPO, useExisting: PrismaApprovalQueueRepo },
    ApprovalQueueService,
  ],
  exports: [ApprovalQueueService],
})
export class ApprovalModule {}
