import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DeepSeekJudgeAdapter } from './deepseek-judge.adapter';
import { DEAL_JUDGE } from './judge.port';
import { NoopJudge } from './noop-judge.adapter';
import { JudgeVerdictCache } from './verdict-cache';

@Module({
  providers: [
    NoopJudge,
    DeepSeekJudgeAdapter,
    // Factory: the cache constructor takes plain-number config with defaults,
    // which Nest would otherwise try (and fail) to inject as dependencies.
    { provide: JudgeVerdictCache, useFactory: () => new JudgeVerdictCache() },
    {
      provide: DEAL_JUDGE,
      useFactory: (
        config: ConfigService,
        deepseek: DeepSeekJudgeAdapter,
        noop: NoopJudge,
      ) => ((config.get<string>('DEEPSEEK_API_KEY') ?? '') ? deepseek : noop),
      inject: [ConfigService, DeepSeekJudgeAdapter, NoopJudge],
    },
  ],
  exports: [DEAL_JUDGE, JudgeVerdictCache],
})
export class JudgeModule {}
