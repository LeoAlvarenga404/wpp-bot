import type { CuratorEdits, PendingDeal } from './types';

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
    } | null;
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
  edits?: CuratorEdits,
): Promise<void> {
  await request(`/approval/${encodeURIComponent(id)}/approve`, {
    method: 'POST',
    ...(edits ? { json: { edits } } : {}),
  });
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
