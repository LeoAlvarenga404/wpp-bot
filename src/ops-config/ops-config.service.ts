import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OpsConfigRepo } from './ops-config.repo';

/**
 * Registry of every operational-config key the panel can edit. Keys reuse the
 * env var names so the db → env → default fallback chain stays obvious.
 * Adding a key here is all it takes — values live as strings in OpsConfig.
 */
export const OPS_CONFIG_KEYS = {
  /** Deals scoring >= this go out automatically; below it, approval queue.
   *  999 = all-manual (calibration phase). */
  AUTO_APPROVE_SCORE: { type: 'number', default: '999' },
  QUIET_HOURS_ENABLED: { type: 'boolean', default: 'true' },
  /** Minutes between "N deals waiting" DM batches to the operator. */
  DM_BATCH_INTERVAL_MIN: { type: 'number', default: '30' },
} as const;

export type OpsConfigKey = keyof typeof OPS_CONFIG_KEYS;

export interface EffectiveConfig {
  key: OpsConfigKey;
  value: string;
  source: 'db' | 'env' | 'default';
}

/**
 * Operational config with immediate effect: reads hit the database on every
 * call (no cache — consumers are low-frequency crons and panel requests), so
 * a panel edit applies to the very next tick without any container recreate.
 * Missing/malformed db value falls back to env, then to the registry default.
 */
@Injectable()
export class OpsConfigService {
  constructor(
    private readonly repo: OpsConfigRepo,
    private readonly config: ConfigService,
  ) {}

  async autoApproveScore(): Promise<number> {
    return this.getNumber('AUTO_APPROVE_SCORE');
  }

  async quietHoursEnabled(): Promise<boolean> {
    return this.getBoolean('QUIET_HOURS_ENABLED');
  }

  async dmBatchIntervalMin(): Promise<number> {
    return this.getNumber('DM_BATCH_INTERVAL_MIN');
  }

  async set(key: string, value: string): Promise<void> {
    const spec = OPS_CONFIG_KEYS[key as OpsConfigKey];
    if (!spec) {
      throw new BadRequestException(
        `Unknown ops-config key '${key}'. Known keys: ${Object.keys(OPS_CONFIG_KEYS).join(', ')}`,
      );
    }
    if (!this.isValid(spec.type, value)) {
      const expected =
        spec.type === 'number' ? 'a number' : "'true' or 'false'";
      throw new BadRequestException(
        `Key '${key}' expects ${expected}, got '${value}'`,
      );
    }
    await this.repo.set(key, value.trim());
  }

  async getAllEffective(): Promise<EffectiveConfig[]> {
    const rows = new Map(
      (await this.repo.getAll()).map((r) => [r.key, r.value]),
    );
    return (Object.keys(OPS_CONFIG_KEYS) as OpsConfigKey[]).map((key) =>
      this.resolve(key, rows.get(key) ?? null),
    );
  }

  private async effective(key: OpsConfigKey): Promise<EffectiveConfig> {
    return this.resolve(key, await this.repo.get(key));
  }

  private resolve(key: OpsConfigKey, dbValue: string | null): EffectiveConfig {
    const spec = OPS_CONFIG_KEYS[key];
    if (dbValue != null && this.isValid(spec.type, dbValue)) {
      return { key, value: dbValue, source: 'db' };
    }
    // NOTE: config.get only, no `?? process.env` fallback — requiring
    // @prisma/client side-loads the repo's .env into process.env under Jest
    // (see scheduler.service.ts for the full story). ConfigService already
    // reads .env in production.
    const envValue = this.config.get<string>(key);
    if (envValue != null && this.isValid(spec.type, envValue)) {
      return { key, value: envValue, source: 'env' };
    }
    return { key, value: spec.default, source: 'default' };
  }

  private async getNumber(key: OpsConfigKey): Promise<number> {
    return Number((await this.effective(key)).value);
  }

  private async getBoolean(key: OpsConfigKey): Promise<boolean> {
    return (await this.effective(key)).value.toLowerCase() !== 'false';
  }

  private isValid(type: 'number' | 'boolean', value: string): boolean {
    return type === 'number' ? isFiniteNumber(value) : isBooleanString(value);
  }
}

function isFiniteNumber(value: string): boolean {
  return value.trim() !== '' && Number.isFinite(Number(value));
}

function isBooleanString(value: string): boolean {
  const v = value.trim().toLowerCase();
  return v === 'true' || v === 'false';
}
