import { IsInt, IsOptional, Matches, Max, Min } from 'class-validator';

/**
 * Body schema for POST /pipeline/trigger.
 *
 * Validated via `@Body(new ValidationPipe({ transform: true, whitelist: true }))`
 * on the controller handler, so the request body is coerced into this class
 * and unknown fields are stripped before reaching the service layer.
 */
export class TriggerDto {
  /** Mercado Livre category id, e.g. `MLB1648`. */
  @IsOptional()
  @Matches(/^MLB\d+$/, {
    message: 'category must match /^MLB\\d+$/ (e.g. MLB1648)',
  })
  category?: string;

  /** Minimum discount percentage (0-100). */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  minDiscount?: number;

  /** Maximum number of deals to publish in one run (1-50). */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  max?: number;
}
