// src/sources/sources.module.ts

import { Global, Module } from '@nestjs/common';
import { MLSourceModule } from './mercado-livre/ml-source.module';
import { MLSource } from './mercado-livre/ml-source.service';
import { SOURCES_TOKEN } from './source.port';
import { SourceRegistry } from './source-registry.service';

@Global()
@Module({
  imports: [MLSourceModule],
  providers: [
    {
      provide: SOURCES_TOKEN,
      useFactory: (ml: MLSource) => [ml],
      inject: [MLSource],
    },
    SourceRegistry,
  ],
  exports: [SourceRegistry, MLSourceModule],
})
export class SourcesModule {}
