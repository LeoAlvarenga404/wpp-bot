import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { MercadoLivreAuthService } from '../mercado-livre/ml-auth.service';

const PROACTIVE_SKEW_MS = 30 * 60 * 1000;

/**
 * P0-8: Proactive ML token refresh.
 *
 * Runs every 30 minutes. If a token is loaded and within 30 minutes of expiry,
 * triggers `MercadoLivreAuthService.proactiveRefresh()`. Refresh failures
 * (logged + ≥3-consecutive Sentry alert) are handled inside the auth service —
 * this scheduler just catches and logs to keep ticking.
 */
@Injectable()
export class TokenRefresherService {
  private readonly logger = new Logger(TokenRefresherService.name);

  constructor(private readonly mlAuth: MercadoLivreAuthService) {}

  @Cron('*/30 * * * *')
  async tick(): Promise<void> {
    const expiresAt = this.mlAuth.getExpiresAt();
    if (expiresAt === null) {
      this.logger.warn(
        'No ML token loaded — skipping proactive refresh. Visit /oauth/authorize to authorize.',
      );
      return;
    }

    const msUntilExpiry = expiresAt - Date.now();
    if (msUntilExpiry > PROACTIVE_SKEW_MS) {
      this.logger.debug?.(
        `ML token still fresh (expires in ${Math.round(msUntilExpiry / 60_000)}min). Skipping refresh.`,
      );
      return;
    }

    try {
      this.logger.log(
        `ML token expires in ${Math.round(msUntilExpiry / 60_000)}min — refreshing proactively.`,
      );
      await this.mlAuth.proactiveRefresh();
    } catch (err: any) {
      // Auth service already logs + Sentry-alerts after 3 consecutive failures.
      this.logger.error(
        `Proactive ML token refresh failed: ${err?.response?.status ?? err?.message}`,
      );
    }
  }
}
