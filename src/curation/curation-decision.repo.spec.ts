import { PrismaCurationDecisionRepo } from './curation-decision.repo';

function makePrisma() {
  return {
    curationDecision: {
      upsert: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 3 }),
      groupBy: jest.fn(),
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

  it('aggregates calibration stats correctly', async () => {
    const prisma = makePrisma();
    prisma.curationDecision.groupBy = jest.fn().mockResolvedValue([
      { outcome: 'approved', _sum: { count: 10 }, _avg: { score: 95 } },
      { outcome: 'rejected', _sum: { count: 42 }, _avg: { score: 32.4 } },
      { outcome: 'expired', _sum: { count: 5 }, _avg: { score: null } },
    ]);
    const repo = new PrismaCurationDecisionRepo(prisma as any);
    
    const stats = await repo.getCalibrationStats(7);
    
    expect(stats).toEqual({
      periodDays: 7,
      approved: 10,
      rejected: 42,
      expired: 5,
      avgApprovedScore: 95,
      avgRejectedScore: 32,
    });
    
    // Check that gte date is roughly 7 days ago
    const callArgs = prisma.curationDecision.groupBy.mock.calls[0][0];
    const dateUsed = callArgs.where.firstAt.gte;
    const expectedTime = new Date().getTime() - 7 * 24 * 3600 * 1000;
    expect(Math.abs(dateUsed.getTime() - expectedTime)).toBeLessThan(1000 * 5); // 5s tolerance
  });
});
