import { Module } from '@nestjs/common';
import { AffiliateModule } from '../affiliate/affiliate.module';
import { AuthModule } from '../auth/auth.module';
import { CurationModule } from '../curation/curation.module';
import { DedupModule } from '../dedup/dedup.module';
import { MercadoLivreModule } from '../mercado-livre/ml.module';
import { WhatsappModule } from '../whatsapp/wa.module';
import { FormatterService } from './formatter.service';
import { PipelineController } from './pipeline.controller';
import { PipelineService } from './pipeline.service';

@Module({
  imports: [
    MercadoLivreModule,
    WhatsappModule,
    AffiliateModule,
    DedupModule,
    CurationModule,
    AuthModule,
  ],
  controllers: [PipelineController],
  providers: [PipelineService, FormatterService],
  exports: [PipelineService],
})
export class PipelineModule {}
