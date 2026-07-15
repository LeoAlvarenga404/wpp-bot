import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { TargetsService, WaTarget } from './targets.service';
import { WhatsappService } from './wa.service';

/**
 * P0-6 health endpoint + P2-25 target management.
 *
 * `/wa/health` stays public so the Docker HEALTHCHECK (and any external
 * uptime probe) can poll it without credentials. Every other endpoint
 * mutates routing state and is gated by `ApiKeyGuard` at the method
 * level — guarding the whole controller would also lock out the probe.
 */
@Controller('wa')
export class WaHealthController {
  constructor(
    private readonly wa: WhatsappService,
    private readonly targets: TargetsService,
  ) {}

  @Get('health')
  health() {
    return this.wa.getHealth();
  }

  @Get('targets')
  @UseGuards(ApiKeyGuard)
  async listTargets(): Promise<WaTarget[]> {
    return this.targets.list();
  }

  @Post('targets')
  @UseGuards(ApiKeyGuard)
  async addTarget(
    @Body() body: { jid?: string; name?: string; active?: boolean },
  ): Promise<WaTarget | { error: string }> {
    if (!body || !body.jid) return { error: 'jid required' };
    const t = await this.targets.add(body.jid, body.name ?? body.jid);
    if (body.active === false) {
      await this.targets.setActive(body.jid, false);
      t.active = false;
    }
    return t;
  }

  @Delete('targets/:jid')
  @UseGuards(ApiKeyGuard)
  async removeTarget(@Param('jid') jid: string): Promise<{ removed: boolean }> {
    const removed = await this.targets.remove(jid);
    return { removed };
  }
}
