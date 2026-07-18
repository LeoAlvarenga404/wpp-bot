import { IsString, IsUrl } from 'class-validator';

/** Body of POST /approval/manual/resolve — a product URL the curator pasted. */
export class ResolveManualDto {
  @IsString()
  @IsUrl(
    { require_protocol: true },
    { message: 'url deve ser um link http(s) válido' },
  )
  url!: string;
}
