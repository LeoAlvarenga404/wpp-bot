import { Injectable } from '@nestjs/common';
import { PrismaService } from '../db/prisma.service';
import { WaTarget } from './targets.service';

export const TARGETS_REPO = Symbol('TARGETS_REPO');

export interface TargetsRepo {
  findAll(): Promise<WaTarget[]>;
  findOne(jid: string): Promise<WaTarget | null>;
  upsert(t: WaTarget): Promise<WaTarget>;
  delete(jid: string): Promise<boolean>;
  count(): Promise<number>;
  importMany(targets: WaTarget[]): Promise<void>;
}

@Injectable()
export class PrismaTargetsRepo implements TargetsRepo {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(): Promise<WaTarget[]> {
    const rows = await (this.prisma as any).waTarget.findMany();
    return rows.map((r: any) => ({
      jid: r.jid,
      name: r.name ?? r.jid,
      active: r.active,
    }));
  }

  async findOne(jid: string): Promise<WaTarget | null> {
    const r = await (this.prisma as any).waTarget.findUnique({ where: { jid } });
    return r ? { jid: r.jid, name: r.name ?? r.jid, active: r.active } : null;
  }

  async upsert(t: WaTarget): Promise<WaTarget> {
    const r = await (this.prisma as any).waTarget.upsert({
      where: { jid: t.jid },
      create: { jid: t.jid, name: t.name, active: t.active },
      update: { name: t.name, active: t.active },
    });
    return { jid: r.jid, name: r.name ?? r.jid, active: r.active };
  }

  async delete(jid: string): Promise<boolean> {
    const res = await (this.prisma as any).waTarget.deleteMany({ where: { jid } });
    return (res.count as number) > 0;
  }

  async count(): Promise<number> {
    return (this.prisma as any).waTarget.count();
  }

  async importMany(targets: WaTarget[]): Promise<void> {
    if (targets.length === 0) return;
    await (this.prisma as any).waTarget.createMany({
      data: targets,
      skipDuplicates: true,
    });
  }
}
