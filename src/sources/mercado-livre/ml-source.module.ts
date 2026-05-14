// src/sources/mercado-livre/ml-source.module.ts

import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EnrichmentModule } from '../../enrichment/enrichment.module';
import { MercadoLivreModule } from '../../mercado-livre/ml.module';
import { ML_SOURCE_OPTS, MLSource } from './ml-source.service';
import { FeedRotatorService } from './feed-rotator.service';

@Module({
  imports: [ConfigModule, MercadoLivreModule, EnrichmentModule],
  providers: [
    FeedRotatorService,
    {
      provide: ML_SOURCE_OPTS,
      useFactory: (config: ConfigService) => ({
        minDiscount: Number(config.get<string>('ML_MIN_DISCOUNT', '25')),
        maxPerFeed: Number(config.get<string>('DEAL_ENRICH_TOP_N', '10')) * 3,
      }),
      inject: [ConfigService],
    },
    MLSource,
  ],
  exports: [MLSource, FeedRotatorService],
})
export class MLSourceModule {}
