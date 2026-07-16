import { Module } from '@nestjs/common';
import { CouponController } from './coupon.controller';
import { CouponRepository } from './coupon.repository';
import { CouponService } from './coupon.service';

// PrismaService is provided globally by DbModule (@Global) — no import needed.
@Module({
  controllers: [CouponController],
  providers: [CouponRepository, CouponService],
  exports: [CouponService],
})
export class CouponModule {}
