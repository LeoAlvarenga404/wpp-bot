/**
 * Sentry bootstrap (P0-7).
 *
 * - No-op when SENTRY_DSN is empty/unset (local dev).
 * - Installs process-level handlers for unhandledRejection / uncaughtException
 *   that ship the error to Sentry before the process exits.
 * - Idempotent: safe to call multiple times.
 */

import * as Sentry from '@sentry/node';

let initialized = false;

export function initSentry(): boolean {
  if (initialized) return true;

  const dsn = process.env.SENTRY_DSN?.trim();
  if (!dsn) {
    initialized = true; // Mark so subsequent calls also short-circuit cleanly.
    return false;
  }

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? 'development',
    tracesSampleRate: 0,
  });

  process.on('unhandledRejection', (reason: unknown) => {
    const err =
      reason instanceof Error
        ? reason
        : new Error(`unhandledRejection: ${safeStringify(reason)}`);
    Sentry.captureException(err);

    console.error('[sentry] unhandledRejection captured', err);
  });

  process.on('uncaughtException', (err: Error) => {
    Sentry.captureException(err);

    console.error('[sentry] uncaughtException captured', err);
    // Give Sentry a moment to flush before the runtime tears down.
    void Sentry.flush(2000).finally(() => {
      process.exit(1);
    });
  });

  initialized = true;
  return true;
}

function safeStringify(v: unknown): string {
  try {
    return typeof v === 'string' ? v : JSON.stringify(v);
  } catch {
    return String(v);
  }
}
