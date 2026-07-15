// Repository surface DedupService talks to.
//
// Kept as an interface so the service unit-tests can swap in an in-memory
// fake without standing up a real Postgres connection. The production wiring
// in `dedup.module.ts` resolves this token to `PrismaDedupRepo`.

export const DEDUP_REPO = Symbol('DEDUP_REPO');

export interface DedupRepo {
  markPosted(catalogId: string, postedAt: Date): Promise<void>;
  getPostedAt(catalogId: string): Promise<Date | null>;
  pruneOlderThan(cutoff: Date): Promise<number>;
  count(): Promise<number>;
  importMany(
    entries: Array<{ catalogId: string; postedAt: Date }>,
  ): Promise<void>;
}
