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
    // v1: only the Mercado Livre source is registered. Map legacy `category`
    // payloads to the new `sourceId='ml'` shape; legacy `minDiscount` is now
    // sourced from the ML source config and is no longer a per-request knob.
    return this.pipeline.runOnce({
      sourceId: 'ml',
      max: body.max,
    });
  }

  @Post('preview')
  async preview(
    @Body(new ValidationPipe({ transform: true, whitelist: true }))
    body: PreviewDto,
  ) {
    return this.pipeline.preview(body);
  }
}
