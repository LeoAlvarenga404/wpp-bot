import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Redirect,
} from '@nestjs/common';
import { RedirectService } from './redirect.service';

/**
 * Public click endpoint — deliberately NO ApiKeyGuard: these URLs land in
 * WhatsApp/Telegram captions and are opened by end users.
 */
@Controller('r')
export class RedirectController {
  constructor(private readonly redirects: RedirectService) {}

  @Get(':code')
  @Redirect(undefined, 302)
  async follow(@Param('code') code: string): Promise<{ url: string }> {
    const row = await this.redirects.resolve(code);
    if (!row) throw new NotFoundException();
    // Fire-and-forget: the user's redirect never waits on the UPDATE.
    this.redirects.trackClick(code);
    return { url: row.url };
  }
}
