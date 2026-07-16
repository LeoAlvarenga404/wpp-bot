import {
  BadRequestException,
  Body,
  Controller,
  Logger,
  Post,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { CouponRepository } from './coupon.repository';
import { CreateCouponDto } from './dto/create-coupon.dto';

@Controller('coupons')
@UseGuards(ApiKeyGuard)
export class CouponController {
  private readonly logger = new Logger(CouponController.name);

  constructor(private readonly repo: CouponRepository) {}

  @Post()
  async create(
    @Body(new ValidationPipe({ transform: true, whitelist: true }))
    body: CreateCouponDto,
  ) {
    if (body.firstBuy || body.perUser) {
      this.logger.warn(
        `coupon ${body.code} is firstBuy/perUser — it will NEVER render in a ` +
          `post (suppressed by the gate).`,
      );
    }
    if (body.type === 'PERCENT' && body.value > 100) {
      this.logger.warn(
        `coupon ${body.code} PERCENT value > 100 — likely a mistake.`,
      );
    }
    if (body.type === 'FINAL' && body.scope !== 'PRODUCT') {
      throw new BadRequestException(
        `coupon ${body.code}: type FINAL requires scope PRODUCT — a final ` +
          `price only makes sense for a single item.`,
      );
    }
    return this.repo.create({
      code: body.code,
      scope: body.scope,
      targetId: body.targetId,
      type: body.type,
      value: body.value,
      capCents: body.capCents ?? null,
      minCents: body.minCents ?? null,
      firstBuy: body.firstBuy ?? false,
      perUser: body.perUser ?? false,
      validUntil: new Date(body.validUntil),
      active: true,
      affiliateSafe: body.affiliateSafe ?? true,
    });
  }
}
