import { Module } from '@nestjs/common';
import { DedupModule } from '../dedup/dedup.module';
import { MetricsModule } from '../metrics/metrics.module';
import { PipelineModule } from '../pipeline/pipeline.module';
import { WhatsappModule } from '../whatsapp/wa.module';
import { SendDealWorker } from './send-deal.worker';

@Module({
  imports: [WhatsappModule, PipelineModule, DedupModule, MetricsModule],
  providers: [SendDealWorker],
})
export class WorkerModule {}
