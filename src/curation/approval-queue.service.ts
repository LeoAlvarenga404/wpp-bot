import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { CouponService } from '../coupon/coupon.service';
import type { CouponView } from '../coupon/coupon.types';
import type { ScoredDeal, ScoreReason } from '../deal-score/types';
import { OpsConfigService } from '../ops-config/ops-config.service';
import {
  PipelineService,
  type EnqueueResult,
} from '../pipeline/pipeline.service';
import { ofertasTemplate } from '../pipeline/templates/template-ofertas';
import { keyToString } from '../sources/source.port';
import { dayString } from '../shared/day';
import { toHiResImage } from '../shared/hi-res-image';
import {
  APPROVAL_QUEUE_REPO,
  type ApprovalQueueRepo,
  type PendingDealRow,
} from './approval-queue.repo';
import {
  CURATION_DECISION_REPO,
  type CurationDecisionRepo,
} from './curation-decision.repo';

export interface DispatchResult extends EnqueueResult {
  /** Borderline deals held in the approval queue this dispatch. */
  pending: number;
  /** Effective AUTO_APPROVE_SCORE at dispatch time. */
  threshold: number;
}

export interface PendingSummary {
  id: string;
  catalogId: string;
  score: number;
  level: string;
  reasons: ScoreReason[];
  preview: {
    title: string;
    priceCents: number;
    originalPriceCents: number | null;
    discountPercent: number;
    thumbnail: string;
    permalink: string;
  };
  /**
   * The exact WA caption the group would see, rendered from the snapshot by
   * the same template the send path uses. The link is the raw permalink —
   * previews never mint affiliate/short links.
   */
  caption: string;
  /** Hi-res image the publisher would attach. */
  imageUrl: string;
  createdAt: Date;
  expiresAt: Date;
}

/**
 * Hybrid approval queue (curation panel). Sits between the scheduler and the
 * send path: deals scoring >= AUTO_APPROVE_SCORE keep flowing automatically
 * through `PipelineService.enqueueScored`; borderline deals (passed the gate,
 * below the threshold) are persisted as PENDING with the full ScoredDeal
 * snapshot and a 4h expiry. An impossible threshold (default 999) holds 100%
 * of deals — the all-manual calibration mode.
 *
 * `approve(id)` re-hydrates the snapshot and funnels it back into
 * `enqueueScored`, so the existing dispatch path does the rest for free:
 * live price scrape, coupon resolution, digest chunking and dedup. A stale
 * snapshot price is therefore never published — the send path re-scrapes.
 * `reject(id)` and expiry discard without sending.
 *
 * Every human/expiry decision is audited in CurationDecision (stage
 * 'approval', outcomes approved/rejected/expired) with the score at decision
 * time — the labeled data that calibrates the threshold.
 */
@Injectable()
export class ApprovalQueueService {
  private readonly logger = new Logger(ApprovalQueueService.name);
  private readonly tz: string;
  private readonly ttlHours: number;

  constructor(
    @Inject(APPROVAL_QUEUE_REPO)
    private readonly repo: ApprovalQueueRepo,
    private readonly pipeline: PipelineService,
    private readonly opsConfig: OpsConfigService,
    private readonly config: ConfigService,
    @Inject(CURATION_DECISION_REPO)
    private readonly decisions: CurationDecisionRepo,
    private readonly coupons: CouponService,
  ) {
    this.tz = this.config.get<string>('TZ') ?? 'America/Sao_Paulo';
    this.ttlHours = Number(this.config.get<string>('APPROVAL_TTL_HOURS', '4'));
  }

  /**
   * Threshold bifurcation — the scheduler calls this where it used to call
   * `enqueueScored` directly. Returns the auto path's enqueue counters plus
   * how many deals were held as pending.
   */
  async dispatchScored(scored: ScoredDeal[]): Promise<DispatchResult> {
    const threshold = await this.opsConfig.autoApproveScore();
    const auto = scored.filter((s) => s.score >= threshold);
    const borderline = scored.filter((s) => s.score < threshold);

    let autoResult: EnqueueResult = {
      enqueued: 0,
      targets: 0,
      topScore: null,
    };
    if (auto.length > 0) {
      autoResult = await this.pipeline.enqueueScored(auto);
    }

    for (const sd of borderline) await this.holdPending(sd);

    if (borderline.length > 0) {
      this.logger.log(
        `dispatchScored: threshold=${threshold} auto=${auto.length} pending=${borderline.length}`,
      );
    }
    return { ...autoResult, pending: borderline.length, threshold };
  }

  async listPending(): Promise<PendingSummary[]> {
    await this.expireOverdue();
    const rows = await this.repo.listPending();
    return Promise.all(rows.map((row) => this.toSummary(row)));
  }

  /**
   * Re-hydrates the snapshot and hands it to the existing send path. The
   * enqueue may still drop the deal (dedup, no active target) — the decision
   * is audited as approved either way; `enqueued` in the result tells the
   * caller what actually hit the queue.
   */
  async approve(id: string): Promise<{
    id: string;
    catalogId: string;
    enqueued: number;
    targets: number;
  }> {
    const row = await this.mustBePending(id);
    const sd = row.snapshot as ScoredDeal;
    const result = await this.pipeline.enqueueScored([sd]);
    await this.repo.markDecided(row.id, 'APPROVED', this.now());
    await this.audit(row, 'approved');
    return {
      id: row.id,
      catalogId: row.catalogId,
      enqueued: result.enqueued,
      targets: result.targets,
    };
  }

  async reject(id: string): Promise<{ id: string; catalogId: string }> {
    const row = await this.mustBePending(id);
    await this.repo.markDecided(row.id, 'REJECTED', this.now());
    await this.audit(row, 'rejected');
    return { id: row.id, catalogId: row.catalogId };
  }

  /**
   * Expiry sweep: pendings past `expiresAt` are discarded without sending —
   * an aged price must never be published. Cron-driven, and also invoked
   * lazily by listPending/approve so the panel never shows (or sends) a dead
   * row between sweeps.
   */
  @Cron(process.env.APPROVAL_EXPIRY_CRON ?? '*/10 * * * *')
  async expireOverdue(): Promise<number> {
    const rows = await this.repo.findExpiredPending(this.now());
    for (const row of rows) {
      await this.repo.markDecided(row.id, 'EXPIRED', this.now());
      await this.audit(row, 'expired');
    }
    if (rows.length > 0) {
      this.logger.log(`expireOverdue: discarded ${rows.length} pending deals`);
    }
    return rows.length;
  }

  private async holdPending(sd: ScoredDeal): Promise<void> {
    const catalogId = keyToString(sd.deal.key);
    const expiresAt = new Date(
      this.now().getTime() + this.ttlHours * 3_600_000,
    );
    const data = { score: Math.round(sd.score), snapshot: sd, expiresAt };

    // A deal can resurface on every tick while it sits in the queue. Refresh
    // the existing PENDING row instead of duplicating: the new snapshot has a
    // fresher price and the expiry restarts from the latest sighting.
    const existing = await this.repo.findPendingByCatalogId(catalogId);
    if (existing) {
      await this.repo.refresh(existing.id, data);
      return;
    }
    await this.repo.create({ catalogId, ...data });
  }

  private async mustBePending(id: string): Promise<PendingDealRow> {
    const row = await this.repo.findById(id);
    if (!row) throw new NotFoundException(`Pending deal '${id}' not found`);
    if (row.status !== 'PENDING') {
      throw new ConflictException(`Pending deal '${id}' is ${row.status}`);
    }
    if (row.expiresAt.getTime() <= this.now().getTime()) {
      await this.repo.markDecided(row.id, 'EXPIRED', this.now());
      await this.audit(row, 'expired');
      throw new ConflictException(`Pending deal '${id}' has expired`);
    }
    return row;
  }

  private async toSummary(row: PendingDealRow): Promise<PendingSummary> {
    const sd = row.snapshot as ScoredDeal;
    const caption = ofertasTemplate({
      sd,
      link: sd.deal.raw.permalink,
      couponView: await this.resolveCoupon(sd),
    });
    return {
      id: row.id,
      catalogId: row.catalogId,
      score: row.score,
      level: sd.level,
      reasons: sd.reasons,
      preview: {
        title: sd.deal.raw.title,
        priceCents: sd.deal.raw.priceCents,
        originalPriceCents: sd.deal.raw.originalPriceCents,
        discountPercent: sd.deal.raw.discountPercent,
        thumbnail: sd.deal.raw.thumbnail,
        permalink: sd.deal.raw.permalink,
      },
      caption,
      imageUrl: toHiResImage(sd.deal.raw.thumbnail || ''),
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
    };
  }

  /** Coupon line is best-effort — a coupon lookup failure never hides a card. */
  private async resolveCoupon(sd: ScoredDeal): Promise<CouponView | undefined> {
    try {
      return (
        (await this.coupons.resolveForDeal(
          sd.deal,
          sd.deal.raw.priceCents,
          this.now(),
        )) ?? undefined
      );
    } catch (err) {
      this.logger.warn(
        `coupon resolve failed (${keyToString(sd.deal.key)}): ${(err as Error).message}`,
      );
      return undefined;
    }
  }

  /** Audit failures must never block a human decision — mirror the gate. */
  private async audit(
    row: PendingDealRow,
    outcome: 'approved' | 'rejected' | 'expired',
  ): Promise<void> {
    const sd = row.snapshot as ScoredDeal;
    try {
      await this.decisions.upsert({
        catalogId: row.catalogId,
        stage: 'approval',
        outcome,
        day: dayString(this.now(), this.tz),
        score: row.score,
        priceCents: sd?.deal?.raw?.priceCents,
        reasons: sd?.reasons,
      });
    } catch (err) {
      this.logger.warn(
        `decision upsert failed (approval/${row.catalogId}): ${(err as Error).message}`,
      );
    }
  }

  /** Seam for tests: overridable so specs control the clock. */
  protected now(): Date {
    return new Date();
  }
}
