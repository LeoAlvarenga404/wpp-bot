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
import { ManualCouponDto } from './create-manual-deal.dto';

/**
 * Body of POST /approval/manual/preview — the composer's live-preview render.
 * Same fields as the submit, minus `dispatch` (a preview never sends).
 * Defined explicitly (no @nestjs/mapped-types dependency in this project).
 */
export class PreviewManualDto {
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
}
