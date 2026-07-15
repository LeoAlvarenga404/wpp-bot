import { Injectable } from '@nestjs/common';
import { PrismaService } from '../db/prisma.service';

export const CURATION_REPO = Symbol('CURATION_REPO');

export interface PriceRow {
  catalogId: string;
  priceCents: number;
  capturedAt: Date;
}

export interface CurationRepo {
  loadAll(sinceDays: number): Promise<PriceRow[]>;
  insert(row: PriceRow): Promise<void>;
  pruneOlderThan(cutoff: Date): Promise<number>;
  count(): Promise<number>;
  importMany(rows: PriceRow[]): Promise<void>;
}

@Injectable()
export class PrismaCurationRepo implements CurationRepo {
  constructor(private readonly prisma: PrismaService) {}

  async loadAll(sinceDays: number): Promise<PriceRow[]> {
    const cutoff = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);
    const rows = await (this.prisma as any).priceHistory.findMany({
      where: { capturedAt: { gte: cutoff } },
      orderBy: { capturedAt: 'asc' },
    });
    return rows.map((r: any) => ({
      catalogId: r.catalogId as string,
      priceCents: r.priceCents as number,
      capturedAt: r.capturedAt as Date,
    }));
  }

  async insert(row: PriceRow): Promise<void> {
    await (this.prisma as any).priceHistory.create({
      data: {
        catalogId: row.catalogId,
        priceCents: row.priceCents,
        capturedAt: row.capturedAt,
      },
    });
  }

  async pruneOlderThan(cutoff: Date): Promise<number> {
    const res = await (this.prisma as any).priceHistory.deleteMany({
      where: { capturedAt: { lt: cutoff } },
    });
    return res.count as number;
  }

  async count(): Promise<number> {
    return (this.prisma as any).priceHistory.count();
  }

  async importMany(rows: PriceRow[]): Promise<void> {
    if (rows.length === 0) return;
    // createMany in chunks of 1000 to avoid hitting parameter limits on large
    // backfills from price-history.json.
    for (let i = 0; i < rows.length; i += 1000) {
      const chunk = rows.slice(i, i + 1000);
      await (this.prisma as any).priceHistory.createMany({ data: chunk });
    }
  }
}
