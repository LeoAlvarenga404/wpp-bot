import { Module } from '@nestjs/common';
import { DedupModule } from '../dedup/dedup.module';
import { JudgeModule } from '../judge/judge.module';
import { MetricsModule } from '../metrics/metrics.module';
import {
  CURATION_DECISION_REPO,
  PrismaCurationDecisionRepo,
} from './curation-decision.repo';
import { CurationGateService } from './curation-gate.service';
import { CURATION_REPO, PrismaCurationRepo } from './curation.repo';
import { CurationService } from './curation.service';
import { CalibrationController } from './calibration.controller';

@Module({
  imports: [DedupModule, JudgeModule, MetricsModule],
  controllers: [CalibrationController],
  providers: [
    PrismaCurationRepo,
    { provide: CURATION_REPO, useExisting: PrismaCurationRepo },
    PrismaCurationDecisionRepo,
    {
      provide: CURATION_DECISION_REPO,
      useExisting: PrismaCurationDecisionRepo,
    },
    CurationService,
    CurationGateService,
  ],
  // CURATION_DECISION_REPO is exported for ApprovalModule (same audit table,
  // new 'approval' stage).
  exports: [CurationService, CurationGateService, CURATION_DECISION_REPO],
})
export class CurationModule {}
