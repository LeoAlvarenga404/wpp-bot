import { Injectable } from '@nestjs/common';
import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from 'prom-client';

@Injectable()
export class CountersService {
  public readonly register: Registry;

  public readonly wppMessagesSent: Counter<string>;
  public readonly wppMessagesFailed: Counter<string>;
  public readonly mlApiRequests: Counter<string>;
  public readonly mlApiLatencyMs: Histogram<string>;
  public readonly affiliateCacheHits: Counter<string>;
  public readonly affiliateCacheMisses: Counter<string>;
  public readonly dedupSkip: Counter<string>;
  public readonly judgeApprove: Counter<string>;
  public readonly judgeReject: Counter<string>;
  public readonly judgeError: Counter<string>;
  public readonly headlineFrameUsed: Counter<string>;
  public readonly baileysConnected: Gauge<string>;

  constructor() {
    this.register = new Registry();
    collectDefaultMetrics({ register: this.register });

    this.wppMessagesSent = new Counter({
      name: 'wpp_messages_sent_total',
      help: 'Total WhatsApp messages sent successfully',
      labelNames: ['category'],
      registers: [this.register],
    });

    this.wppMessagesFailed = new Counter({
      name: 'wpp_messages_failed_total',
      help: 'Total WhatsApp messages that failed to send',
      labelNames: ['reason'],
      registers: [this.register],
    });

    this.mlApiRequests = new Counter({
      name: 'ml_api_requests_total',
      help: 'Total Mercado Livre API requests',
      labelNames: ['endpoint', 'status'],
      registers: [this.register],
    });

    this.mlApiLatencyMs = new Histogram({
      name: 'ml_api_latency_ms',
      help: 'Mercado Livre API request latency in milliseconds',
      labelNames: ['endpoint'],
      buckets: [50, 100, 250, 500, 1000, 2500, 5000, 10000],
      registers: [this.register],
    });

    this.affiliateCacheHits = new Counter({
      name: 'affiliate_cache_hits_total',
      help: 'Total affiliate link cache hits',
      registers: [this.register],
    });

    this.affiliateCacheMisses = new Counter({
      name: 'affiliate_cache_misses_total',
      help: 'Total affiliate link cache misses',
      registers: [this.register],
    });

    this.dedupSkip = new Counter({
      name: 'dedup_skip_total',
      help: 'Total items skipped by dedup',
      registers: [this.register],
    });

    this.judgeApprove = new Counter({
      name: 'curation_judge_approve_total',
      help: 'Gray-zone deals approved by the LLM judge',
      registers: [this.register],
    });

    this.judgeReject = new Counter({
      name: 'curation_judge_reject_total',
      help: 'Gray-zone deals rejected by the LLM judge',
      registers: [this.register],
    });

    this.judgeError = new Counter({
      name: 'curation_judge_error_total',
      help: 'Judge calls that failed (fail-closed: deal not posted)',
      registers: [this.register],
    });

    this.headlineFrameUsed = new Counter({
      name: 'headline_frame_used_total',
      help: 'Headlines generated per LLM style frame (observability for weight tuning)',
      labelNames: ['frame'],
      registers: [this.register],
    });

    this.baileysConnected = new Gauge({
      name: 'baileys_connected',
      help: 'Baileys WhatsApp socket connection status (1 = connected, 0 = disconnected)',
      registers: [this.register],
    });
  }
}
