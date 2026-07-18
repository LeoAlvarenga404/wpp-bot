import type { ScoredDeal } from '../../deal-score/types';
import type { ProductKey, SourceId } from '../../sources/source.port';

/**
 * A product the curator pasted, resolved into the fields the approval card
 * needs. Store-agnostic: the ML resolver scrapes it from the page, a future
 * Shopee/manual-form resolver fills it from an API or a form. The affiliate
 * short link is NOT resolved here — the send path mints it per source, exactly
 * as it does for pipeline deals.
 */
export interface ResolvedManualDeal {
  key: ProductKey;
  source: SourceId;
  title: string;
  priceCents: number;
  originalPriceCents: number | null;
  discountPercent: number;
  thumbnail: string;
  /** Canonical product URL the send path resolves the affiliate link from. */
  permalink: string;
  installmentsNoInterest: boolean;
}

/**
 * Resolution failure with a stable, panel-facing code. The service maps it to
 * an HTTP error so the curator sees a clear reason — and NO pending card is
 * ever created for a failed resolve (issue #8 acceptance: "sem card fantasma").
 */
export class ManualResolveError extends Error {
  constructor(
    readonly code: 'invalid_url' | 'scrape_failed',
    message: string,
  ) {
    super(message);
    this.name = 'ManualResolveError';
  }
}

/**
 * Per-store manual-deal resolver (pluggable). The common path is
 * store-agnostic: ManualDealService picks the first resolver whose
 * `canResolve` claims the URL, nothing else is ML-hardcoded.
 */
export interface ManualDealResolver {
  readonly source: SourceId;
  /** True when this resolver recognizes the URL as its own store. */
  canResolve(url: string): boolean;
  /** Resolve the URL into a card. Throws {@link ManualResolveError} on failure. */
  resolve(url: string): Promise<ResolvedManualDeal>;
}

/** DI token for the array of registered resolvers. */
export const MANUAL_RESOLVERS = Symbol('MANUAL_RESOLVERS');

/**
 * Neutral sentinel score for manual deals — they bypass scoring (the curator
 * already chose them). It never affects what is published (everything
 * downstream reads only `deal.*`), and manual audit rows are tagged with a
 * distinct stage so this sentinel never contaminates the score-based threshold
 * calibration dataset (see ApprovalQueueService.audit).
 */
export const MANUAL_DEAL_SCORE = 100;

/**
 * Wrap a resolved manual deal in a synthetic ScoredDeal so it re-uses the
 * whole approval-queue mechanic (preview, edit, urgent, dedup, send). The
 * single reason and `extras.manual` mark its manual origin; downstream reads
 * only `deal.*`.
 */
export function toScoredDeal(r: ResolvedManualDeal): ScoredDeal {
  return {
    deal: {
      key: r.key,
      source: r.source,
      raw: {
        key: r.key,
        title: r.title,
        priceCents: r.priceCents,
        originalPriceCents: r.originalPriceCents,
        discountPercent: r.discountPercent,
        thumbnail: r.thumbnail,
        permalink: r.permalink,
        feedId: 'manual',
      },
      seller: null,
      condition: 'unknown',
      signals: {
        freeShipping: false,
        installmentsNoInterest: r.installmentsNoInterest,
        volumeTier: 'none',
        isVerifiedStore: false,
        isFull: false,
      },
      extras: { manual: true },
    },
    score: MANUAL_DEAL_SCORE,
    rawScore: MANUAL_DEAL_SCORE,
    level: 'good',
    reasons: [
      { code: 'manual', weight: 0, message: 'Deal manual (curadoria)' },
    ],
    penalties: [],
    factors: {},
  };
}
