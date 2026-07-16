import {
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Min,
  MinLength,
} from 'class-validator';

export class CreateCouponDto {
  @IsString()
  @MinLength(2)
  code!: string;

  @IsIn(['SELLER', 'PRODUCT'])
  scope!: 'SELLER' | 'PRODUCT';

  /** SELLER -> ML seller id; PRODUCT -> MLB item id. */
  @IsString()
  @MinLength(1)
  targetId!: string;

  @IsIn(['PERCENT', 'FIXED'])
  type!: 'PERCENT' | 'FIXED';

  /** PERCENT: 1-100. FIXED: discount in cents. */
  @IsInt()
  @Min(1)
  value!: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  capCents?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  minCents?: number;

  @IsOptional()
  @IsBoolean()
  firstBuy?: boolean;

  @IsOptional()
  @IsBoolean()
  perUser?: boolean;

  @IsISO8601()
  validUntil!: string;

  @IsOptional()
  @IsBoolean()
  affiliateSafe?: boolean;
}
