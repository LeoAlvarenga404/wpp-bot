import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { TargetsService, WaTarget } from './targets.service';
import { WhatsappService } from './wa.service';

/**
 * P0-6 health endpoint + P2-25 target management.
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
  listTargets(): WaTarget[] {
    return this.targets.list();
  }

  @Post('targets')
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
  async removeTarget(@Param('jid') jid: string): Promise<{ removed: boolean }> {
    const removed = await this.targets.remove(jid);
    return { removed };
  }
}
