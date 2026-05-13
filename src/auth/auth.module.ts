import { Module } from '@nestjs/common';
import { ApiKeyGuard } from './api-key.guard';

/**
 * Exposes `ApiKeyGuard` for injection in feature modules that want
 * to apply `@UseGuards(ApiKeyGuard)` at the controller level.
 *
 * Imported by `PipelineModule` and `AffiliateModule`. OAuth endpoints
 * (under `/oauth/*`) deliberately stay public so Mercado Livre can
 * complete the authorization redirect.
 */
@Module({
  providers: [ApiKeyGuard],
  exports: [ApiKeyGuard],
})
export class AuthModule {}
