import { Injectable } from '@nestjs/common';
import { PrismaService } from '../db/prisma.service';
import { DedupRepo } from './dedup.repo';

@Injectable()
export class PrismaDedupRepo implements DedupRepo {
  constructor(private readonly prisma: PrismaService) {}

  async markPosted(catalogId: string, postedAt: Date): Promise<void> {
    await (this.prisma as any).dedupEntry.upsert({
      where: { catalogId },
      create: { catalogId, postedAt },
      update: { postedAt },
    });
  }

  async getPostedAt(catalogId: string): Promise<Date | null> {
    const row = await (this.prisma as any).dedupEntry.findUnique({
      where: { catalogId },
    });
    return row ? (row.postedAt as Date) : null;
  }

  async pruneOlderThan(cutoff: Date): Promise<number> {
    const res = await (this.prisma as any).dedupEntry.deleteMany({
      where: { postedAt: { lt: cutoff } },
    });
    return res.count as number;
  }

  async count(): Promise<number> {
    return (this.prisma as any).dedupEntry.count();
  }

  async importMany(
    entries: Array<{ catalogId: string; postedAt: Date }>,
  ): Promise<void> {
    if (entries.length === 0) return;
    await (this.prisma as any).dedupEntry.createMany({
      data: entries,
      skipDuplicates: true,
    });
  }
}
