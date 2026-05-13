import { Module } from '@nestjs/common';
import { AffiliateModule } from '../affiliate/affiliate.module';
import { MercadoLivreModule } from '../mercado-livre/ml.module';
import { WhatsappModule } from '../whatsapp/wa.module';
import { FormatterService } from './formatter.service';
import { PipelineController } from './pipeline.controller';
import { PipelineService } from './pipeline.service';

@Module({
  imports: [MercadoLivreModule, WhatsappModule, AffiliateModule],
  controllers: [PipelineController],
  providers: [PipelineService, FormatterService],
})
export class PipelineModule {}
