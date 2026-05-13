import {
  BadRequestException,
  Controller,
  Get,
  Logger,
  Query,
  Redirect,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { MercadoLivreAuthService } from './ml-auth.service';

@Controller('oauth')
export class OAuthController {
  private readonly logger = new Logger(OAuthController.name);

  constructor(private readonly auth: MercadoLivreAuthService) {}

  @Get('authorize')
  @Redirect()
  authorize() {
    const url = this.auth.buildAuthorizeUrl();
    this.logger.log(`Redirecting to ML auth: ${url}`);
    return { url, statusCode: 302 };
  }

  @Get('callback')
  async callback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') error: string,
    @Res() res: Response,
  ) {
    if (error) {
      this.logger.error(`OAuth callback error: ${error}`);
      return res.status(400).send(`<h1>OAuth error</h1><pre>${error}</pre>`);
    }
    if (!code) {
      throw new BadRequestException('Missing code param');
    }
    if (!state || !this.auth.validateState(state)) {
      throw new BadRequestException('Invalid or missing state (CSRF)');
    }

    try {
      const token = await this.auth.exchangeCode(code);
      return res
        .status(200)
        .send(
          `<h1>OK</h1><p>ML token saved. user_id=${token.user_id}</p><p>You can close this tab.</p>`,
        );
    } catch (err: any) {
      this.logger.error('exchangeCode failed', err?.response?.data ?? err);
      return res
        .status(500)
        .send(`<h1>Exchange failed</h1><pre>${JSON.stringify(err?.response?.data ?? err.message, null, 2)}</pre>`);
    }
  }
}
