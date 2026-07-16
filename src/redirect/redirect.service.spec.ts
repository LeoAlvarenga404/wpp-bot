import { RedirectService } from './redirect.service';

type PrismaMock = {
  shortLink: {
    findFirst: jest.Mock;
    findUnique: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
  };
};

function makePrisma(): PrismaMock {
  return {
    shortLink: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn(
        async ({ data }: { data: Record<string, unknown> }) => data,
      ),
      update: jest.fn().mockResolvedValue({}),
    },
  };
}

function makeService(prisma: PrismaMock = makePrisma()) {
  return {
    service: new RedirectService(prisma as never),
    prisma,
  };
}

describe('RedirectService', () => {
  const ORIGINAL_ENV = process.env.REDIRECT_BASE_URL;

  beforeEach(() => {
    process.env.REDIRECT_BASE_URL = 'https://links.example.com';
  });

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.REDIRECT_BASE_URL;
    else process.env.REDIRECT_BASE_URL = ORIGINAL_ENV;
  });

  describe('shorten', () => {
    it('creates a row with a 6-8 char base62 code and returns the short URL', async () => {
      const { service, prisma } = makeService();

      const shortUrl = await service.shorten('https://ml/produto', {
        dealKey: 'ml:MLB1',
        channel: 'wa',
      });

      expect(prisma.shortLink.create).toHaveBeenCalledTimes(1);
      const data = prisma.shortLink.create.mock.calls[0][0].data;
      expect(data.url).toBe('https://ml/produto');
      expect(data.dealKey).toBe('ml:MLB1');
      expect(data.channel).toBe('wa');
      expect(data.code).toMatch(/^[0-9A-Za-z]{6,8}$/);
      expect(shortUrl).toBe(`https://links.example.com/r/${data.code}`);
    });

    it('strips a trailing slash from REDIRECT_BASE_URL', async () => {
      process.env.REDIRECT_BASE_URL = 'https://links.example.com/';
      const { service } = makeService();

      const shortUrl = await service.shorten('https://ml/x');

      expect(shortUrl).toMatch(/^https:\/\/links\.example\.com\/r\/[^/]+$/);
    });

    it('reuses the existing row for the same url+dealKey+channel', async () => {
      const { service, prisma } = makeService();
      prisma.shortLink.findFirst.mockResolvedValue({
        code: 'abc1234',
        url: 'https://ml/produto',
      });

      const shortUrl = await service.shorten('https://ml/produto', {
        dealKey: 'ml:MLB1',
      });

      expect(shortUrl).toBe('https://links.example.com/r/abc1234');
      expect(prisma.shortLink.create).not.toHaveBeenCalled();
      expect(prisma.shortLink.findFirst).toHaveBeenCalledWith({
        where: { url: 'https://ml/produto', dealKey: 'ml:MLB1', channel: null },
      });
    });

    it('retries with a new code on unique-violation (P2002)', async () => {
      const { service, prisma } = makeService();
      prisma.shortLink.create
        .mockRejectedValueOnce({ code: 'P2002' })
        .mockImplementationOnce(
          async ({ data }: { data: Record<string, unknown> }) => data,
        );

      const shortUrl = await service.shorten('https://ml/y');

      expect(prisma.shortLink.create).toHaveBeenCalledTimes(2);
      expect(shortUrl).toContain('https://links.example.com/r/');
    });

    it('throws when REDIRECT_BASE_URL is empty', async () => {
      process.env.REDIRECT_BASE_URL = '';
      const { service } = makeService();

      await expect(service.shorten('https://ml/z')).rejects.toThrow(
        /REDIRECT_BASE_URL/,
      );
    });
  });

  describe('wrapIfEnabled', () => {
    it('returns the original url unchanged when REDIRECT_BASE_URL is empty (feature off)', async () => {
      process.env.REDIRECT_BASE_URL = '';
      const { service, prisma } = makeService();

      const out = await service.wrapIfEnabled('https://meli.la/ABC');

      expect(out).toBe('https://meli.la/ABC');
      expect(prisma.shortLink.findFirst).not.toHaveBeenCalled();
      expect(prisma.shortLink.create).not.toHaveBeenCalled();
    });

    it('returns the short url when enabled', async () => {
      const { service } = makeService();

      const out = await service.wrapIfEnabled('https://meli.la/ABC', {
        dealKey: 'ml:MLB1',
      });

      expect(out).toMatch(/^https:\/\/links\.example\.com\/r\/[0-9A-Za-z]+$/);
    });

    it('falls back to the original url when the DB errors (never breaks the caption)', async () => {
      const { service, prisma } = makeService();
      prisma.shortLink.findFirst.mockRejectedValue(new Error('db down'));

      const out = await service.wrapIfEnabled('https://meli.la/ABC');

      expect(out).toBe('https://meli.la/ABC');
    });
  });

  describe('resolve / trackClick', () => {
    it('resolve returns the row for a known code', async () => {
      const { service, prisma } = makeService();
      prisma.shortLink.findUnique.mockResolvedValue({
        code: 'abc1234',
        url: 'https://ml/produto',
      });

      const row = await service.resolve('abc1234');

      expect(row?.url).toBe('https://ml/produto');
      expect(prisma.shortLink.findUnique).toHaveBeenCalledWith({
        where: { code: 'abc1234' },
      });
    });

    it('resolve returns null for an unknown code', async () => {
      const { service } = makeService();

      expect(await service.resolve('nope')).toBeNull();
    });

    it('trackClick increments clicks fire-and-forget and swallows errors', async () => {
      const { service, prisma } = makeService();
      prisma.shortLink.update.mockRejectedValue(new Error('db down'));

      expect(() => service.trackClick('abc1234')).not.toThrow();
      // flush microtasks so the rejected promise is handled
      await new Promise((r) => setImmediate(r));

      expect(prisma.shortLink.update).toHaveBeenCalledWith({
        where: { code: 'abc1234' },
        data: { clicks: { increment: 1 } },
      });
    });
  });
});
