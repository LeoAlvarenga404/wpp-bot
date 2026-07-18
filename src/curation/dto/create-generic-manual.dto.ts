import { IsInt, IsOptional, IsPositive, IsString, IsUrl } from 'class-validator';

/** Body of POST /approval/manual/generic — a fully formed deal submitted by the curator. */
export class CreateGenericManualDto {
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

  @IsString({ message: 'thumbnail deve ser uma string' })
  @IsUrl(
    { require_protocol: true },
    { message: 'thumbnail deve ser um link http(s) válido' },
  )
  thumbnail!: string;

  @IsString({ message: 'permalink deve ser uma string' })
  @IsUrl(
    { require_protocol: true },
    { message: 'permalink deve ser um link http(s) válido' },
  )
  permalink!: string;
}
