// src/sources/sources.module.ts

import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MLSourceModule } from './mercado-livre/ml-source.module';
import { MLSource } from './mercado-livre/ml-source.service';
import { ShopeeSourceModule } from './shopee/shopee-source.module';
import { ShopeeSource } from './shopee/shopee-source.service';
import { DealSourcePort, SOURCES_TOKEN } from './source.port';
import { SourceRegistry } from './source-registry.service';

@Global()
@Module({
  imports: [MLSourceModule, ShopeeSourceModule],
  providers: [
    {
      provide: SOURCES_TOKEN,
      inject: [ConfigService, MLSource, ShopeeSource],
      useFactory: (
        config: ConfigService,
        ml: MLSource,
        shopee: ShopeeSource,
      ): DealSourcePort[] => {
        const list: DealSourcePort[] = [ml];
        if (
          config.get<string>('SHOPEE_APP_ID') &&
          config.get<string>('SHOPEE_APP_SECRET')
        ) {
          list.push(shopee);
        } else {
          new Logger('SourcesModule').log(
            'Shopee source off — SHOPEE_APP_ID/SHOPEE_APP_SECRET ausentes',
          );
        }
        return list;
      },
    },
    SourceRegistry,
  ],
  exports: [SourceRegistry, MLSourceModule],
})
export class SourcesModule {}
