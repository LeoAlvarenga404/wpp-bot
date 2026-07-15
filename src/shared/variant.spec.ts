import { pickVariant } from './variant';

describe('pickVariant', () => {
  it('is deterministic for the same catalogId', () => {
    expect(pickVariant('ml:MLB123')).toBe(pickVariant('ml:MLB123'));
  });

  it('produces both variants across ids', () => {
    const ids = Array.from({ length: 50 }, (_, i) => `ml:MLB${i}`);
    const set = new Set(ids.map(pickVariant));
    expect(set).toEqual(new Set(['A', 'B']));
  });
});
