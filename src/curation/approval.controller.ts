import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { ApprovalQueueService } from './approval-queue.service';
import { ApproveDealDto } from './dto/approve-deal.dto';

@Controller('approval')
@UseGuards(ApiKeyGuard)
export class ApprovalController {
  constructor(private readonly approvalQueue: ApprovalQueueService) {}

  @Get('pending')
  async listPending() {
    return { pending: await this.approvalQueue.listPending() };
  }

  @Post(':id/approve')
  async approve(@Param('id') id: string, @Body() body: ApproveDealDto) {
    return this.approvalQueue.approve(id, body.edits);
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
