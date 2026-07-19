import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  IsUrl,
  ValidateNested,
} from 'class-validator';

export class ManualCouponDto {
  @IsString({ message: 'coupon.code deve ser uma string' })
  code!: string;

  @IsOptional()
  @IsInt({ message: 'coupon.finalCents deve ser um número inteiro' })
  @IsPositive({ message: 'coupon.finalCents deve ser maior que zero' })
  finalCents?: number;
}

/**
 * Body of POST /approval/manual — a deal composed in the panel (link-resolved
 * fields, all editable, plus optional coupon). `permalink` is optional so a
 * fully manual deal (no store integration) can still be posted. `dispatch`
 * true sends now (urgent) instead of queuing.
 */
export class CreateManualDealDto {
  @IsString({ message: 'store deve ser uma string' })
  store!: string;

  @IsString({ message: 'title deve ser uma string' })
  title!: string;

  @IsInt({ message: 'priceCents deve ser um número inteiro' })
  @IsPositive({ message: 'priceCents deve ser maior que zero' })
  priceCents!: number;

  @IsOptional()
  @IsInt({ message: 'originalPriceCents deve ser um número inteiro' })
  @IsPositive({ message: 'originalPriceCents deve ser maior que zero' })
  originalPriceCents?: number;

  @IsOptional()
  @IsBoolean({ message: 'installmentsNoInterest deve ser boolean' })
  installmentsNoInterest?: boolean;

  @IsOptional()
  @ValidateNested()
  @Type(() => ManualCouponDto)
  coupon?: ManualCouponDto;

  @IsString({ message: 'thumbnail deve ser uma string' })
  @IsUrl(
    { require_protocol: true },
    { message: 'thumbnail deve ser um link http(s) válido' },
  )
  thumbnail!: string;

  @IsOptional()
  @IsUrl(
    { require_protocol: true },
    { message: 'permalink deve ser um link http(s) válido' },
  )
  permalink?: string;

  @IsOptional()
  @IsBoolean({ message: 'dispatch deve ser boolean' })
  dispatch?: boolean;
}
