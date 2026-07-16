import { Global, Module } from '@nestjs/common';
import { MetricsModule } from '../metrics/metrics.module';
import { RedirectController } from './redirect.controller';
import { RedirectService } from './redirect.service';

// @Global so FormatterService (PipelineModule) can optionally inject
// RedirectService without PipelineModule having to import this module.
// PrismaService is provided globally by DbModule.
@Global()
@Module({
  imports: [MetricsModule],
  controllers: [RedirectController],
  providers: [RedirectService],
  exports: [RedirectService],
})
export class RedirectModule {}
