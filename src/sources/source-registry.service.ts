// src/sources/source-registry.service.ts

import { Inject, Injectable } from '@nestjs/common';
import { DealSourcePort, SOURCES_TOKEN, SourceId } from './source.port';

@Injectable()
export class SourceRegistry {
  constructor(
    @Inject(SOURCES_TOKEN) private readonly sources: DealSourcePort[],
  ) {}

  getAll(): DealSourcePort[] {
    return this.sources;
  }

  getById(id: SourceId): DealSourcePort {
    const found = this.sources.find((s) => s.id === id);
    if (!found) throw new Error(`Unknown source id: ${id}`);
    return found;
  }
}
