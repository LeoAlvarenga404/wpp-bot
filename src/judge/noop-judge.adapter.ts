import { Injectable } from '@nestjs/common';
import type { DealJudge, JudgeVerdict } from './judge.port';

/**
 * Active when JUDGE_ENABLED=false or DEEPSEEK_API_KEY is missing:
 * gray zone rejects by design (fail-closed).
 */
@Injectable()
export class NoopJudge implements DealJudge {
  async judge(): Promise<JudgeVerdict> {
    return {
      approve: false,
      confidence: 1,
      reason: 'judge disabled (JUDGE_ENABLED=false or DEEPSEEK_API_KEY missing)',
    };
  }
}
