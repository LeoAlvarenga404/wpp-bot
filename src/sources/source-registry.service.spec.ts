// src/sources/source-registry.service.spec.ts

import { SourceRegistry } from './source-registry.service';
import type { DealSourcePort, RawDeal, EnrichedDeal } from './source.port';

function makeFake(id: 'ml'): DealSourcePort {
  return {
    id,
    discover: async (): Promise<RawDeal[]> => [],
    discoverOne: async (): Promise<RawDeal[]> => [],
    enrichMany: async (): Promise<EnrichedDeal[]> => [],
  };
}

describe('SourceRegistry', () => {
  it('getAll returns the injected sources in order', () => {
    const ml = makeFake('ml');
    const reg = new SourceRegistry([ml]);
    expect(reg.getAll()).toEqual([ml]);
  });

  it('getById returns the source with matching id', () => {
    const ml = makeFake('ml');
    const reg = new SourceRegistry([ml]);
    expect(reg.getById('ml')).toBe(ml);
  });

  it('getById throws when id is not registered', () => {
    const reg = new SourceRegistry([]);
    expect(() => reg.getById('ml')).toThrow(/Unknown source id: ml/);
  });

  it('handles empty registry without crashing', () => {
    const reg = new SourceRegistry([]);
    expect(reg.getAll()).toEqual([]);
  });
});
