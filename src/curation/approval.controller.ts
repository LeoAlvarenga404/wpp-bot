import { Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { ApprovalQueueService } from './approval-queue.service';

@Controller('approval')
@UseGuards(ApiKeyGuard)
export class ApprovalController {
  constructor(private readonly approvalQueue: ApprovalQueueService) {}

  @Get('pending')
  async listPending() {
    return { pending: await this.approvalQueue.listPending() };
  }

  @Post(':id/approve')
  async approve(@Param('id') id: string) {
    return this.approvalQueue.approve(id);
  }

  @Post(':id/reject')
  async reject(@Param('id') id: string) {
    return this.approvalQueue.reject(id);
  }
}
