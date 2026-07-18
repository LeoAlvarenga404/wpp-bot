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
import { CreateGenericManualDto } from '../dto/create-generic-manual.dto';
import type { SourceId } from '../../sources/source.port';

/**
 * Entry point for the panel's "deal manual" flow (issue #8). Picks the first
 * registered resolver that claims the pasted URL, turns the resolved product
 * into a synthetic ScoredDeal, and drops it into the SAME approval queue as
 * pipeline deals — so edit / preview / urgent / dedup / send are all reused.
 *
 * The common path is store-agnostic: nothing here is ML-specific. Adding
 * Shopee (API) or a universal manual form is a new resolver in the array, no
 * change to this service.
 */
@Injectable()
export class ManualDealService {
  private readonly logger = new Logger(ManualDealService.name);

  constructor(
    @Inject(MANUAL_RESOLVERS)
    private readonly resolvers: ManualDealResolver[],
    private readonly approvalQueue: ApprovalQueueService,
  ) {}

  async resolveUrl(url: string): Promise<PendingSummary> {
    const resolver = this.resolvers.find((r) => r.canResolve(url));
    if (!resolver) {
      throw new BadRequestException({
        code: 'unsupported_url',
        message:
          'Nenhuma loja reconhece essa URL. Use o formulário manual para lojas sem integração.',
      });
    }

    let resolved;
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

    return this.approvalQueue.createManual(toScoredDeal(resolved));
  }

  async createGeneric(dto: CreateGenericManualDto): Promise<PendingSummary> {
    const externalId = createHash('md5')
      .update(dto.permalink)
      .digest('hex')
      .substring(0, 12);

    let discountPercent = 0;
    if (dto.originalPriceCents && dto.originalPriceCents > dto.priceCents) {
      discountPercent = Math.round(
        ((dto.originalPriceCents - dto.priceCents) / dto.originalPriceCents) * 100,
      );
    }

    const resolved: ResolvedManualDeal = {
      key: { source: dto.store as SourceId, externalId },
      source: dto.store as SourceId,
      title: dto.title,
      priceCents: dto.priceCents,
      originalPriceCents: dto.originalPriceCents ?? null,
      discountPercent,
      thumbnail: dto.thumbnail,
      permalink: dto.permalink,
      installmentsNoInterest: false,
    };

    return this.approvalQueue.createManual(toScoredDeal(resolved));
  }
}
