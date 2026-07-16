import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MetricsModule } from '../metrics/metrics.module';
import { HeadlineCacheService } from './headline-cache.service';
import { HeadlineConfigService } from './headline-config.service';
import { HEADLINE_GENERATOR } from './headline.port';
import type { HeadlineGenerator } from './headline.port';
import { DeepSeekHeadlineAdapter } from './deepseek-headline.adapter';
import { NoopHeadlineAdapter } from './noop-headline.adapter';

@Module({
  imports: [MetricsModule],
  providers: [
    HeadlineCacheService,
    HeadlineConfigService,
    NoopHeadlineAdapter,
    DeepSeekHeadlineAdapter,
    {
      provide: HEADLINE_GENERATOR,
      inject: [ConfigService, NoopHeadlineAdapter, DeepSeekHeadlineAdapter],
      useFactory: (
        config: ConfigService,
        noop: NoopHeadlineAdapter,
        deepseek: DeepSeekHeadlineAdapter,
      ): HeadlineGenerator => {
        const provider = (
          config.get<string>('HEADLINE_PROVIDER', 'deepseek') ?? 'deepseek'
        )
          .toLowerCase()
          .trim();
        const logger = new Logger('HeadlineModule');
        if (provider === 'noop') {
          logger.log('Headline provider: noop (static hook pool)');
          return noop;
        }
        if (provider === 'deepseek') {
          if (!config.get<string>('DEEPSEEK_API_KEY')) {
            logger.warn(
              'HEADLINE_PROVIDER=deepseek but DEEPSEEK_API_KEY missing — falling back to noop',
            );
            return noop;
          }
          logger.log('Headline provider: deepseek');
          return deepseek;
        }
        logger.warn(
          `Unknown HEADLINE_PROVIDER=${provider} — falling back to noop`,
        );
        return noop;
      },
    },
  ],
  exports: [HEADLINE_GENERATOR],
})
export class HeadlineModule {}
