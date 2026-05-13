/**
 * Exponential backoff retry helper with jitter.
 *
 * Defaults:
 *  - maxAttempts: 5
 *  - baseMs: 1000
 *  - maxMs: 60_000
 *  - jitterPct: 0.25
 *  - shouldRetry: retries 429/5xx + transient network errors (ECONNRESET,
 *    ETIMEDOUT, ENETUNREACH, EAI_AGAIN). Does NOT retry 400/401/403/404.
 *
 * On exhaustion the last error is rethrown unchanged.
 */

export interface RetryOpts {
  maxAttempts?: number;
  baseMs?: number;
  maxMs?: number;
  jitterPct?: number;
  shouldRetry?: (err: any) => boolean;
}

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const NO_RETRY_STATUS = new Set([400, 401, 403, 404]);
const RETRY_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ENETUNREACH',
  'EAI_AGAIN',
]);

function extractStatus(err: any): number | undefined {
  return err?.response?.status ?? err?.status ?? err?.statusCode ?? undefined;
}

function extractCode(err: any): string | undefined {
  return err?.code ?? err?.cause?.code ?? undefined;
}

export function defaultShouldRetry(err: any): boolean {
  const status = extractStatus(err);
  if (status !== undefined) {
    if (NO_RETRY_STATUS.has(status)) return false;
    if (RETRY_STATUS.has(status)) return true;
    // Any other explicit HTTP status: do not retry by default.
    return false;
  }
  const code = extractCode(err);
  if (code && RETRY_CODES.has(code)) return true;
  // No status, no recognized code → assume transient network blip and retry.
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeDelay(
  attempt: number,
  baseMs: number,
  maxMs: number,
  jitterPct: number,
): number {
  const exp = Math.min(maxMs, baseMs * Math.pow(2, attempt));
  const jitterRange = exp * jitterPct;
  const jitter = (Math.random() * 2 - 1) * jitterRange; // ± jitterPct
  return Math.max(0, exp + jitter);
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts?: RetryOpts,
): Promise<T> {
  const maxAttempts = opts?.maxAttempts ?? 5;
  const baseMs = opts?.baseMs ?? 1000;
  const maxMs = opts?.maxMs ?? 60_000;
  const jitterPct = opts?.jitterPct ?? 0.25;
  const shouldRetry = opts?.shouldRetry ?? defaultShouldRetry;

  let lastErr: any;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const isLast = attempt === maxAttempts - 1;
      if (isLast || !shouldRetry(err)) throw err;
      const delay = computeDelay(attempt, baseMs, maxMs, jitterPct);
      await sleep(delay);
    }
  }
  // Unreachable — loop either returns or throws.
  throw lastErr;
}
