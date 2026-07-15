import { Injectable } from '@nestjs/common';
import { PrismaService } from '../db/prisma.service';

export const RATE_LIMITER_REPO = Symbol('RATE_LIMITER_REPO');

export interface WaCounterRow {
  id: string;
  bucket: string;
  count: number;
}

export interface RateLimiterRepo {
  loadAll(): Promise<WaCounterRow[]>;
  upsert(id: string, bucket: string, count: number): Promise<void>;
  deleteMany(ids: string[]): Promise<number>;
  count(): Promise<number>;
  importMany(rows: WaCounterRow[]): Promise<void>;
}

@Injectable()
export class PrismaRateLimiterRepo implements RateLimiterRepo {
  constructor(private readonly prisma: PrismaService) {}

  async loadAll(): Promise<WaCounterRow[]> {
    const rows = await (this.prisma as any).waCounter.findMany();
    return rows.map((r: any) => ({
      id: r.id as string,
      bucket: r.bucket as string,
      count: r.count as number,
    }));
  }

  async upsert(id: string, bucket: string, count: number): Promise<void> {
    await (this.prisma as any).waCounter.upsert({
      where: { id },
      create: { id, bucket, count },
      update: { count },
    });
  }

  async deleteMany(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const res = await (this.prisma as any).waCounter.deleteMany({
      where: { id: { in: ids } },
    });
    return res.count as number;
  }

  async count(): Promise<number> {
    return (this.prisma as any).waCounter.count();
  }

  async importMany(rows: WaCounterRow[]): Promise<void> {
    if (rows.length === 0) return;
    await (this.prisma as any).waCounter.createMany({
      data: rows,
      skipDuplicates: true,
    });
  }
}
