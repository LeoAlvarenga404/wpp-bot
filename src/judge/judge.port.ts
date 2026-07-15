export const DEAL_JUDGE = Symbol('DEAL_JUDGE');

export interface JudgeVerdict {
  approve: boolean;
  confidence: number; // 0..1
  reason: string; // 1 frase — persiste em CurationDecision.judgeVerdict
}

export interface JudgeInput {
  title: string;
  priceCents: number;
  originalPriceCents: number | null;
  discountPercent: number;
  condition: string;
  score: number;
  level: string;
  reasons: string[];
  penalties: string[];
  priceRaiseSuspicious: boolean;
  analytics: {
    median30d: number | null;
    min30d: number | null;
    min14d: number | null;
    min7d: number | null;
    distinctDays: number;
    trend: string;
  };
  seller: {
    trust: string;
    isVerifiedStore: boolean;
    displayName: string | null;
  } | null;
  volumeTier: string;
}

export interface DealJudge {
  judge(input: JudgeInput): Promise<JudgeVerdict>;
}
