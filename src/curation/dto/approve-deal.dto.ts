import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

/** Mirror of CuratorCouponEdit (src/shared/curator-edits.ts). */
export class CuratorCouponEditDto {
  @IsString()
  @MinLength(2)
  code!: string;

  /** Final price in cents after the coupon. Absent = code-only CTA line. */
  @IsOptional()
  @IsInt()
  @Min(1)
  finalCents?: number;
}

/** Mirror of CuratorEdits — the light-edit contract of the approval card. */
export class CuratorEditsDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  headline?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  priceCents?: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => CuratorCouponEditDto)
  coupon?: CuratorCouponEditDto;
}

/** Body of POST /approval/:id/approve and POST /approval/:id/preview. */
export class ApproveDealDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => CuratorEditsDto)
  edits?: CuratorEditsDto;

  /** "Enviar agora": jumps the send queue and pierces quiet hours (#7). */
  @IsOptional()
  @IsBoolean()
  urgent?: boolean;

  /**
   * Confirms reposting a product published < DEDUP_WINDOW_DAYS ago. Without
   * it, approving such a deal returns 409 { code: 'recently_posted' }.
   */
  @IsOptional()
  @IsBoolean()
  dedupOverride?: boolean;
}
