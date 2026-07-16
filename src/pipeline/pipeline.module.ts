import { Module } from '@nestjs/common';
import { AffiliateModule } from '../affiliate/affiliate.module';
import { AuthModule } from '../auth/auth.module';
import { CouponModule } from '../coupon/coupon.module';
import { CurationModule } from '../curation/curation.module';
import { DealScoreModule } from '../deal-score/deal-score.module';
import { DedupModule } from '../dedup/dedup.module';
import { HeadlineModule } from '../headline/headline.module';
import { MercadoLivreModule } from '../mercado-livre/ml.module';
import { MetricsModule } from '../metrics/metrics.module';
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
    HeadlineModule,
    AuthModule,
    DealScoreModule,
    MetricsModule,
    CouponModule,
  ],
  controllers: [PipelineController],
  providers: [PipelineService, FormatterService],
  exports: [PipelineService, FormatterService],
})
export class PipelineModule {}
