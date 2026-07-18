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

export interface CalibrationStats {
  periodDays: number;
  approved: number;
  rejected: number;
  expired: number;
  avgApprovedScore: number | null;
  avgRejectedScore: number | null;
}

export interface CurationDecisionRepo {
  upsert(d: DecisionUpsert): Promise<void>;
  pruneOlderThan(cutoff: Date): Promise<number>;
  getCalibrationStats(days: number): Promise<CalibrationStats>;
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

  async getCalibrationStats(days: number): Promise<CalibrationStats> {
    const dateFrom = new Date();
    dateFrom.setDate(dateFrom.getDate() - days);

    // Threshold calibration reflects HUMAN decisions on algorithmically-scored
    // deals only. The gate files its automated drops under their own stages
    // (dedup, score_min, fake_discount, judge, …) and manual deals under
    // 'approval_manual'; counting those would swamp the panel with hundreds of
    // dedup rejections and never show a single human approval. Restrict to the
    // 'approval' stage — the one the panel's approve/reject/expire path writes.
    const stats = await (this.prisma as any).curationDecision.groupBy({
      by: ['outcome'],
      _sum: { count: true },
      _avg: { score: true },
      where: {
        firstAt: { gte: dateFrom },
        stage: 'approval',
      },
    });

    const result: CalibrationStats = {
      periodDays: days,
      approved: 0,
      rejected: 0,
      expired: 0,
      avgApprovedScore: null,
      avgRejectedScore: null,
    };

    for (const row of stats) {
      const sumCount = row._sum.count ?? 0;
      const avgScore = row._avg.score !== null ? Math.round(row._avg.score) : null;

      if (row.outcome === 'approved') {
        result.approved += sumCount;
        if (avgScore !== null) result.avgApprovedScore = avgScore;
      } else if (row.outcome === 'rejected') {
        result.rejected += sumCount;
        if (avgScore !== null) result.avgRejectedScore = avgScore;
      } else if (row.outcome === 'expired') {
        result.expired += sumCount;
      }
    }

    return result;
  }
}
