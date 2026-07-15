// src/sources/source.port.spec.ts

import { keyToString, parseKey, ProductKey } from './source.port';

describe('source.port helpers', () => {
  it('keyToString joins source and externalId with a colon', () => {
    expect(keyToString({ source: 'ml', externalId: 'MLB1234' })).toBe(
      'ml:MLB1234',
    );
  });

  it('parseKey splits on the first colon only', () => {
    const k = parseKey('ml:weird:id:with:colons');
    expect(k).toEqual<ProductKey>({
      source: 'ml',
      externalId: 'weird:id:with:colons',
    });
  });

  it('parseKey returns null for empty input', () => {
    expect(parseKey('')).toBeNull();
  });

  it('parseKey returns null when no colon present', () => {
    expect(parseKey('MLB1234')).toBeNull();
  });

  it('parseKey returns null when externalId is empty', () => {
    expect(parseKey('ml:')).toBeNull();
  });

  it('parseKey returns null when source segment is empty', () => {
    expect(parseKey(':MLB1234')).toBeNull();
  });

  it('round-trips keyToString → parseKey', () => {
    const original: ProductKey = { source: 'ml', externalId: 'MLB1234' };
    const parsed = parseKey(keyToString(original));
    expect(parsed).toEqual(original);
  });
});
