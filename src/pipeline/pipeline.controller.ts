import {
  Body,
  Controller,
  Post,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { PreviewDto } from './dto/preview.dto';
import { TriggerDto } from './dto/trigger.dto';
import { PipelineService } from './pipeline.service';

@Controller('pipeline')
@UseGuards(ApiKeyGuard)
export class PipelineController {
  constructor(private readonly pipeline: PipelineService) {}

  @Post('trigger')
  async trigger(
    @Body(new ValidationPipe({ transform: true, whitelist: true }))
    body: TriggerDto,
  ) {
    return this.pipeline.runOnce(body);
  }

  @Post('preview')
  async preview(
    @Body(new ValidationPipe({ transform: true, whitelist: true }))
    body: PreviewDto,
  ) {
    return this.pipeline.preview(body);
  }
}
