import { Injectable } from '@nestjs/common';
import { PrismaService } from '../db/prisma.service';

export const OPTOUT_REPO = Symbol('OPTOUT_REPO');

export interface OptoutRepo {
  has(jid: string): Promise<boolean>;
  list(): Promise<string[]>;
  add(jid: string): Promise<void>;
  remove(jid: string): Promise<boolean>;
  count(): Promise<number>;
  importMany(jids: string[]): Promise<void>;
}

@Injectable()
export class PrismaOptoutRepo implements OptoutRepo {
  constructor(private readonly prisma: PrismaService) {}

  async has(jid: string): Promise<boolean> {
    const r = await (this.prisma as any).waOptout.findUnique({ where: { jid } });
    return !!r;
  }

  async list(): Promise<string[]> {
    const rows = await (this.prisma as any).waOptout.findMany();
    return rows.map((r: any) => r.jid as string);
  }

  async add(jid: string): Promise<void> {
    await (this.prisma as any).waOptout.upsert({
      where: { jid },
      create: { jid },
      update: {},
    });
  }

  async remove(jid: string): Promise<boolean> {
    const res = await (this.prisma as any).waOptout.deleteMany({ where: { jid } });
    return (res.count as number) > 0;
  }

  async count(): Promise<number> {
    return (this.prisma as any).waOptout.count();
  }

  async importMany(jids: string[]): Promise<void> {
    if (jids.length === 0) return;
    await (this.prisma as any).waOptout.createMany({
      data: jids.map((jid) => ({ jid })),
      skipDuplicates: true,
    });
  }
}
