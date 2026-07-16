import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CouponController } from './coupon.controller';
import type { CouponRepository } from './coupon.repository';
import { CreateCouponDto } from './dto/create-coupon.dto';

const validFinal = {
  code: 'FINAL10',
  scope: 'PRODUCT',
  targetId: 'MLB123',
  type: 'FINAL',
  value: 8990,
  validUntil: '2999-01-01T00:00:00Z',
};

describe('CreateCouponDto', () => {
  it('accepts type FINAL', async () => {
    const dto = plainToInstance(CreateCouponDto, validFinal);
    expect(await validate(dto)).toHaveLength(0);
  });
});

describe('CouponController FINAL scope guard', () => {
  const repo = { create: jest.fn(async (c) => c) };
  const controller = new CouponController(repo as unknown as CouponRepository);

  it('rejects FINAL with SELLER scope', async () => {
    const dto = plainToInstance(CreateCouponDto, {
      ...validFinal,
      scope: 'SELLER',
      targetId: 's1',
    });
    await expect(controller.create(dto)).rejects.toThrow(BadRequestException);
  });

  it('accepts FINAL with PRODUCT scope', async () => {
    const dto = plainToInstance(CreateCouponDto, validFinal);
    await expect(controller.create(dto)).resolves.toMatchObject({
      type: 'FINAL',
      value: 8990,
    });
  });
});
