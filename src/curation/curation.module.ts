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

@Module({
  imports: [DedupModule, JudgeModule, MetricsModule],
  providers: [
    PrismaCurationRepo,
    { provide: CURATION_REPO, useExisting: PrismaCurationRepo },
    PrismaCurationDecisionRepo,
    { provide: CURATION_DECISION_REPO, useExisting: PrismaCurationDecisionRepo },
    CurationService,
    CurationGateService,
  ],
  exports: [CurationService, CurationGateService],
})
export class CurationModule {}
