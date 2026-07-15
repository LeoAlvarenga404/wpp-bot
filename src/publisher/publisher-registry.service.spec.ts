import { PublisherRegistry } from './publisher-registry.service';
import type { PublisherPort } from './publisher.port';

const fake = (channel: 'wa' | 'telegram'): PublisherPort => ({
  channel,
  publish: jest.fn().mockResolvedValue(undefined),
});

describe('PublisherRegistry', () => {
  it('resolves publisher by channel', () => {
    const wa = fake('wa');
    const tg = fake('telegram');
    const reg = new PublisherRegistry([wa, tg]);
    expect(reg.get('wa')).toBe(wa);
    expect(reg.get('telegram')).toBe(tg);
  });

  it('throws for unregistered channel', () => {
    const reg = new PublisherRegistry([fake('wa')]);
    expect(() => reg.get('telegram')).toThrow(
      'no publisher for channel=telegram',
    );
  });
});
