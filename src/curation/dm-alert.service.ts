import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { OpsConfigService } from '../ops-config/ops-config.service';
import { PublisherRegistry } from '../publisher/publisher-registry.service';
import { isQuietHours } from '../scheduler/quiet-hours';
import { APPROVAL_QUEUE_REPO, type ApprovalQueueRepo } from './approval-queue.repo';

@Injectable()
export class DmAlertService {
  private readonly logger = new Logger(DmAlertService.name);
  private lastAlertSentAt = 0;

  constructor(
    @Inject(APPROVAL_QUEUE_REPO) private readonly repo: ApprovalQueueRepo,
    private readonly opsConfig: OpsConfigService,
    private readonly config: ConfigService,
    private readonly publishers: PublisherRegistry,
  ) {}

  @Cron('* * * * *')
  async checkAndSendAlert(): Promise<void> {
    const jid = await this.opsConfig.operatorJid();
    if (!jid) {
      return; // No operator JID configured
    }

    const intervalMin = await this.opsConfig.dmBatchIntervalMin();
    const now = this.now();
    const msSinceLast = now.getTime() - this.lastAlertSentAt;
    
    if (msSinceLast < intervalMin * 60_000) {
      return;
    }

    const quietEnabled = await this.opsConfig.quietHoursEnabled();
    if (quietEnabled) {
      const tz = this.config.get<string>('TZ') ?? process.env.TZ ?? 'America/Sao_Paulo';
      const quietStart = Number(this.config.get<string>('QUIET_START') ?? process.env.QUIET_START ?? '23');
      const quietEnd = Number(this.config.get<string>('QUIET_END') ?? process.env.QUIET_END ?? '7');
      if (isQuietHours(now, quietStart, quietEnd, tz)) {
        return; // Do not send alerts during quiet hours
      }
    }

    const pendings = await this.repo.listPending();
    if (pendings.length === 0) {
      return;
    }

    // "Sem novidade na fila = sem DM (nunca spam)"
    const hasNew = pendings.some((p) => p.createdAt.getTime() > this.lastAlertSentAt);
    if (!hasNew && this.lastAlertSentAt !== 0) {
      return;
    }

    const soonThreshold = new Date(now.getTime() + 60 * 60_000); // 60 mins
    const expiringSoon = pendings.filter((p) => p.expiresAt <= soonThreshold).length;

    const panelUrl = this.config.get<string>('PANEL_URL') ?? process.env.PANEL_URL ?? 'http://localhost:3000';
    const message = `${pendings.length} deals aguardando (${expiringSoon} expiram em breve)
Acesse: ${panelUrl}`;

    try {
      const publisher = this.publishers.get('wa');
      await publisher.publish({ caption: message }, jid);
      
      this.lastAlertSentAt = now.getTime();
      this.logger.log(`Alert sent to ${jid}: ${pendings.length} pending, ${expiringSoon} expiring soon`);
    } catch (err) {
      this.logger.error(`Failed to send DM alert: ${(err as Error).message}`, (err as Error).stack);
    }
  }

  // Seam for tests
  protected now(): Date {
    return new Date();
  }
}
