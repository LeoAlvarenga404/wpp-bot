import { Module } from '@nestjs/common';
import { AffiliateModule } from '../affiliate/affiliate.module';
import { CouponModule } from '../coupon/coupon.module';
import { DedupModule } from '../dedup/dedup.module';
import { MetricsModule } from '../metrics/metrics.module';
import { PipelineModule } from '../pipeline/pipeline.module';
import { PublisherModule } from '../publisher/publisher.module';
import { SendDealWorker } from './send-deal.worker';

@Module({
  imports: [
    PublisherModule,
    PipelineModule,
    DedupModule,
    MetricsModule,
    // Stale-price re-check at send time: PRICE_SCRAPER_PORT + CouponService
    // (same providers the pipeline uses at enqueue time).
    AffiliateModule,
    CouponModule,
  ],
  providers: [SendDealWorker],
})
export class WorkerModule {}
