import {
  Body,
  Controller,
  Get,
  Param,
  Put,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { SetOpsConfigDto } from './dto/set-ops-config.dto';
import { OpsConfigService } from './ops-config.service';

@Controller('ops-config')
@UseGuards(ApiKeyGuard)
export class OpsConfigController {
  constructor(private readonly opsConfig: OpsConfigService) {}

  @Get()
  async getAll() {
    return { values: await this.opsConfig.getAllEffective() };
  }

  @Put(':key')
  async set(
    @Param('key') key: string,
    @Body(new ValidationPipe({ transform: true, whitelist: true }))
    body: SetOpsConfigDto,
  ) {
    await this.opsConfig.set(key, body.value);
    return { values: await this.opsConfig.getAllEffective() };
  }
}
