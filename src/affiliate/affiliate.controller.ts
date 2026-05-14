import { Body, Controller, Inject, Post, UseGuards } from '@nestjs/common';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { AFFILIATE_LINK_PORT } from './affiliate-link.port';
import type { AffiliateLinkPort } from './affiliate-link.port';

@Controller('affiliate')
@UseGuards(ApiKeyGuard)
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

  @Post('resolve')
  async resolve(@Body() body: { url: string }) {
    const short = await this.port.resolve(body.url);
    return { input: body.url, short };
  }
}
