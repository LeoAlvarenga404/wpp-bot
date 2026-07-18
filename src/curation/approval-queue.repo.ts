import { Injectable } from '@nestjs/common';
import { PrismaService } from '../db/prisma.service';

export const APPROVAL_QUEUE_REPO = Symbol('APPROVAL_QUEUE_REPO');

export type PendingDealStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';

export interface PendingDealRow {
  id: string;
  catalogId: string;
  status: PendingDealStatus;
  score: number;
  /** Full ScoredDeal JSON captured at dispatch time (see ApprovalQueueService). */
  snapshot: unknown;
  expiresAt: Date;
  createdAt: Date;
  decidedAt: Date | null;
}

/** What dispatch writes for a held deal — both on create and on refresh. */
export interface PendingUpsert {
  score: number;
  snapshot: unknown;
  expiresAt: Date;
}

export interface ApprovalQueueRepo {
  create(d: PendingUpsert & { catalogId: string }): Promise<PendingDealRow>;
  refresh(id: string, d: PendingUpsert): Promise<void>;
  findById(id: string): Promise<PendingDealRow | null>;
  findPendingByCatalogId(catalogId: string): Promise<PendingDealRow | null>;
  listPending(): Promise<PendingDealRow[]>;
  findExpiredPending(now: Date): Promise<PendingDealRow[]>;
  markDecided(
    id: string,
    status: PendingDealStatus,
    decidedAt: Date,
  ): Promise<void>;
}

@Injectable()
export class PrismaApprovalQueueRepo implements ApprovalQueueRepo {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    d: PendingUpsert & { catalogId: string },
  ): Promise<PendingDealRow> {
    return (await (this.prisma as any).pendingDeal.create({
      data: {
        catalogId: d.catalogId,
        score: d.score,
        snapshot: d.snapshot as any,
        expiresAt: d.expiresAt,
      },
    })) as PendingDealRow;
  }

  async refresh(id: string, d: PendingUpsert): Promise<void> {
    await (this.prisma as any).pendingDeal.update({
      where: { id },
      data: {
        score: d.score,
        snapshot: d.snapshot as any,
        expiresAt: d.expiresAt,
      },
    });
  }

  async findById(id: string): Promise<PendingDealRow | null> {
    return (await (this.prisma as any).pendingDeal.findUnique({
      where: { id },
    })) as PendingDealRow | null;
  }

  async findPendingByCatalogId(
    catalogId: string,
  ): Promise<PendingDealRow | null> {
    return (await (this.prisma as any).pendingDeal.findFirst({
      where: { catalogId, status: 'PENDING' },
    })) as PendingDealRow | null;
  }

  async listPending(): Promise<PendingDealRow[]> {
    return (await (this.prisma as any).pendingDeal.findMany({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
    })) as PendingDealRow[];
  }

  async findExpiredPending(now: Date): Promise<PendingDealRow[]> {
    return (await (this.prisma as any).pendingDeal.findMany({
      where: { status: 'PENDING', expiresAt: { lte: now } },
    })) as PendingDealRow[];
  }

  async markDecided(
    id: string,
    status: PendingDealStatus,
    decidedAt: Date,
  ): Promise<void> {
    await (this.prisma as any).pendingDeal.update({
      where: { id },
      data: { status, decidedAt },
    });
  }
}
