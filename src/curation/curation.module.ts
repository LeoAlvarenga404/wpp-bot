import { Module } from '@nestjs/common';
import { CURATION_REPO, PrismaCurationRepo } from './curation.repo';
import { CurationService } from './curation.service';

@Module({
  providers: [
    PrismaCurationRepo,
    { provide: CURATION_REPO, useExisting: PrismaCurationRepo },
    CurationService,
  ],
  exports: [CurationService],
})
export class CurationModule {}
