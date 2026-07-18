jest.mock('@whiskeysockets/baileys', () => ({}));
jest.mock('@hapi/boom', () => ({ Boom: class Boom {} }));
jest.mock('@sentry/node', () => ({
  captureException: jest.fn(),
  init: jest.fn(),
}));
jest.mock('../whatsapp/wa.service');

import { DelayedError } from 'bullmq';
import { SendDealWorker } from './send-deal.worker';

const STALE_MS = 11 * 60_000; // > default SEND_MAX_JOB_AGE_MIN (10)

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
    stalePriceDrop: { inc: jest.fn() },
  };
  const config = {
    // Mirrors ConfigService.get(key): undefined unless a test overrides.
    get: jest.fn().mockReturnValue(undefined),
  };
  const scraper = { scrapePriceView: jest.fn().mockResolvedValue(null) };
  const coupons = { resolveForDeal: jest.fn().mockResolvedValue(null) };
  // Default: quiet hours master switch off — sends flow like before #7.
  const opsConfig = { quietHoursEnabled: jest.fn().mockResolvedValue(false) };
  return {
    publisher,
    registry,
    formatter,
    dedup,
    prisma,
    counters,
    config,
    scraper,
    coupons,
    opsConfig,
  };
}

function makeWorker(d: ReturnType<typeof makeDeps>): SendDealWorker {
  const w = new SendDealWorker(
    {},
    d.registry as any,
    d.formatter as any,
    d.dedup as any,
    d.prisma as any,
    d.counters as any,
    d.config as any,
    d.scraper,
    d.coupons as any,
    d.opsConfig as any,
  );
  // Never actually wait in unit tests.
  (w as any).sleep = jest.fn().mockResolvedValue(undefined);
  return w;
}

function makeJob(channel?: 'wa' | 'telegram') {
  return {
    id: 'k:t',
    timestamp: Date.now(),
    data: {
      targetJid: '-100555',
      channel,
      catalogKey: 'ml:MLB1',
      variant: 'B',
      scored: {
        deal: {
          key: { source: 'ml', externalId: 'MLB1' },
          raw: { permalink: 'https://ml/p/MLB1', priceCents: 10000 },
        },
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
    timestamp: Date.now(),
    data: {
      targetJid: '123@g.us',
      channel: 'wa',
      digestId: 'dg-1',
      deals: [
        {
          catalogKey: 'ml:MLB1',
          variant: 'A',
          scored: {
            deal: {
              key: { source: 'ml', externalId: 'MLB1' },
              raw: { permalink: 'https://ml/p/MLB1', priceCents: 10000 },
            },
            score: 90,
            level: 'top',
          },
        },
        {
          catalogKey: 'ml:MLB2',
          variant: 'B',
          scored: {
            deal: {
              key: { source: 'ml', externalId: 'MLB2' },
              raw: { permalink: 'https://ml/p/MLB2', priceCents: 20000 },
            },
            score: 85,
            level: 'good',
          },
        },
      ],
    },
  } as any;
}

function freshView(priceCents = 5000) {
  return {
    priceCents,
    originalPriceCents: 9000,
    discountPercent: 44,
    pixPriceCents: null,
    installments: null,
    scrapedAt: new Date().toISOString(),
  };
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

  it('does not re-scrape when the digest job is fresh', async () => {
    const d = makeDeps();
    const worker = makeWorker(d);

    await (worker as any).process(makeDigestJob());

    expect(d.scraper.scrapePriceView).not.toHaveBeenCalled();
  });

  it('stale digest: keeps re-scraped deals, drops the ones that fail', async () => {
    const d = makeDeps();
    const worker = makeWorker(d);
    const job = makeDigestJob();
    job.timestamp = Date.now() - STALE_MS;
    const view = freshView(4200);
    d.scraper.scrapePriceView
      .mockResolvedValueOnce(view) // MLB1 ok
      .mockResolvedValueOnce(null); // MLB2 fails -> dropped

    await (worker as any).process(job);

    expect(d.formatter.formatDigest).toHaveBeenCalledTimes(1);
    const entries = d.formatter.formatDigest.mock.calls[0][0];
    expect(entries).toHaveLength(1);
    expect(entries[0].priceView).toBe(view);
    expect(d.publisher.publish).toHaveBeenCalledTimes(1);
    expect(d.dedup.markPosted).toHaveBeenCalledTimes(1);
    expect(d.dedup.markPosted).toHaveBeenCalledWith('ml:MLB1');
    expect(d.prisma.sentMessage.create).toHaveBeenCalledTimes(1);
    expect(d.counters.stalePriceDrop.inc).toHaveBeenCalledTimes(1);
  });

  it('stale digest: skips publish entirely when every deal fails the re-scrape', async () => {
    const d = makeDeps();
    const worker = makeWorker(d);
    const job = makeDigestJob();
    job.timestamp = Date.now() - STALE_MS;
    d.scraper.scrapePriceView.mockResolvedValue(null);

    await expect((worker as any).process(job)).resolves.toBeUndefined();

    expect(d.formatter.formatDigest).not.toHaveBeenCalled();
    expect(d.publisher.publish).not.toHaveBeenCalled();
    expect(d.dedup.markPosted).not.toHaveBeenCalled();
    expect(d.counters.stalePriceDrop.inc).toHaveBeenCalledTimes(2);
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
      undefined,
    );
  });

  it('forwards a still-valid couponView to the formatter', async () => {
    const d = makeDeps();
    const worker = makeWorker(d);
    const job = makeJob('telegram');
    const cv = {
      code: 'ABC',
      mode: 'PRICE',
      finalCents: 8000,
      discountLabel: '-R$ 20',
      minCents: null,
      validUntil: '2999-01-01T00:00:00.000Z',
    };
    job.data.couponView = cv;

    await (worker as any).process(job);

    expect(d.formatter.formatScored).toHaveBeenCalledWith(
      expect.anything(),
      'B',
      undefined,
      undefined,
      cv,
    );
  });

  it('drops an expired couponView (passes undefined)', async () => {
    const d = makeDeps();
    const worker = makeWorker(d);
    const job = makeJob('telegram');
    job.data.couponView = {
      code: 'OLD',
      mode: 'PRICE',
      finalCents: 8000,
      discountLabel: '-R$ 20',
      minCents: null,
      validUntil: '2000-01-01T00:00:00.000Z',
    };

    await (worker as any).process(job);

    expect(d.formatter.formatScored).toHaveBeenCalledWith(
      expect.anything(),
      'B',
      undefined,
      undefined,
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

describe('SendDealWorker stale-price re-check (single)', () => {
  it('fresh job: never calls the price scraper', async () => {
    const d = makeDeps();
    const worker = makeWorker(d);

    await (worker as any).process(makeJob('wa'));

    expect(d.scraper.scrapePriceView).not.toHaveBeenCalled();
  });

  it('stale job + scrape ok: publishes with the fresh priceView and recomputed coupon', async () => {
    const d = makeDeps();
    const worker = makeWorker(d);
    const job = makeJob('wa');
    job.timestamp = Date.now() - STALE_MS;
    // Frozen-at-enqueue views that must be superseded.
    job.data.priceView = freshView(9999);
    job.data.couponView = {
      code: 'OLD',
      mode: 'PRICE',
      finalCents: 9000,
      discountLabel: '-R$ 10',
      minCents: null,
      validUntil: '2999-01-01T00:00:00.000Z',
    };
    const view = freshView(5000);
    const freshCoupon = {
      code: 'NEW',
      mode: 'PRICE',
      finalCents: 4000,
      discountLabel: '-R$ 10',
      minCents: null,
      validUntil: '2999-01-01T00:00:00.000Z',
    };
    d.scraper.scrapePriceView.mockResolvedValue(view);
    d.coupons.resolveForDeal.mockResolvedValue(freshCoupon);

    await (worker as any).process(job);

    expect(d.scraper.scrapePriceView).toHaveBeenCalledWith('https://ml/p/MLB1');
    // Observed price beats estimated: raw fields corrected before formatting.
    expect(job.data.scored.deal.raw.priceCents).toBe(5000);
    expect(d.coupons.resolveForDeal).toHaveBeenCalledWith(
      job.data.scored.deal,
      5000,
    );
    expect(d.formatter.formatScored).toHaveBeenCalledWith(
      expect.anything(),
      'B',
      undefined,
      view,
      freshCoupon,
    );
    expect(d.publisher.publish).toHaveBeenCalledTimes(1);
  });

  it('stale job + scrape failure: discards silently and bumps stalePriceDrop', async () => {
    const d = makeDeps();
    const worker = makeWorker(d);
    const job = makeJob('wa');
    job.timestamp = Date.now() - STALE_MS;
    d.scraper.scrapePriceView.mockResolvedValue(null);

    await expect((worker as any).process(job)).resolves.toBeUndefined();

    expect(d.publisher.publish).not.toHaveBeenCalled();
    expect(d.dedup.markPosted).not.toHaveBeenCalled();
    expect(d.prisma.sentMessage.create).not.toHaveBeenCalled();
    expect(d.counters.stalePriceDrop.inc).toHaveBeenCalledTimes(1);
  });

  it('stale job + scraper throws: treated as failure (discard, no publish)', async () => {
    const d = makeDeps();
    const worker = makeWorker(d);
    const job = makeJob('wa');
    job.timestamp = Date.now() - STALE_MS;
    d.scraper.scrapePriceView.mockRejectedValue(new Error('browser gone'));

    await expect((worker as any).process(job)).resolves.toBeUndefined();

    expect(d.publisher.publish).not.toHaveBeenCalled();
    expect(d.counters.stalePriceDrop.inc).toHaveBeenCalledTimes(1);
  });

  it('respects SEND_MAX_JOB_AGE_MIN from config', async () => {
    const d = makeDeps();
    d.config.get.mockImplementation((key: string) =>
      key === 'SEND_MAX_JOB_AGE_MIN' ? '30' : undefined,
    );
    const worker = makeWorker(d);
    const job = makeJob('wa');
    job.timestamp = Date.now() - STALE_MS; // 11 min old < 30 min => fresh

    await (worker as any).process(job);

    expect(d.scraper.scrapePriceView).not.toHaveBeenCalled();
    expect(d.publisher.publish).toHaveBeenCalledTimes(1);
  });

  it('stale job + coupon re-resolve throws: publishes without a coupon', async () => {
    const d = makeDeps();
    const worker = makeWorker(d);
    const job = makeJob('wa');
    job.timestamp = Date.now() - STALE_MS;
    const view = freshView(5000);
    d.scraper.scrapePriceView.mockResolvedValue(view);
    d.coupons.resolveForDeal.mockRejectedValue(new Error('db down'));

    await (worker as any).process(job);

    expect(d.formatter.formatScored).toHaveBeenCalledWith(
      expect.anything(),
      'B',
      undefined,
      view,
      undefined,
    );
    expect(d.publisher.publish).toHaveBeenCalledTimes(1);
  });
});

describe('SendDealWorker curator edits (approval panel)', () => {
  it('stale job with an edited price: publishes without re-scraping (human price wins)', async () => {
    const d = makeDeps();
    const w = makeWorker(d);
    const job = makeJob('wa');
    job.timestamp = Date.now() - STALE_MS;
    job.data.scored.deal.raw.priceCents = 8400;
    job.data.scored.curatorEdits = { priceCents: 8400 };

    await (w as any).process(job);

    expect(d.scraper.scrapePriceView).not.toHaveBeenCalled();
    expect(d.counters.stalePriceDrop.inc).not.toHaveBeenCalled();
    expect(d.publisher.publish).toHaveBeenCalledTimes(1);
    // No PriceView: the caption falls back to the edited raw price.
    expect(d.formatter.formatScored.mock.calls[0][3]).toBeUndefined();
  });

  it('edited coupon overrides the job couponView on a fresh job', async () => {
    const d = makeDeps();
    const w = makeWorker(d);
    const job = makeJob('wa');
    job.data.couponView = {
      code: 'AUTO5',
      mode: 'PRICE',
      finalCents: 9500,
      discountLabel: '-R$ 5',
      minCents: null,
      validUntil: new Date(Date.now() + 3_600_000).toISOString(),
    };
    job.data.scored.curatorEdits = {
      coupon: { code: 'SHOW10', finalCents: 8000 },
    };

    await (w as any).process(job);

    const cv = d.formatter.formatScored.mock.calls[0][4];
    expect(cv).toMatchObject({
      code: 'SHOW10',
      mode: 'PRICE',
      finalCents: 8000,
    });
  });

  it('edited coupon survives the stale re-scrape (rebuilt against the fresh price)', async () => {
    const d = makeDeps();
    d.scraper.scrapePriceView.mockResolvedValue(freshView(9000));
    const w = makeWorker(d);
    const job = makeJob('wa');
    job.timestamp = Date.now() - STALE_MS;
    job.data.scored.curatorEdits = {
      coupon: { code: 'SHOW10', finalCents: 8000 },
    };

    await (w as any).process(job);

    // Price refreshed as usual (only the coupon was edited)…
    expect(d.scraper.scrapePriceView).toHaveBeenCalledTimes(1);
    expect(d.formatter.formatScored.mock.calls[0][3].priceCents).toBe(9000);
    // …but the coupon line is the curator's, not the re-resolved one.
    const cv = d.formatter.formatScored.mock.calls[0][4];
    expect(cv).toMatchObject({ code: 'SHOW10', finalCents: 8000 });
  });

  it('stale digest: edited-price deal is kept without re-scrape, others refresh normally', async () => {
    const d = makeDeps();
    d.scraper.scrapePriceView.mockResolvedValue(freshView(15000));
    const w = makeWorker(d);
    const job = makeDigestJob();
    job.timestamp = Date.now() - STALE_MS;
    job.data.deals[0].scored.deal.raw.priceCents = 8400;
    job.data.deals[0].scored.curatorEdits = { priceCents: 8400 };

    await (w as any).process(job);

    expect(d.scraper.scrapePriceView).toHaveBeenCalledTimes(1);
    expect(d.scraper.scrapePriceView).toHaveBeenCalledWith('https://ml/p/MLB2');
    expect(d.publisher.publish).toHaveBeenCalledTimes(1);
    const entries = d.formatter.formatDigest.mock.calls[0][0];
    expect(entries).toHaveLength(2);
    expect(entries[0].scored.deal.raw.priceCents).toBe(8400);
    expect(entries[0].priceView).toBeUndefined();
    expect(entries[1].priceView.priceCents).toBe(15000);
  });

  it('digest: edited coupon overrides the entry couponView', async () => {
    const d = makeDeps();
    const w = makeWorker(d);
    const job = makeDigestJob();
    job.data.deals[0].couponView = {
      code: 'AUTO5',
      mode: 'PRICE',
      finalCents: 9500,
      discountLabel: '-R$ 5',
      minCents: null,
      validUntil: new Date(Date.now() + 3_600_000).toISOString(),
    };
    job.data.deals[0].scored.curatorEdits = {
      coupon: { code: 'SHOW10', finalCents: 8000 },
    };

    await (w as any).process(job);

    const entries = d.formatter.formatDigest.mock.calls[0][0];
    expect(entries[0].couponView).toMatchObject({
      code: 'SHOW10',
      finalCents: 8000,
    });
    expect(entries[1].couponView).toBeUndefined();
  });
});

describe('SendDealWorker quiet hours + urgent (issue #7)', () => {
  function setNow(worker: SendDealWorker, t: () => number) {
    (worker as any).now = t;
  }

  /** Quiet switch on + QUIET_START == QUIET_END -> always inside the window. */
  function quietDeps() {
    const d = makeDeps();
    d.opsConfig.quietHoursEnabled.mockResolvedValue(true);
    d.config.get.mockImplementation((key: string) => {
      if (key === 'QUIET_START') return '5';
      if (key === 'QUIET_END') return '5';
      return undefined;
    });
    return d;
  }

  it('non-urgent job during quiet hours is delayed until the window ends, never published', async () => {
    const d = quietDeps();
    const w = makeWorker(d);
    const t = 1_000_000_000;
    setNow(w, () => t);
    const job = makeJob('wa');
    job.moveToDelayed = jest.fn().mockResolvedValue(undefined);

    await expect((w as any).process(job, 'tok')).rejects.toThrow(DelayedError);

    expect(d.publisher.publish).not.toHaveBeenCalled();
    expect(job.moveToDelayed).toHaveBeenCalledTimes(1);
    const [ts, token] = job.moveToDelayed.mock.calls[0];
    expect(ts).toBeGreaterThan(t);
    expect(token).toBe('tok');
  });

  it('urgent job pierces quiet hours and publishes immediately', async () => {
    const d = quietDeps();
    const w = makeWorker(d);
    const job = makeJob('wa');
    job.data.urgent = true;
    job.moveToDelayed = jest.fn();

    await (w as any).process(job, 'tok');

    expect(job.moveToDelayed).not.toHaveBeenCalled();
    expect(d.publisher.publish).toHaveBeenCalledTimes(1);
  });

  it('quiet master switch off: non-urgent publishes even inside the window', async () => {
    const d = quietDeps();
    d.opsConfig.quietHoursEnabled.mockResolvedValue(false);
    const w = makeWorker(d);
    const job = makeJob('wa');
    job.moveToDelayed = jest.fn();

    await (w as any).process(job);

    expect(job.moveToDelayed).not.toHaveBeenCalled();
    expect(d.publisher.publish).toHaveBeenCalledTimes(1);
  });

  it('digest jobs also respect the quiet-hours hold', async () => {
    const d = quietDeps();
    const w = makeWorker(d);
    const job = makeDigestJob();
    job.moveToDelayed = jest.fn().mockResolvedValue(undefined);

    await expect((w as any).process(job, 'tok')).rejects.toThrow(DelayedError);
    expect(d.publisher.publish).not.toHaveBeenCalled();
  });

  it('urgent keeps the WA anti-ban jitter, just a few seconds instead of the pacing window', async () => {
    const d = makeDeps();
    const w = makeWorker(d);
    const t = 1_000_000;
    setNow(w, () => t);
    (w as any).random = () => 0.5;

    const first = makeJob('wa');
    first.data.urgent = true;
    first.timestamp = t;
    await (w as any).process(first);
    expect((w as any).sleep).not.toHaveBeenCalled();

    const second = makeJob('wa');
    second.data.urgent = true;
    second.timestamp = t;
    await (w as any).process(second);

    // defaults: 2000 + 0.5 * (8000 - 2000) = 5000 — short, but NEVER zero.
    expect((w as any).sleep).toHaveBeenCalledTimes(1);
    expect((w as any).sleep).toHaveBeenCalledWith(5_000);
  });
});

describe('SendDealWorker WA jitter', () => {
  function setNow(worker: SendDealWorker, t: () => number) {
    (worker as any).now = t;
  }

  it('does not sleep before the first WA publish', async () => {
    const d = makeDeps();
    const worker = makeWorker(d);

    await (worker as any).process(makeJob('wa'));

    expect((worker as any).sleep).not.toHaveBeenCalled();
  });

  it('sleeps a random duration in [WA_JITTER_MIN_MS, WA_JITTER_MAX_MS] between consecutive WA publishes', async () => {
    const d = makeDeps();
    const worker = makeWorker(d);
    const t = 1_000_000;
    setNow(worker, () => t);
    (worker as any).random = () => 0.5;

    const first = makeJob('wa');
    first.timestamp = t;
    await (worker as any).process(first);
    expect((worker as any).sleep).not.toHaveBeenCalled();

    const second = makeJob('wa');
    second.timestamp = t;
    await (worker as any).process(second);

    // defaults: 30000 + 0.5 * (120000 - 30000) = 75000, no time elapsed
    expect((worker as any).sleep).toHaveBeenCalledTimes(1);
    expect((worker as any).sleep).toHaveBeenCalledWith(75_000);
  });

  it('discounts time already elapsed since the previous WA publish', async () => {
    const d = makeDeps();
    const worker = makeWorker(d);
    let t = 1_000_000;
    setNow(worker, () => t);
    (worker as any).random = () => 0.5;

    const first = makeJob('wa');
    first.timestamp = t;
    await (worker as any).process(first);

    t += 60_000; // 60s naturally elapsed; target 75s -> sleep only 15s
    const second = makeJob('wa');
    second.timestamp = t;
    await (worker as any).process(second);

    expect((worker as any).sleep).toHaveBeenCalledWith(15_000);
  });

  it('skips the sleep when more than the jitter target already elapsed', async () => {
    const d = makeDeps();
    const worker = makeWorker(d);
    let t = 1_000_000;
    setNow(worker, () => t);
    (worker as any).random = () => 0.5;

    const first = makeJob('wa');
    first.timestamp = t;
    await (worker as any).process(first);

    t += 300_000; // 5 min gap: no artificial wait needed
    const second = makeJob('wa');
    second.timestamp = t;
    await (worker as any).process(second);

    expect((worker as any).sleep).not.toHaveBeenCalled();
  });

  it('reads WA_JITTER_MIN_MS / WA_JITTER_MAX_MS from config', async () => {
    const d = makeDeps();
    d.config.get.mockImplementation((key: string) => {
      if (key === 'WA_JITTER_MIN_MS') return '1000';
      if (key === 'WA_JITTER_MAX_MS') return '2000';
      return undefined;
    });
    const worker = makeWorker(d);
    const t = 1_000_000;
    setNow(worker, () => t);
    (worker as any).random = () => 0.5;

    const first = makeJob('wa');
    first.timestamp = t;
    await (worker as any).process(first);
    const second = makeJob('wa');
    second.timestamp = t;
    await (worker as any).process(second);

    expect((worker as any).sleep).toHaveBeenCalledWith(1500);
  });

  it('never jitters telegram publishes', async () => {
    const d = makeDeps();
    const worker = makeWorker(d);

    await (worker as any).process(makeJob('telegram'));
    await (worker as any).process(makeJob('telegram'));

    expect((worker as any).sleep).not.toHaveBeenCalled();
  });

  it('jitters between a digest publish and the next single WA publish', async () => {
    const d = makeDeps();
    const worker = makeWorker(d);
    const t = 1_000_000;
    setNow(worker, () => t);
    (worker as any).random = () => 0;

    const digest = makeDigestJob();
    digest.timestamp = t;
    await (worker as any).process(digest);
    expect((worker as any).sleep).not.toHaveBeenCalled();

    const single = makeJob('wa');
    single.timestamp = t;
    await (worker as any).process(single);

    expect((worker as any).sleep).toHaveBeenCalledWith(30_000);
  });
});
