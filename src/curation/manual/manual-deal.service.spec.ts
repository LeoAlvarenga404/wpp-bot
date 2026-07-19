// ManualDealService imports ApprovalQueueService for DI, which pulls
// PipelineService → wa.service → Baileys (won't load under Jest). Same mocks
// as approval-queue.service.spec.
jest.mock('@whiskeysockets/baileys', () => ({}));
jest.mock('@hapi/boom', () => ({ Boom: class Boom {} }));
jest.mock('@sentry/node', () => ({
  captureException: jest.fn(),
  init: jest.fn(),
}));
jest.mock('../../whatsapp/wa.service');

import { ManualDealService } from './manual-deal.service';

const resolved = {
  key: { source: 'ml', externalId: 'MLB123' },
  source: 'ml' as const,
  title: 'Fone JBL',
  priceCents: 17900,
  originalPriceCents: 29900,
  discountPercent: 40,
  thumbnail: 'https://http2.mlstatic.com/x.jpg',
  permalink: 'https://www.mercadolivre.com.br/p/MLB123',
  installmentsNoInterest: true,
};

function make() {
  const resolver = {
    canResolve: jest.fn().mockReturnValue(true),
    resolve: jest.fn().mockResolvedValue(resolved),
    source: 'ml',
  };
  const queue = {
    createManual: jest
      .fn()
      .mockResolvedValue({ id: 'card1', catalogId: 'ml:MLB123' }),
    approve: jest.fn().mockResolvedValue({
      id: 'card1',
      catalogId: 'ml:MLB123',
      enqueued: 1,
      targets: 2,
    }),
    renderManualPreview: jest
      .fn()
      .mockResolvedValue({ caption: 'cap JBL20', imageUrl: 'img' }),
  };
  const service = new ManualDealService([resolver] as never, queue as never);
  return { service, resolver, queue };
}

const base = {
  store: 'ml',
  title: 'Fone JBL',
  priceCents: 17900,
  thumbnail: 'https://http2.mlstatic.com/x.jpg',
};

describe('resolveUrl', () => {
  it('returns prefill fields and creates NO card', async () => {
    const { service, queue } = make();
    const out = await service.resolveUrl('https://meli.la/x');
    expect(out.title).toBe('Fone JBL');
    expect(out.permalink).toBe('https://www.mercadolivre.com.br/p/MLB123');
    expect(queue.createManual).not.toHaveBeenCalled();
  });
});

describe('preview', () => {
  it('renders via renderManualPreview with the coupon applied', async () => {
    const { service, queue } = make();
    const out = await service.preview({
      ...base,
      coupon: { code: 'JBL20', finalCents: 15000 },
    } as never);
    expect(out.caption).toContain('JBL20');
    const sd = queue.renderManualPreview.mock.calls[0][0];
    expect(sd.curatorEdits.coupon).toEqual({
      code: 'JBL20',
      finalCents: 15000,
    });
  });
});

describe('submit', () => {
  it('dispatch=false creates a pending card only', async () => {
    const { service, queue } = make();
    await service.submit({ ...base, permalink: resolved.permalink } as never);
    expect(queue.createManual).toHaveBeenCalledTimes(1);
    expect(queue.approve).not.toHaveBeenCalled();
  });

  it('dispatch=true creates the card then approves urgent', async () => {
    const { service, queue } = make();
    const out = await service.submit({
      ...base,
      permalink: resolved.permalink,
      dispatch: true,
    } as never);
    expect(queue.approve).toHaveBeenCalledWith('card1', undefined, {
      urgent: true,
    });
    expect(out).toMatchObject({ enqueued: 1, targets: 2 });
  });

  it('derives the ML catalog id from the permalink so dedup aligns', async () => {
    const { service, queue } = make();
    await service.submit({ ...base, permalink: resolved.permalink } as never);
    const sd = queue.createManual.mock.calls[0][0];
    expect(sd.deal.key).toEqual({ source: 'ml', externalId: 'MLB123' });
  });

  it('hashes a permalink-less manual deal into a stable id', async () => {
    const { service, queue } = make();
    await service.submit({ ...base, store: 'outro' } as never);
    const sd = queue.createManual.mock.calls[0][0];
    expect(sd.deal.key.source).toBe('outro');
    expect(sd.deal.key.externalId).toHaveLength(12);
  });
});
