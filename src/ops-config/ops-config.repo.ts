import { Injectable } from '@nestjs/common';
import { PrismaService } from '../db/prisma.service';

@Injectable()
export class OpsConfigRepo {
  constructor(private readonly prisma: PrismaService) {}

  async get(key: string): Promise<string | null> {
    const row = await (this.prisma as any).opsConfig.findUnique({
      where: { key },
    });
    return row?.value ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    await (this.prisma as any).opsConfig.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
  }

  async getAll(): Promise<Array<{ key: string; value: string }>> {
    const rows = await (this.prisma as any).opsConfig.findMany();
    return rows.map((r: { key: string; value: string }) => ({
      key: r.key,
      value: r.value,
    }));
  }
}
