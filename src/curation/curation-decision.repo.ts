import { Injectable } from '@nestjs/common';
import { PrismaService } from '../db/prisma.service';

export const CURATION_DECISION_REPO = Symbol('CURATION_DECISION_REPO');

export interface DecisionUpsert {
  catalogId: string;
  stage: string;
  outcome: 'rejected' | 'approved' | 'posted' | 'expired';
  day: string;
  score?: number;
  priceCents?: number;
  reasons?: unknown;
  judgeVerdict?: unknown;
  variant?: string;
  /** CuratorEdits JSON for panel approvals with light edits (issue #6). */
  edits?: unknown;
}

export interface CurationDecisionRepo {
  upsert(d: DecisionUpsert): Promise<void>;
  pruneOlderThan(cutoff: Date): Promise<number>;
}

@Injectable()
export class PrismaCurationDecisionRepo implements CurationDecisionRepo {
  constructor(private readonly prisma: PrismaService) {}

  async upsert(d: DecisionUpsert): Promise<void> {
    const fields = {
      outcome: d.outcome,
      score: d.score ?? null,
      priceCents: d.priceCents ?? null,
      reasons: (d.reasons as any) ?? undefined,
      judgeVerdict: (d.judgeVerdict as any) ?? undefined,
      variant: d.variant ?? null,
      edits: (d.edits as any) ?? undefined,
    };
    await (this.prisma as any).curationDecision.upsert({
      where: {
        catalogId_stage_day: {
          catalogId: d.catalogId,
          stage: d.stage,
          day: d.day,
        },
      },
      create: { catalogId: d.catalogId, stage: d.stage, day: d.day, ...fields },
      update: { count: { increment: 1 }, ...fields },
    });
  }

  async pruneOlderThan(cutoff: Date): Promise<number> {
    const res = await (this.prisma as any).curationDecision.deleteMany({
      where: { firstAt: { lt: cutoff } },
    });
    return res.count as number;
  }
}
