import { PrismaCurationDecisionRepo } from './curation-decision.repo';

function makePrisma() {
  return {
    curationDecision: {
      upsert: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 3 }),
    },
  };
}

describe('PrismaCurationDecisionRepo', () => {
  it('upserts on (catalogId, stage, day) and increments count on update', async () => {
    const prisma = makePrisma();
    const repo = new PrismaCurationDecisionRepo(prisma as any);

    await repo.upsert({
      catalogId: 'ml:MLB1',
      stage: 'fake_discount',
      outcome: 'rejected',
      day: '2026-07-15',
      priceCents: 9990,
    });

    expect(prisma.curationDecision.upsert).toHaveBeenCalledWith({
      where: {
        catalogId_stage_day: {
          catalogId: 'ml:MLB1',
          stage: 'fake_discount',
          day: '2026-07-15',
        },
      },
      create: expect.objectContaining({
        catalogId: 'ml:MLB1',
        stage: 'fake_discount',
        outcome: 'rejected',
        day: '2026-07-15',
        priceCents: 9990,
      }),
      update: expect.objectContaining({
        count: { increment: 1 },
        outcome: 'rejected',
        priceCents: 9990,
      }),
    });
  });

  it('prunes rows older than cutoff by firstAt', async () => {
    const prisma = makePrisma();
    const repo = new PrismaCurationDecisionRepo(prisma as any);
    const cutoff = new Date('2026-05-16T00:00:00Z');

    const n = await repo.pruneOlderThan(cutoff);

    expect(n).toBe(3);
    expect(prisma.curationDecision.deleteMany).toHaveBeenCalledWith({
      where: { firstAt: { lt: cutoff } },
    });
  });
});
