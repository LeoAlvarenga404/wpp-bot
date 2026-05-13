import { Controller, Inject, Post } from '@nestjs/common';
import { AFFILIATE_LINK_PORT } from './affiliate-link.port';
import type { AffiliateLinkPort } from './affiliate-link.port';

@Controller('affiliate')
export class AffiliateController {
  constructor(
    @Inject(AFFILIATE_LINK_PORT)
    private readonly port: AffiliateLinkPort,
  ) {}

  @Post('reload')
  async reload() {
    await this.port.reload();
    return { ok: true };
  }
}
