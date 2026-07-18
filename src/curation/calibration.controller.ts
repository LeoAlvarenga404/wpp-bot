import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { CURATION_DECISION_REPO } from './curation-decision.repo';
import type { CurationDecisionRepo } from './curation-decision.repo';

@Controller('calibration')
@UseGuards(ApiKeyGuard)
export class CalibrationController {
  constructor(
    @Inject(CURATION_DECISION_REPO) private readonly repo: CurationDecisionRepo,
  ) {}

  @Get('stats')
  async getStats(@Query('days') daysStr?: string) {
    const days = daysStr ? parseInt(daysStr, 10) : 7;
    return this.repo.getCalibrationStats(isNaN(days) ? 7 : days);
  }
}
