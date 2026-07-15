import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ScoredDeal } from '../deal-score/types';
import { DedupService } from '../dedup/dedup.service';
import { buildJudgeInput } from '../judge/judge-input';
import { DEAL_JUDGE } from '../judge/judge.port';
import type { DealJudge, JudgeVerdict } from '../judge/judge.port';
import { JudgeVerdictCache } from '../judge/verdict-cache';
import { CountersService } from '../metrics/counters.service';
import { dayString } from '../shared/day';
import { CopyVariant, pickVariant } from '../shared/variant';
import { keyToString, RawDeal } from '../sources/source.port';
import { CURATION_DECISION_REPO } from './curation-decision.repo';
import type {
  CurationDecisionRepo,
  DecisionUpsert,
} from './curation-decision.repo';
import { CurationService } from './curation.service';

const DECISION_RETENTION_DAYS = 60;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Single owner of every publish/reject decision (Fase 2). Each exit path
 * writes a CurationDecision row (upsert per catalogId+stage+day). The LLM
 * judge runs only here, only on the dispatch path, and is fail-closed.
 */
@Injectable()
export class CurationGateService implements OnModuleInit {
  private readonly logger = new Logger(CurationGateService.name);
  private readonly tz: string;
  private readonly dedupWindowDays: number;
  private readonly scoreTop: number;
  private readonly minHistoryDays: number;
  private readonly minConfidence: number;
  private readonly maxJudgeCallsPerTick: number;
  private readonly copyAbEnabled: boolean;

  constructor(
    private readonly config: ConfigService,
    private readonly curation: CurationService,
    private readonly dedup: DedupService,
    @Inject(DEAL_JUDGE) private readonly judge: DealJudge,
    @Inject(CURATION_DECISION_REPO)
    private readonly decisions: CurationDecisionRepo,
    private readonly verdictCache: JudgeVerdictCache,
    private readonly counters: CountersService,
  ) {
    const num = (k: string, def: number) =>
      Number(this.config.get<string>(k, String(def)));
    this.tz = this.config.get<string>('TZ') ?? 'America/Sao_Paulo';
    this.dedupWindowDays = num('DEDUP_WINDOW_DAYS', 7);
    this.scoreTop = num('DEAL_SCORE_TOP', 90);
    this.minHistoryDays = num('CURATION_MIN_HISTORY_DAYS', 7);
    this.minConfidence = num('JUDGE_MIN_CONFIDENCE', 0.6);
    this.maxJudgeCallsPerTick = num('JUDGE_MAX_CALLS_PER_TICK', 20);
    this.copyAbEnabled =
      (this.config.get<string>('COPY_AB_ENABLED') ?? 'true') !== 'false';
  }

  async onModuleInit(): Promise<void> {
    const cutoff = new Date(Date.now() - DECISION_RETENTION_DAYS * DAY_MS);
    try {
      const pruned = await this.decisions.pruneOlderThan(cutoff);
      if (pruned > 0) {
        this.logger.log(`Decision GC: pruned ${pruned} stale rows`);
      }
    } catch (err) {
      this.logger.warn(`Decision GC failed: ${(err as Error).message}`);
    }
  }

  /** Early screen on raw feed items: dedup + fake-discount. */
  async screenRaw(raw: RawDeal): Promise<boolean> {
    const keyStr = keyToString(raw.key);
    if (await this.dedup.wasRecentlyPosted(keyStr, this.dedupWindowDays)) {
      this.counters.dedupSkip.inc();
      await this.record({
        catalogId: keyStr,
        stage: 'dedup',
        outcome: 'rejected',
        priceCents: raw.priceCents,
      });
      return false;
    }
    if (this.curation.isFakeDiscount(keyStr, raw.priceCents)) {
      await this.record({
        catalogId: keyStr,
        stage: 'fake_discount',
        outcome: 'rejected',
        priceCents: raw.priceCents,
      });
      return false;
    }
    return true;
  }

  async recordPrescoreCut(raws: RawDeal[]): Promise<void> {
    for (const raw of raws) {
      await this.record({
        catalogId: keyToString(raw.key),
        stage: 'prescore_cut',
        outcome: 'rejected',
        priceCents: raw.priceCents,
      });
    }
  }

  async recordScoreReject(sd: ScoredDeal): Promise<void> {
    await this.record({
      catalogId: keyToString(sd.deal.key),
      stage: 'score_min',
      outcome: 'rejected',
      score: sd.score,
      priceCents: sd.deal.raw.priceCents,
      reasons: [...sd.reasons, ...sd.penalties],
    });
  }

  /**
   * Dispatch gate: hard price-raise block, auto-approve for high-confidence
   * deals, LLM judge for the gray zone (no history OR score below TOP).
   * Returns at most `max` approved deals, each with its copy variant.
   */
  async selectForDispatch(
    scored: ScoredDeal[],
    max: number,
  ): Promise<Array<{ scored: ScoredDeal; variant: CopyVariant }>> {
    const sorted = [...scored].sort((a, b) => b.score - a.score);
    const approved: Array<{ scored: ScoredDeal; variant: CopyVariant }> = [];
    let judgeCalls = 0;

    for (const sd of sorted) {
      if (approved.length >= max) break;
      const keyStr = keyToString(sd.deal.key);
      const priceCents = sd.deal.raw.priceCents;

      if ('price_raise_before_discount' in sd.factors) {
        await this.record({
          catalogId: keyStr,
          stage: 'price_raise',
          outcome: 'rejected',
          score: sd.score,
          priceCents,
          reasons: sd.penalties,
        });
        continue;
      }

      const noHistory =
        this.curation.historyDays(keyStr) < this.minHistoryDays;
      const grayZone = noHistory || sd.score < this.scoreTop;

      if (grayZone) {
        let verdict: JudgeVerdict | null = this.verdictCache.get(
          keyStr,
          priceCents,
        );
        if (!verdict) {
          if (judgeCalls >= this.maxJudgeCallsPerTick) {
            await this.record({
              catalogId: keyStr,
              stage: 'judge_budget',
              outcome: 'rejected',
              score: sd.score,
              priceCents,
            });
            continue;
          }
          judgeCalls++;
          try {
            verdict = await this.judge.judge(
              buildJudgeInput(sd, this.curation.getAnalytics(keyStr)),
            );
            this.verdictCache.set(keyStr, priceCents, verdict);
          } catch (err) {
            this.counters.judgeError.inc();
            await this.record({
              catalogId: keyStr,
              stage: 'judge_error',
              outcome: 'rejected',
              score: sd.score,
              priceCents,
              judgeVerdict: { error: (err as Error).message },
            });
            continue;
          }
        }

        const ok = verdict.approve && verdict.confidence >= this.minConfidence;
        if (!ok) {
          this.counters.judgeReject.inc();
          await this.record({
            catalogId: keyStr,
            stage: 'judge',
            outcome: 'rejected',
            score: sd.score,
            priceCents,
            judgeVerdict: verdict,
          });
          continue;
        }
        this.counters.judgeApprove.inc();
        await this.record({
          catalogId: keyStr,
          stage: 'judge',
          outcome: 'approved',
          score: sd.score,
          priceCents,
          judgeVerdict: verdict,
        });
      }

      approved.push({ scored: sd, variant: this.variantFor(keyStr) });
    }

    return approved;
  }

  async recordPosted(sd: ScoredDeal, variant: CopyVariant): Promise<void> {
    await this.record({
      catalogId: keyToString(sd.deal.key),
      stage: 'posted',
      outcome: 'posted',
      score: sd.score,
      priceCents: sd.deal.raw.priceCents,
      variant,
    });
  }

  private variantFor(catalogId: string): CopyVariant {
    return this.copyAbEnabled ? pickVariant(catalogId) : 'A';
  }

  /** Decision writes must never take the pipeline down. */
  private async record(d: Omit<DecisionUpsert, 'day'>): Promise<void> {
    try {
      await this.decisions.upsert({
        ...d,
        day: dayString(new Date(), this.tz),
      });
    } catch (err) {
      this.logger.error(
        `decision upsert failed (${d.stage}/${d.catalogId}): ${(err as Error).message}`,
      );
    }
  }
}
