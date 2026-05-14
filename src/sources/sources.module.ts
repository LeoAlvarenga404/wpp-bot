// src/sources/sources.module.ts

import { Global, Module } from '@nestjs/common';
import { SOURCES_TOKEN } from './source.port';
import { SourceRegistry } from './source-registry.service';

@Global()
@Module({
  providers: [
    {
      provide: SOURCES_TOKEN,
      useFactory: () => [],
    },
    SourceRegistry,
  ],
  exports: [SourceRegistry],
})
export class SourcesModule {}
