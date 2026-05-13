import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';

/**
 * Body schema for POST /pipeline/preview.
 *
 * `categories` is validated element-by-element: each entry must be a string
 * matching the ML category regex. `class-validator` applies `@Matches({ each: true })`
 * to every array item.
 */
export class PreviewDto {
  /** List of Mercado Livre category ids, up to 50 entries. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @Matches(/^MLB\d+$/, {
    each: true,
    message: 'each category must match /^MLB\\d+$/ (e.g. MLB1648)',
  })
  categories?: string[];

  /** Minimum discount percentage filter (0-100). */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  minDiscount?: number;

  /** Max deals to return per category (1-20). */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  perCategory?: number;
}
