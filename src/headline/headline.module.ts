import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HeadlineCacheService } from './headline-cache.service';
import { HEADLINE_GENERATOR } from './headline.port';
import type { HeadlineGenerator } from './headline.port';
import { GroqHeadlineAdapter } from './groq-headline.adapter';
import { NoopHeadlineAdapter } from './noop-headline.adapter';

@Module({
  providers: [
    HeadlineCacheService,
    NoopHeadlineAdapter,
    GroqHeadlineAdapter,
    {
      provide: HEADLINE_GENERATOR,
      inject: [ConfigService, NoopHeadlineAdapter, GroqHeadlineAdapter],
      useFactory: (
        config: ConfigService,
        noop: NoopHeadlineAdapter,
        groq: GroqHeadlineAdapter,
      ): HeadlineGenerator => {
        const provider = (
          config.get<string>('HEADLINE_PROVIDER', 'groq') ?? 'groq'
        )
          .toLowerCase()
          .trim();
        const logger = new Logger('HeadlineModule');
        if (provider === 'noop') {
          logger.log('Headline provider: noop (static hook pool)');
          return noop;
        }
        if (provider === 'groq') {
          if (!config.get<string>('GROQ_API_KEY')) {
            logger.warn(
              'HEADLINE_PROVIDER=groq but GROQ_API_KEY missing — falling back to noop',
            );
            return noop;
          }
          logger.log('Headline provider: groq');
          return groq;
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
