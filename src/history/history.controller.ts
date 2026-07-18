import { Controller, Get, ParseIntPipe, Query, UseGuards, DefaultValuePipe } from '@nestjs/common';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { HistoryService } from './history.service';

@Controller('history')
@UseGuards(ApiKeyGuard)
export class HistoryController {
  constructor(private readonly historyService: HistoryService) {}

  @Get()
  async listHistory(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    const validPage = Math.max(1, page);
    const validLimit = Math.min(100, Math.max(1, limit));
    return this.historyService.listHistory(validPage, validLimit);
  }
}
