import { Module } from '@nestjs/common';
import { CurationService } from './curation.service';

@Module({
  providers: [CurationService],
  exports: [CurationService],
})
export class CurationModule {}
