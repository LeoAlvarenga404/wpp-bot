jest.mock('@whiskeysockets/baileys', () => ({}));
jest.mock('@hapi/boom', () => ({ Boom: class Boom {} }));
jest.mock('@sentry/node', () => ({
  captureException: jest.fn(),
  init: jest.fn(),
}));
jest.mock('../whatsapp/wa.service');

import { SendDealWorker } from './send-deal.worker';

function makeDeps() {
  const publisher = {
    channel: 'telegram',
    publish: jest.fn().mockResolvedValue(undefined),
  };
  const registry = { get: jest.fn().mockReturnValue(publisher) };
  const formatter = {
    formatScored: jest
      .fn()
      .mockResolvedValue({ caption: 'cap', imageUrl: 'https://img' }),
    formatDigest: jest
      .fn()
      .mockResolvedValue({ caption: 'digest-cap', imageUrl: 'https://img' }),
  };
  const dedup = { markPosted: jest.fn().mockResolvedValue(undefined) };
  const prisma = { sentMessage: { create: jest.fn().mockResolvedValue({}) } };
  const counters = {
    wppMessagesSent: { labels: jest.fn().mockReturnValue({ inc: jest.fn() }) },
    wppMessagesFailed: {
      labels: jest.fn().mockReturnValue({ inc: jest.fn() }),
    },
  };
  return { publisher, registry, formatter, dedup, prisma, counters };
}

function makeWorker(d: ReturnType<typeof makeDeps>): SendDealWorker {
  return new SendDealWorker(
    {},
    d.registry as any,
    d.formatter as any,
    d.dedup as any,
    d.prisma as any,
    d.counters as any,
  );
}

function makeJob(channel?: 'wa' | 'telegram') {
  return {
    id: 'k:t',
    data: {
      targetJid: '-100555',
      channel,
      catalogKey: 'ml:MLB1',
      variant: 'B',
      scored: {
        deal: { key: { source: 'ml', externalId: 'MLB1' }, raw: {} },
        score: 80,
        level: 'top',
      },
    },
  } as any;
}

function makeDigestJob() {
  return {
    id: 'digest:123@g.us:ml:MLB1+ml:MLB2',
    name: 'send-digest',
    data: {
      targetJid: '123@g.us',
      channel: 'wa',
      digestId: 'dg-1',
      deals: [
        {
          catalogKey: 'ml:MLB1',
          variant: 'A',
          scored: {
            deal: { key: { source: 'ml', externalId: 'MLB1' }, raw: {} },
            score: 90,
            level: 'top',
          },
        },
        {
          catalogKey: 'ml:MLB2',
          variant: 'B',
          scored: {
            deal: { key: { source: 'ml', externalId: 'MLB2' }, raw: {} },
            score: 85,
            level: 'good',
          },
        },
      ],
    },
  } as any;
}

describe('SendDealWorker.process (send-digest)', () => {
  it('publishes one message and audits every deal with the digestId', async () => {
    const d = makeDeps();
    const worker = makeWorker(d);

    await (worker as any).process(makeDigestJob());

    expect(d.publisher.publish).toHaveBeenCalledTimes(1);
    expect(d.publisher.publish).toHaveBeenCalledWith(
      { caption: 'digest-cap', imageUrl: 'https://img' },
      '123@g.us',
    );
    expect(d.dedup.markPosted).toHaveBeenCalledWith('ml:MLB1');
    expect(d.dedup.markPosted).toHaveBeenCalledWith('ml:MLB2');
    expect(d.prisma.sentMessage.create).toHaveBeenCalledTimes(2);
    expect(d.prisma.sentMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        catalogId: 'ml:MLB1',
        targetJid: '123@g.us',
        variant: 'A',
        digestId: 'dg-1',
      }),
    });
  });
});

describe('SendDealWorker.process', () => {
  it('routes to publisher by job channel and records SentMessage', async () => {
    const d = makeDeps();
    const worker = makeWorker(d);

    await (worker as any).process(makeJob('telegram'));

    expect(d.registry.get).toHaveBeenCalledWith('telegram');
    expect(d.publisher.publish).toHaveBeenCalledWith(
      { caption: 'cap', imageUrl: 'https://img' },
      '-100555',
    );
    expect(d.dedup.markPosted).toHaveBeenCalledWith('ml:MLB1');
    expect(d.formatter.formatScored).toHaveBeenCalledWith(
      expect.anything(),
      'B',
      undefined,
      undefined,
    );
    expect(d.prisma.sentMessage.create).toHaveBeenCalledWith({
      data: {
        catalogId: 'ml:MLB1',
        targetJid: '-100555',
        caption: 'cap',
        variant: 'B',
      },
    });
  });

  it('defaults variant to A for legacy jobs', async () => {
    const d = makeDeps();
    const worker = makeWorker(d);
    const job = makeJob('telegram');
    delete job.data.variant;

    await (worker as any).process(job);

    expect(d.formatter.formatScored).toHaveBeenCalledWith(
      expect.anything(),
      'A',
      undefined,
      undefined,
    );
  });

  it('defaults channel to wa for legacy jobs', async () => {
    const d = makeDeps();
    const worker = makeWorker(d);

    await (worker as any).process(makeJob(undefined));

    expect(d.registry.get).toHaveBeenCalledWith('wa');
  });

  it('passes trustBadge through to the formatter', async () => {
    const d = makeDeps();
    const worker = makeWorker(d);
    const job = makeJob('wa');
    job.data.trustBadge = {
      label: '📉 Menor preço em 30 dias',
      monitoredDays: 42,
    };

    await (worker as any).process(job);

    expect(d.formatter.formatScored).toHaveBeenCalledWith(
      expect.anything(),
      'B',
      { label: '📉 Menor preço em 30 dias', monitoredDays: 42 },
      undefined,
    );
  });

  it('does not fail the job when the audit insert fails', async () => {
    const d = makeDeps();
    d.prisma.sentMessage.create.mockRejectedValue(new Error('db down'));
    const worker = makeWorker(d);

    await expect(
      (worker as any).process(makeJob('telegram')),
    ).resolves.toBeUndefined();
    expect(d.publisher.publish).toHaveBeenCalled();
  });
});
