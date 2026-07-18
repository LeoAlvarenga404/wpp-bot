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

import {
  BadRequestException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { ApprovalQueueService } from '../approval-queue.service';
import { ManualDealService } from './manual-deal.service';
import {
  ManualResolveError,
  type ManualDealResolver,
  type ResolvedManualDeal,
} from './manual-resolver.port';

function resolved(): ResolvedManualDeal {
  return {
    key: { source: 'ml', externalId: 'MLB123' },
    source: 'ml',
    title: 'Produto',
    priceCents: 9990,
    originalPriceCents: 19990,
    discountPercent: 50,
    thumbnail: 'https://img/1.jpg',
    permalink: 'https://ml/p/MLB123',
    installmentsNoInterest: true,
  };
}

describe('ManualDealService', () => {
  const makeQueue = () =>
    ({
      createManual: jest.fn(async (sd) => ({ id: 'pending-1', snapshot: sd })),
    }) as unknown as ApprovalQueueService & { createManual: jest.Mock };

  it('picks the resolver that claims the URL and holds a manual pending card', async () => {
    const mlResolver: ManualDealResolver = {
      source: 'ml',
      canResolve: (u) => u.includes('mercadolivre'),
      resolve: jest.fn(async () => resolved()),
    };
    const queue = makeQueue();
    const svc = new ManualDealService([mlResolver], queue);

    const out = await svc.resolveUrl('https://mercadolivre.com.br/p/MLB123');

    expect(mlResolver.resolve).toHaveBeenCalledWith(
      'https://mercadolivre.com.br/p/MLB123',
    );
    expect(queue.createManual).toHaveBeenCalledTimes(1);
    const [sd] = queue.createManual.mock.calls[0];
    expect(sd.deal.key.externalId).toBe('MLB123');
    expect(sd.deal.raw.title).toBe('Produto');
    expect(sd.deal.raw.feedId).toBe('manual');
    expect(out).toMatchObject({ id: 'pending-1' });
  });

  it('rejects a URL no resolver claims with 400 unsupported_url', async () => {
    const mlResolver: ManualDealResolver = {
      source: 'ml',
      canResolve: () => false,
      resolve: jest.fn(),
    };
    const queue = makeQueue();
    const svc = new ManualDealService([mlResolver], queue);

    await expect(svc.resolveUrl('https://loja-x.com/y')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(queue.createManual).not.toHaveBeenCalled();
  });

  it('maps a scrape failure to 422 and never creates a phantom card', async () => {
    const mlResolver: ManualDealResolver = {
      source: 'ml',
      canResolve: () => true,
      resolve: jest.fn(async () => {
        throw new ManualResolveError('scrape_failed', 'não li a página');
      }),
    };
    const queue = makeQueue();
    const svc = new ManualDealService([mlResolver], queue);

    await expect(
      svc.resolveUrl('https://mercadolivre.com.br/p/MLB1'),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(queue.createManual).not.toHaveBeenCalled();
  });

  it('maps an invalid-url resolve error to 400', async () => {
    const mlResolver: ManualDealResolver = {
      source: 'ml',
      canResolve: () => true,
      resolve: jest.fn(async () => {
        throw new ManualResolveError('invalid_url', 'sem MLB');
      }),
    };
    const queue = makeQueue();
    const svc = new ManualDealService([mlResolver], queue);

    await expect(
      svc.resolveUrl('https://mercadolivre.com.br/ofertas'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(queue.createManual).not.toHaveBeenCalled();
  });
});
