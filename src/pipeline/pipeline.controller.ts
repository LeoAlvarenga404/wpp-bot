import { Body, Controller, Post } from '@nestjs/common';
import { PipelineService } from './pipeline.service';

interface TriggerDto {
  category?: string;
  minDiscount?: number;
  max?: number;
}

interface PreviewDto {
  categories?: string[];
  minDiscount?: number;
  perCategory?: number;
}

@Controller('pipeline')
export class PipelineController {
  constructor(private readonly pipeline: PipelineService) {}

  @Post('trigger')
  async trigger(@Body() body: TriggerDto) {
    return this.pipeline.runOnce(body);
  }

  @Post('preview')
  async preview(@Body() body: PreviewDto) {
    return this.pipeline.preview(body);
  }
}
