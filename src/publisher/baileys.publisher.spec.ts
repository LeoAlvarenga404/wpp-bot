// Baileys ships ESM-only — mock the whole WA import chain like the other
// specs (see scheduler.service.spec.ts).
jest.mock('@whiskeysockets/baileys', () => ({}));
jest.mock('@hapi/boom', () => ({ Boom: class Boom {} }));
jest.mock('@sentry/node', () => ({
  captureException: jest.fn(),
  init: jest.fn(),
}));
jest.mock('../whatsapp/wa.service');

import { BaileysPublisher } from './baileys.publisher';

function makeWa(ready = true) {
  return {
    isReady: jest.fn().mockReturnValue(ready),
    sendText: jest.fn().mockResolvedValue(undefined),
    sendImage: jest.fn().mockResolvedValue(undefined),
    sendImageCard: jest.fn().mockResolvedValue(undefined),
  } as any;
}

// WA_LINK_CARD defaults to 'true'; pass 'false' to exercise the rollback path.
function makeConfig(linkCard = 'true') {
  return {
    get: jest.fn((key: string, def?: string) =>
      key === 'WA_LINK_CARD' ? linkCard : def,
    ),
  } as any;
}

describe('BaileysPublisher', () => {
  it('sends a clickable card when imageUrl and linkUrl present', async () => {
    const wa = makeWa();
    const pub = new BaileysPublisher(wa, makeConfig());
    await pub.publish(
      { caption: 'oi', imageUrl: 'https://img', linkUrl: 'https://meli.la/x' },
      '123@g.us',
    );
    expect(wa.sendImageCard).toHaveBeenCalledWith('123@g.us', {
      imageUrl: 'https://img',
      caption: 'oi',
      sourceUrl: 'https://meli.la/x',
    });
    expect(wa.sendImage).not.toHaveBeenCalled();
  });

  it('falls back to plain image when WA_LINK_CARD=false', async () => {
    const wa = makeWa();
    const pub = new BaileysPublisher(wa, makeConfig('false'));
    await pub.publish(
      { caption: 'oi', imageUrl: 'https://img', linkUrl: 'https://meli.la/x' },
      '123@g.us',
    );
    expect(wa.sendImage).toHaveBeenCalledWith('123@g.us', 'https://img', 'oi');
    expect(wa.sendImageCard).not.toHaveBeenCalled();
  });

  it('sends plain image when imageUrl present but no linkUrl', async () => {
    const wa = makeWa();
    const pub = new BaileysPublisher(wa, makeConfig());
    await pub.publish({ caption: 'oi', imageUrl: 'https://img' }, '123@g.us');
    expect(wa.sendImage).toHaveBeenCalledWith('123@g.us', 'https://img', 'oi');
    expect(wa.sendText).not.toHaveBeenCalled();
    expect(wa.sendImageCard).not.toHaveBeenCalled();
  });

  it('sends text when no image', async () => {
    const wa = makeWa();
    const pub = new BaileysPublisher(wa, makeConfig());
    await pub.publish({ caption: 'oi' }, '123@g.us');
    expect(wa.sendText).toHaveBeenCalledWith('123@g.us', 'oi');
  });

  it('throws whatsapp_not_ready when session down', async () => {
    const pub = new BaileysPublisher(makeWa(false), makeConfig());
    await expect(pub.publish({ caption: 'oi' }, 'x')).rejects.toThrow(
      'whatsapp_not_ready',
    );
  });
});
