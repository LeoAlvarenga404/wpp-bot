import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { ApprovalQueueService } from './approval-queue.service';
import { ApproveDealDto } from './dto/approve-deal.dto';
import { ResolveManualDto } from './dto/resolve-manual.dto';
import { CreateManualDealDto } from './dto/create-manual-deal.dto';
import { PreviewManualDto } from './dto/preview-manual.dto';
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
   * Composer resolve: paste a product URL → prefill fields (no card created).
   * A resolve failure returns a clear 4xx.
   */
  @Post('manual/resolve')
  async resolveManual(@Body() body: ResolveManualDto) {
    return this.manualDeals.resolveUrl(body.url);
  }

  /** Live caption preview for the composer — renders, never decides. */
  @Post('manual/preview')
  async previewManual(@Body() body: PreviewManualDto) {
    return this.manualDeals.preview(body);
  }

  /** Submit a composed deal: queue, or dispatch=true to send now (urgent). */
  @Post('manual')
  async submitManual(@Body() body: CreateManualDealDto) {
    return this.manualDeals.submit(body);
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
