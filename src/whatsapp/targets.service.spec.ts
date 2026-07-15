import { ConfigService } from '@nestjs/config';
import * as os from 'os';
import * as path from 'path';
import type { TargetsRepo } from './targets.repo';
import { TargetsService, WaTarget } from './targets.service';

class InMemoryTargetsRepo implements TargetsRepo {
  private rows = new Map<string, WaTarget>();

  async findAll(): Promise<WaTarget[]> {
    return [...this.rows.values()];
  }
  async findOne(jid: string): Promise<WaTarget | null> {
    return this.rows.get(jid) ?? null;
  }
  async upsert(t: WaTarget): Promise<WaTarget> {
    this.rows.set(t.jid, { ...t });
    return { ...t };
  }
  async delete(jid: string): Promise<boolean> {
    return this.rows.delete(jid);
  }
  async count(): Promise<number> {
    return this.rows.size;
  }
  async importMany(targets: WaTarget[]): Promise<void> {
    for (const t of targets) this.rows.set(t.jid, { ...t });
  }
}

function makeService(env: Record<string, string> = {}): TargetsService {
  const config = {
    get: (k: string, def?: string) => env[k] ?? def,
  } as unknown as ConfigService;
  const svc = new TargetsService(config, new InMemoryTargetsRepo());
  // Point legacy JSON backfill at a non-existent file.
  (svc as any).jsonBackfillPath = path.join(
    os.tmpdir(),
    `wpp-no-such-${Date.now()}.json`,
  );
  return svc;
}

describe('TargetsService channels', () => {
  it('defaults channel to wa and filters active targets with channel', async () => {
    const svc = makeService();
    await svc.add('123@g.us', 'grupo');
    await svc.add('-100555', 'canal tg', 'telegram');

    const targets = await svc.getActiveTargets();

    expect(targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ jid: '123@g.us', channel: 'wa' }),
        expect.objectContaining({ jid: '-100555', channel: 'telegram' }),
      ]),
    );
  });

  it('getActiveTargets excludes inactive targets', async () => {
    const svc = makeService();
    await svc.add('123@g.us', 'grupo');
    await svc.add('456@g.us', 'outro');
    await svc.setActive('456@g.us', false);

    const targets = await svc.getActiveTargets();

    expect(targets.map((t) => t.jid)).toEqual(['123@g.us']);
  });

  it('seeds telegram target from TELEGRAM_CHAT_ID env', async () => {
    const svc = makeService({ TELEGRAM_CHAT_ID: '-100999' });
    await svc.onModuleInit();

    const targets = await svc.getActiveTargets();

    expect(targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          jid: '-100999',
          channel: 'telegram',
          active: true,
        }),
      ]),
    );
  });

  it('seeds wa target from WA_TARGET_JID env with channel wa', async () => {
    const svc = makeService({ WA_TARGET_JID: '123@g.us' });
    await svc.onModuleInit();

    const targets = await svc.getActiveTargets();

    expect(targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ jid: '123@g.us', channel: 'wa' }),
      ]),
    );
  });

  it('getActiveJids stays backward compatible', async () => {
    const svc = makeService();
    await svc.add('123@g.us', 'grupo');
    expect(await svc.getActiveJids()).toEqual(['123@g.us']);
  });
});
