import { existsSync } from 'fs';
import { join } from 'path';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ServeStaticModule } from '@nestjs/serve-static';
import { AffiliateModule } from './affiliate/affiliate.module';
import { CouponModule } from './coupon/coupon.module';
import { ApprovalModule } from './curation/approval.module';
import { DbModule } from './db/db.module';
import { DedupModule } from './dedup/dedup.module';
import { MercadoLivreModule } from './mercado-livre/ml.module';
import { MetricsModule } from './metrics/metrics.module';
import { OpsConfigModule } from './ops-config/ops-config.module';
import { PipelineModule } from './pipeline/pipeline.module';
import { QueueModule } from './queue/queue.module';
import { RedirectModule } from './redirect/redirect.module';
import { SchedulerModule } from './scheduler/scheduler.module';
import { SharedLoggerModule } from './shared/logger.module';
import { SourcesModule } from './sources/sources.module';
import { WhatsappModule } from './whatsapp/wa.module';
import { WorkerModule } from './worker/worker.module';
import { HistoryModule } from './history/history.module';

// Curation panel SPA (web/dist, built by Vite). Registered only when the
// build output exists so test bootstraps and API-only deployments don't
// require a frontend build. ServeStatic mounts its catch-all during
// onModuleInit — after every controller route — so API endpoints always win.
const panelDist = join(process.cwd(), 'web', 'dist');
const panelModule = existsSync(panelDist)
  ? [ServeStaticModule.forRoot({ rootPath: panelDist })]
  : [];

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
    OpsConfigModule,
    RedirectModule,
    PipelineModule,
    ApprovalModule,
    WorkerModule,
    SchedulerModule,
    MetricsModule,
    HistoryModule,
    ...panelModule,
  ],
})
export class AppModule {}
