import type { ApproveOptions, CuratorEdits, PendingDeal } from './types';

const API_KEY_STORAGE = 'wpp-panel-api-key';

export function getApiKey(): string {
  return localStorage.getItem(API_KEY_STORAGE) ?? '';
}

export function setApiKey(key: string): void {
  localStorage.setItem(API_KEY_STORAGE, key);
}

/** 401 from the API — the guard wants a (different) x-api-key. */
export class UnauthorizedError extends Error {
  constructor() {
    super('unauthorized');
  }
}

/**
 * 409 from the API — the row was decided or expired elsewhere (another tab,
 * the expiry cron). The card must simply leave the queue.
 */
export class GoneError extends Error {
  constructor(message: string) {
    super(message);
  }
}

/**
 * 409 { code: 'recently_posted' } — the product was published < 14 days ago
 * and approving needs the curator's explicit dedup override.
 */
export class RecentlyPostedError extends Error {
  constructor(public readonly days: number) {
    super(`postado há ${days} dia(s)`);
  }
}

async function request<T>(
  path: string,
  init?: RequestInit & { json?: unknown },
): Promise<T> {
  const headers: Record<string, string> = {};
  const key = getApiKey();
  if (key) headers['x-api-key'] = key;
  let reqBody: BodyInit | undefined;
  if (init?.json !== undefined) {
    headers['content-type'] = 'application/json';
    reqBody = JSON.stringify(init.json);
  }

  const res = await fetch(path, { ...init, headers, body: reqBody });
  if (res.status === 401) throw new UnauthorizedError();
  if (res.status === 409 || res.status === 404) {
    const body = (await res.json().catch(() => null)) as {
      message?: string;
      code?: string;
      days?: number;
    } | null;
    if (body?.code === 'recently_posted') {
      throw new RecentlyPostedError(body.days ?? 0);
    }
    throw new GoneError(body?.message ?? `HTTP ${res.status}`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

export async function fetchPending(): Promise<PendingDeal[]> {
  const data = await request<{ pending: PendingDeal[] }>('/approval/pending');
  return data.pending;
}

export async function approveDeal(
  id: string,
  opts?: ApproveOptions,
): Promise<{ enqueued: number }> {
  const hasBody = opts && (opts.edits || opts.urgent || opts.dedupOverride);
  // enqueued can be 0: the send path may still drop the deal (no active
  // target, price-raise block). The caller must not report "sent".
  return request<{ enqueued: number }>(
    `/approval/${encodeURIComponent(id)}/approve`,
    {
      method: 'POST',
      ...(hasBody ? { json: opts } : {}),
    },
  );
}

/** Shared repost confirmation — the same copy the card and the 409 retry use. */
export function confirmRepost(days: number): boolean {
  return window.confirm(`Postado há ${days} dia(s). Enviar mesmo assim?`);
}

/** Server-rendered live preview of the caption with the edits applied. */
export async function previewDeal(
  id: string,
  edits: CuratorEdits,
): Promise<{ caption: string; imageUrl: string }> {
  return request(`/approval/${encodeURIComponent(id)}/preview`, {
    method: 'POST',
    json: { edits },
  });
}

export async function rejectDeal(id: string): Promise<void> {
  await request(`/approval/${encodeURIComponent(id)}/reject`, {
    method: 'POST',
  });
}
