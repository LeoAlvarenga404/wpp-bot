import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Job, Worker } from 'bullmq';
import type { ConnectionOptions } from 'bullmq';
import { DedupService } from '../dedup/dedup.service';
import { CountersService } from '../metrics/counters.service';
import { FormatterService } from '../pipeline/formatter.service';
import { SEND_DEAL_QUEUE, SendDealJob } from '../queue/queue.types';
import { keyToString } from '../sources/source.port';
import { WhatsappService } from '../whatsapp/wa.service';

/**
 * Worker that consumes `send-deal` jobs and dispatches them through Baileys.
 * BullMQ handles retries (5 attempts, exponential backoff defined on the
 * queue). On success the deal is marked posted in `DedupEntry` so retries
 * from a later run don't re-publish it.
 *
 * Errors classified as "throttled:*" are surfaced as job failures so BullMQ
 * applies its retry strategy — they typically mean the per-chip rate limit
 * window will reopen within minutes. Other errors (formatter failure, fatal
 * WhatsApp errors) likewise fail and retry; if they exhaust attempts BullMQ
 * keeps them in the dead-letter set for inspection.
 */
@Injectable()
export class SendDealWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SendDealWorker.name);
  private worker: Worker<SendDealJob> | null = null;

  constructor(
    @Inject('REDIS_CONNECTION_OPTIONS')
    private readonly connection: ConnectionOptions,
    private readonly wa: WhatsappService,
    private readonly formatter: FormatterService,
    private readonly dedup: DedupService,
    private readonly counters: CountersService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.worker = new Worker<SendDealJob>(
      SEND_DEAL_QUEUE,
      async (job) => this.process(job),
      {
        connection: this.connection,
        concurrency: 1,
        // The per-chip warmup limiter inside WhatsappService is the
        // authoritative throttle; this rate-limiter is a soft secondary
        // cap to keep the queue from hammering Redis on tight loops.
        limiter: { max: 30, duration: 60_000 },
      },
    );

    this.worker.on('failed', (job, err) => {
      const attempts = job?.attemptsMade ?? 0;
      const max = job?.opts.attempts ?? 1;
      this.logger.warn(
        `send-deal job ${job?.id} failed (attempt ${attempts}/${max}): ${err?.message}`,
      );
      this.counters.wppMessagesFailed
        .labels(this.classifyReason(err?.message ?? ''))
        .inc();
    });

    this.worker.on('completed', (job) => {
      const scored = job.data.scored;
      const category = scored.deal.key.source ?? 'unknown';
      this.counters.wppMessagesSent.labels(category).inc();
    });

    this.logger.log(`SendDealWorker listening on queue=${SEND_DEAL_QUEUE}`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }

  private async process(job: Job<SendDealJob>): Promise<void> {
    const { targetJid, scored } = job.data;
    const keyStr = keyToString(scored.deal.key);

    if (!this.wa.isReady()) {
      throw new Error('whatsapp_not_ready');
    }

    const { caption, imageUrl } = await this.formatter.formatScored(scored);
    if (imageUrl) {
      await this.wa.sendImage(targetJid, imageUrl, caption);
    } else {
      await this.wa.sendText(targetJid, caption);
    }
    await this.dedup.markPosted(keyStr);
    this.logger.log(
      `send-deal job ${job.id} ok (${keyStr} -> ${targetJid}, level=${scored.level}, score=${scored.score})`,
    );
  }

  /** Map BullMQ error messages to short labels for Prometheus. */
  private classifyReason(msg: string): string {
    if (msg.startsWith('throttled:')) return msg.slice('throttled:'.length);
    if (msg.includes('whatsapp_not_ready')) return 'wa_not_ready';
    if (msg.includes('formatter')) return 'formatter_error';
    return 'other';
  }
}
