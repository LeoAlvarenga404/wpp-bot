import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ShopeeClient } from './shopee-client';
import {
  SHOPEE_DEFAULT_KEYWORDS,
  SHOPEE_SOURCE_OPTS,
  ShopeeSource,
  ShopeeSourceOpts,
} from './shopee-source.service';

@Module({
  providers: [
    ShopeeClient,
    {
      provide: SHOPEE_SOURCE_OPTS,
      inject: [ConfigService],
      useFactory: (config: ConfigService): ShopeeSourceOpts => ({
        keywords: (
          config.get<string>('SHOPEE_KEYWORDS') ?? SHOPEE_DEFAULT_KEYWORDS
        )
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        limitPerKeyword: Number(
          config.get<string>('SHOPEE_LIMIT_PER_KEYWORD') ?? '20',
        ),
      }),
    },
    ShopeeSource,
  ],
  exports: [ShopeeSource],
})
export class ShopeeSourceModule {}
