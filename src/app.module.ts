import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AffiliateModule } from './affiliate/affiliate.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DedupModule } from './dedup/dedup.module';
import { MercadoLivreModule } from './mercado-livre/ml.module';
import { MetricsModule } from './metrics/metrics.module';
import { PipelineModule } from './pipeline/pipeline.module';
import { SchedulerModule } from './scheduler/scheduler.module';
import { SharedLoggerModule } from './shared/logger.module';
import { WhatsappModule } from './whatsapp/wa.module';

// DbModule (Prisma) intentionally NOT registered here. Enable it manually
// after provisioning Postgres + running `npm run prisma:generate` and
// `npm run prisma:migrate:dev`. See deploy/README.md.

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    SharedLoggerModule,
    MercadoLivreModule,
    WhatsappModule,
    AffiliateModule,
    DedupModule,
    PipelineModule,
    SchedulerModule,
    MetricsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
