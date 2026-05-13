import { Module } from '@nestjs/common';
import { AFFILIATE_LINK_PORT } from './affiliate-link.port';
import { AffiliateController } from './affiliate.controller';
import { JsonCacheAffiliateAdapter } from './json-cache-adapter';

@Module({
  controllers: [AffiliateController],
  providers: [
    JsonCacheAffiliateAdapter,
    {
      provide: AFFILIATE_LINK_PORT,
      useExisting: JsonCacheAffiliateAdapter,
    },
  ],
  exports: [AFFILIATE_LINK_PORT],
})
export class AffiliateModule {}
