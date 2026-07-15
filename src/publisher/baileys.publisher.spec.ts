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
  } as any;
}

describe('BaileysPublisher', () => {
  it('sends image with caption when imageUrl present', async () => {
    const wa = makeWa();
    const pub = new BaileysPublisher(wa);
    await pub.publish({ caption: 'oi', imageUrl: 'https://img' }, '123@g.us');
    expect(wa.sendImage).toHaveBeenCalledWith('123@g.us', 'https://img', 'oi');
    expect(wa.sendText).not.toHaveBeenCalled();
  });

  it('sends text when no image', async () => {
    const wa = makeWa();
    const pub = new BaileysPublisher(wa);
    await pub.publish({ caption: 'oi' }, '123@g.us');
    expect(wa.sendText).toHaveBeenCalledWith('123@g.us', 'oi');
  });

  it('throws whatsapp_not_ready when session down', async () => {
    const pub = new BaileysPublisher(makeWa(false));
    await expect(pub.publish({ caption: 'oi' }, 'x')).rejects.toThrow(
      'whatsapp_not_ready',
    );
  });
});
