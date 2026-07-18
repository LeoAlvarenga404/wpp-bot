import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { ApprovalQueueService } from './approval-queue.service';
import { ApproveDealDto } from './dto/approve-deal.dto';
import { ResolveManualDto } from './dto/resolve-manual.dto';
import { CreateGenericManualDto } from './dto/create-generic-manual.dto';
import { ManualDealService } from './manual/manual-deal.service';

@Controller('approval')
@UseGuards(ApiKeyGuard)
export class ApprovalController {
  constructor(
    private readonly approvalQueue: ApprovalQueueService,
    private readonly manualDeals: ManualDealService,
  ) {}

  @Get('pending')
  async listPending() {
    return { pending: await this.approvalQueue.listPending() };
  }

  /**
   * Deal manual (issue #8): paste a product URL, get a filled pending card.
   * A resolve failure returns a clear 4xx and creates no card.
   */
  @Post('manual/resolve')
  async resolveManual(@Body() body: ResolveManualDto) {
    return this.manualDeals.resolveUrl(body.url);
  }

  /**
   * Deal manual genérico (issue #9): submit a fully populated deal via form
   * bypassing the scraper resolvers.
   */
  @Post('manual/generic')
  async createGeneric(@Body() body: CreateGenericManualDto) {
    return this.manualDeals.createGeneric(body);
  }

  @Post(':id/approve')
  async approve(@Param('id') id: string, @Body() body: ApproveDealDto) {
    return this.approvalQueue.approve(id, body.edits, {
      urgent: body.urgent,
      dedupOverride: body.dedupOverride,
    });
  }

  /** Live preview of the edited caption — renders, never decides. */
  @Post(':id/preview')
  async preview(@Param('id') id: string, @Body() body: ApproveDealDto) {
    return this.approvalQueue.preview(id, body.edits);
  }

  @Post(':id/reject')
  async reject(@Param('id') id: string) {
    return this.approvalQueue.reject(id);
  }
}
