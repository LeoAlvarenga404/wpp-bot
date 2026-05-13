import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs/promises';
import * as path from 'path';
import { AffiliateLinkPort } from './affiliate-link.port';

@Injectable()
export class JsonCacheAffiliateAdapter implements AffiliateLinkPort, OnModuleInit {
  private readonly logger = new Logger(JsonCacheAffiliateAdapter.name);
  private cache: Record<string, string> = {};
  private filePath!: string;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit() {
    this.filePath = path.resolve(
      this.config.get<string>('AFFILIATE_LINKS_PATH', './affiliate-links.json'),
    );
    await this.reload();
  }

  async reload(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      this.cache = parsed && typeof parsed === 'object' ? parsed : {};
      this.logger.log(
        `Loaded ${Object.keys(this.cache).length} affiliate links from ${this.filePath}`,
      );
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        this.logger.warn(
          `${this.filePath} not found — falling back to UTM tag for every link`,
        );
        this.cache = {};
      } else {
        this.logger.error(`Failed to load ${this.filePath}`, err);
      }
    }
  }

  async resolve(originalUrl: string): Promise<string> {
    if (this.cache[originalUrl]) return this.cache[originalUrl];

    const catalogMatch = originalUrl.match(/\/p\/(MLB\d+)/i);
    if (catalogMatch && this.cache[catalogMatch[1]]) {
      return this.cache[catalogMatch[1]];
    }

    return this.fallbackUtm(originalUrl);
  }

  private fallbackUtm(url: string): string {
    const tag = this.config.get<string>('ML_AFFILIATE_TAG', '');
    if (!tag) return url;
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}ref=${encodeURIComponent(tag)}`;
  }
}
