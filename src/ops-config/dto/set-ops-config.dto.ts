import { IsNotEmpty, IsString } from 'class-validator';

export class SetOpsConfigDto {
  @IsString()
  @IsNotEmpty()
  value!: string;
}
