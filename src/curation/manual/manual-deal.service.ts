import { createHash } from 'crypto';
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  ApprovalQueueService,
  type PendingSummary,
} from '../approval-queue.service';
import {
  MANUAL_RESOLVERS,
  ManualResolveError,
  toScoredDeal,
  type ManualDealResolver,
  type ResolvedManualDeal,
} from './manual-resolver.port';
import { extractMlId } from './ml-manual-resolver';
import { CreateManualDealDto } from '../dto/create-manual-deal.dto';
import { PreviewManualDto } from '../dto/preview-manual.dto';
import type { ScoredDeal } from '../../deal-score/types';
import type { SourceId } from '../../sources/source.port';

/** The resolved fields the panel prefills the composer with — no card yet. */
export type ResolvedManualView = Omit<ResolvedManualDeal, 'key'>;

/** Result of a dispatched submit — mirrors ApprovalQueueService.approve. */
export interface DispatchResult {
  id: string;
  catalogId: string;
  enqueued: number;
  targets: number;
}

/**
 * Entry point for the panel's "Novo deal" composer. Three moves:
 *  - resolveUrl: paste a URL → prefill fields (no card created).
 *  - preview: render the exact caption a card/dispatch would show (stateless).
 *  - submit: create the pending card and, with dispatch, approve it urgent.
 *
 * The synthetic ScoredDeal path is store-agnostic — a manual deal and a
 * pipeline deal publish through identical code (toScoredDeal → approval queue).
 */
@Injectable()
export class ManualDealService {
  private readonly logger = new Logger(ManualDealService.name);

  constructor(
    @Inject(MANUAL_RESOLVERS)
    private readonly resolvers: ManualDealResolver[],
    private readonly approvalQueue: ApprovalQueueService,
  ) {}

  /** Resolve a pasted URL into prefill fields. Creates NO card. */
  async resolveUrl(url: string): Promise<ResolvedManualView> {
    const resolver = this.resolvers.find((r) => r.canResolve(url));
    if (!resolver) {
      throw new BadRequestException({
        code: 'unsupported_url',
        message:
          'Nenhuma loja reconhece essa URL. Preencha os campos manualmente.',
      });
    }
    let resolved: ResolvedManualDeal;
    try {
      resolved = await resolver.resolve(url);
    } catch (err) {
      if (err instanceof ManualResolveError) {
        this.logger.warn(
          `manual resolve ${err.code} for ${url}: ${err.message}`,
        );
        const body = { code: err.code, message: err.message };
        // invalid_url is a bad request; scrape_failed is a valid request the
        // upstream page couldn't satisfy (422). Either way: no pending card.
        throw err.code === 'invalid_url'
          ? new BadRequestException(body)
          : new UnprocessableEntityException(body);
      }
      throw err;
    }
    const { key: _key, ...view } = resolved;
    return view;
  }

  /** Stateless caption render for the composer's live preview. */
  async preview(
    dto: PreviewManualDto,
  ): Promise<{ caption: string; imageUrl: string }> {
    return this.approvalQueue.renderManualPreview(this.fieldsToScored(dto));
  }

  /** Create a pending card; dispatch=true approves it urgent in the same call. */
  async submit(
    dto: CreateManualDealDto,
  ): Promise<PendingSummary | DispatchResult> {
    const sd = this.fieldsToScored(dto);
    const card = await this.approvalQueue.createManual(sd);
    if (dto.dispatch === true) {
      return this.approvalQueue.approve(card.id, undefined, { urgent: true });
    }
    return card;
  }

  private fieldsToScored(
    dto: CreateManualDealDto | PreviewManualDto,
  ): ScoredDeal {
    const source = dto.store as SourceId;
    const externalId = this.deriveId(source, dto.permalink, dto.title);

    let discountPercent = 0;
    if (dto.originalPriceCents && dto.originalPriceCents > dto.priceCents) {
      discountPercent = Math.round(
        ((dto.originalPriceCents - dto.priceCents) / dto.originalPriceCents) *
          100,
      );
    }

    const resolved: ResolvedManualDeal = {
      key: { source, externalId },
      source,
      title: dto.title,
      priceCents: dto.priceCents,
      originalPriceCents: dto.originalPriceCents ?? null,
      discountPercent,
      thumbnail: dto.thumbnail,
      permalink: dto.permalink ?? '',
      installmentsNoInterest: dto.installmentsNoInterest ?? false,
    };

    const sd = toScoredDeal(resolved);
    if (dto.coupon) {
      sd.curatorEdits = {
        coupon: { code: dto.coupon.code, finalCents: dto.coupon.finalCents },
      };
    }
    return sd;
  }

  /**
   * ML: catalog id from the link so dedup aligns with pipeline deals.
   * Otherwise a stable 12-char md5 of the link (or title when link-less).
   */
  private deriveId(
    source: SourceId,
    permalink: string | undefined,
    title: string,
  ): string {
    if (source === 'ml' && permalink) {
      const mlb = extractMlId(permalink);
      if (mlb) return mlb;
    }
    return createHash('md5')
      .update(permalink || title)
      .digest('hex')
      .substring(0, 12);
  }
}
