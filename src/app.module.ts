import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AffiliateModule } from './affiliate/affiliate.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { CouponModule } from './coupon/coupon.module';
import { DbModule } from './db/db.module';
import { DedupModule } from './dedup/dedup.module';
import { MercadoLivreModule } from './mercado-livre/ml.module';
import { MetricsModule } from './metrics/metrics.module';
import { PipelineModule } from './pipeline/pipeline.module';
import { QueueModule } from './queue/queue.module';
import { RedirectModule } from './redirect/redirect.module';
import { SchedulerModule } from './scheduler/scheduler.module';
import { SharedLoggerModule } from './shared/logger.module';
import { SourcesModule } from './sources/sources.module';
import { WhatsappModule } from './whatsapp/wa.module';
import { WorkerModule } from './worker/worker.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    SharedLoggerModule,
    DbModule,
    QueueModule,
    SourcesModule,
    MercadoLivreModule,
    WhatsappModule,
    AffiliateModule,
    DedupModule,
    CouponModule,
    RedirectModule,
    PipelineModule,
    WorkerModule,
    SchedulerModule,
    MetricsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
