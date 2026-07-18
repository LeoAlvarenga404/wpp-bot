import { Injectable } from '@nestjs/common';
import { PrismaService } from '../db/prisma.service';

export interface HistoryItem {
  id: string;
  catalogId: string;
  targetJid: string;
  caption: string;
  variant: string | null;
  score: number | null;
  sentAt: Date;
}

@Injectable()
export class HistoryService {
  constructor(private readonly prisma: PrismaService) {}

  async listHistory(page: number, limit: number): Promise<{ items: HistoryItem[]; total: number }> {
    const skip = (page - 1) * limit;

    const [messages, total] = await Promise.all([
      (this.prisma as any).sentMessage.findMany({
        orderBy: { sentAt: 'desc' },
        skip,
        take: limit,
      }),
      (this.prisma as any).sentMessage.count(),
    ]);

    if (messages.length === 0) {
      return { items: [], total };
    }

    const catalogIds = [...new Set(messages.map((m: any) => m.catalogId))];

    const decisions = await (this.prisma as any).curationDecision.findMany({
      where: { catalogId: { in: catalogIds } },
      orderBy: { lastAt: 'desc' },
    });

    const scoreMap = new Map<string, number | null>();
    for (const d of decisions) {
      if (d.score !== null && d.score !== undefined) {
        if (!scoreMap.has(d.catalogId)) {
          scoreMap.set(d.catalogId, d.score);
        }
      }
    }

    const items: HistoryItem[] = messages.map((m: any) => ({
      id: m.id.toString(),
      catalogId: m.catalogId,
      targetJid: m.targetJid,
      caption: m.caption,
      variant: m.variant,
      score: scoreMap.get(m.catalogId) ?? null,
      sentAt: m.sentAt,
    }));

    return { items, total };
  }
}
