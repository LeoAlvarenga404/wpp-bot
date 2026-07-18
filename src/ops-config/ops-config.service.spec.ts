import { BadRequestException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { OpsConfigRepo } from './ops-config.repo';
import { OpsConfigService } from './ops-config.service';

function makeRepo(rows: Record<string, string> = {}): OpsConfigRepo {
  const store = new Map(Object.entries(rows));
  return {
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    set: jest.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    getAll: jest.fn(async () =>
      [...store.entries()].map(([key, value]) => ({ key, value })),
    ),
  } as unknown as OpsConfigRepo;
}

function makeConfig(env: Record<string, string>): ConfigService {
  return {
    get: (k: string, def?: string) => env[k] ?? def,
  } as unknown as ConfigService;
}

describe('OpsConfigService fallback chain (db → env → default)', () => {
  it('AUTO_APPROVE_SCORE comes from the db row when present', async () => {
    const svc = new OpsConfigService(
      makeRepo({ AUTO_APPROVE_SCORE: '80' }),
      makeConfig({ AUTO_APPROVE_SCORE: '70' }),
    );
    expect(await svc.autoApproveScore()).toBe(80);
  });

  it('AUTO_APPROVE_SCORE falls back to env when no db row', async () => {
    const svc = new OpsConfigService(
      makeRepo(),
      makeConfig({ AUTO_APPROVE_SCORE: '70' }),
    );
    expect(await svc.autoApproveScore()).toBe(70);
  });

  it('AUTO_APPROVE_SCORE defaults to 999 (all-manual) when db and env are unset', async () => {
    const svc = new OpsConfigService(makeRepo(), makeConfig({}));
    expect(await svc.autoApproveScore()).toBe(999);
  });

  it('QUIET_HOURS_ENABLED reads the db row over env', async () => {
    const svc = new OpsConfigService(
      makeRepo({ QUIET_HOURS_ENABLED: 'false' }),
      makeConfig({ QUIET_HOURS_ENABLED: 'true' }),
    );
    expect(await svc.quietHoursEnabled()).toBe(false);
  });

  it('QUIET_HOURS_ENABLED falls back to env, then defaults to true', async () => {
    const fromEnv = new OpsConfigService(
      makeRepo(),
      makeConfig({ QUIET_HOURS_ENABLED: 'false' }),
    );
    expect(await fromEnv.quietHoursEnabled()).toBe(false);

    const fromDefault = new OpsConfigService(makeRepo(), makeConfig({}));
    expect(await fromDefault.quietHoursEnabled()).toBe(true);
  });

  it('DM_BATCH_INTERVAL_MIN defaults to 30', async () => {
    const svc = new OpsConfigService(makeRepo(), makeConfig({}));
    expect(await svc.dmBatchIntervalMin()).toBe(30);
  });

  it('ignores a malformed number in the db and falls back', async () => {
    const svc = new OpsConfigService(
      makeRepo({ AUTO_APPROVE_SCORE: 'not-a-number' }),
      makeConfig({ AUTO_APPROVE_SCORE: '70' }),
    );
    expect(await svc.autoApproveScore()).toBe(70);
  });
});

describe('OpsConfigService.set', () => {
  it('persists a valid numeric value and takes effect immediately', async () => {
    const repo = makeRepo();
    const svc = new OpsConfigService(repo, makeConfig({}));

    await svc.set('AUTO_APPROVE_SCORE', '85');

    expect(await svc.autoApproveScore()).toBe(85);
  });

  it('rejects an unknown key', async () => {
    const svc = new OpsConfigService(makeRepo(), makeConfig({}));
    await expect(svc.set('NOT_A_KEY', '1')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('rejects a non-numeric value for a number key', async () => {
    const svc = new OpsConfigService(makeRepo(), makeConfig({}));
    await expect(svc.set('AUTO_APPROVE_SCORE', 'abc')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('rejects a non-boolean value for a boolean key', async () => {
    const svc = new OpsConfigService(makeRepo(), makeConfig({}));
    await expect(svc.set('QUIET_HOURS_ENABLED', 'sim')).rejects.toThrow(
      BadRequestException,
    );
  });
});

describe('OpsConfigService.getAllEffective', () => {
  it('reports every known key with its effective value and source', async () => {
    const svc = new OpsConfigService(
      makeRepo({ AUTO_APPROVE_SCORE: '80' }),
      makeConfig({ QUIET_HOURS_ENABLED: 'false' }),
    );

    const all = await svc.getAllEffective();

    expect(all).toEqual(
      expect.arrayContaining([
        { key: 'AUTO_APPROVE_SCORE', value: '80', source: 'db' },
        { key: 'QUIET_HOURS_ENABLED', value: 'false', source: 'env' },
        { key: 'DM_BATCH_INTERVAL_MIN', value: '30', source: 'default' },
      ]),
    );
  });
});
