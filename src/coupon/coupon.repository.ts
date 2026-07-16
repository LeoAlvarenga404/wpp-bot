import { Injectable } from '@nestjs/common';
import { PrismaService } from '../db/prisma.service';
import type { Coupon, CouponScope, CouponType } from './coupon.types';

function toDomain(row: {
  id: string;
  code: string;
  scope: string;
  targetId: string;
  type: string;
  value: number;
  capCents: number | null;
  minCents: number | null;
  firstBuy: boolean;
  perUser: boolean;
  validUntil: Date;
  active: boolean;
  affiliateSafe: boolean;
}): Coupon {
  return {
    id: row.id,
    code: row.code,
    scope: row.scope as CouponScope,
    targetId: row.targetId,
    type: row.type as CouponType,
    value: row.value,
    capCents: row.capCents,
    minCents: row.minCents,
    firstBuy: row.firstBuy,
    perUser: row.perUser,
    validUntil: row.validUntil,
    active: row.active,
    affiliateSafe: row.affiliateSafe,
  };
}

@Injectable()
export class CouponRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Active, unexpired coupons matching this deal's seller or product. */
  async findMatching(
    sellerId: string | null,
    productId: string,
    now: Date,
  ): Promise<Coupon[]> {
    const or: Array<{ scope: string; targetId: string }> = [
      { scope: 'PRODUCT', targetId: productId },
    ];
    if (sellerId) or.push({ scope: 'SELLER', targetId: sellerId });
    const rows = await (this.prisma as any).coupon.findMany({
      where: { active: true, validUntil: { gt: now }, OR: or },
    });
    return rows.map(toDomain);
  }

  async create(data: Omit<Coupon, 'id'>): Promise<Coupon> {
    const row = await (this.prisma as any).coupon.create({ data });
    return toDomain(row);
  }
}
