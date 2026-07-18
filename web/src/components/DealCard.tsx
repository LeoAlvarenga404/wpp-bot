import { useState } from 'react';
import type { PendingDeal } from '../types';
import { CaptionPreview } from './CaptionPreview';

function scoreColor(score: number): string {
  if (score >= 85) return 'bg-green-600';
  if (score >= 70) return 'bg-amber-600';
  return 'bg-red-700';
}

function timeLeft(expiresAt: string, now: number): string {
  const ms = new Date(expiresAt).getTime() - now;
  if (ms <= 0) return 'expirado';
  const totalMin = Math.floor(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `expira em ${h}h ${m}min` : `expira em ${m}min`;
}

export function DealCard({
  deal,
  now,
  onApprove,
  onReject,
}: {
  deal: PendingDeal;
  now: number;
  /** Resolve when the API call settles; the card disables itself meanwhile. */
  onApprove: (id: string) => Promise<void>;
  onReject: (id: string) => Promise<void>;
}) {
  const [acting, setActing] = useState<'approve' | 'reject' | null>(null);

  const act = async (kind: 'approve' | 'reject') => {
    setActing(kind);
    try {
      await (kind === 'approve' ? onApprove(deal.id) : onReject(deal.id));
    } finally {
      setActing(null);
    }
  };

  return (
    <article className="rounded-xl border border-stone-800 bg-stone-900 p-3 shadow-lg">
      <header className="mb-2 flex items-center gap-2">
        <span
          className={`rounded-full px-2.5 py-0.5 text-sm font-bold text-white ${scoreColor(deal.score)}`}
        >
          {deal.score}
        </span>
        <span className="text-xs uppercase tracking-wide text-stone-400">
          {deal.level}
        </span>
        <span className="ml-auto text-xs text-stone-400">
          {timeLeft(deal.expiresAt, now)}
        </span>
      </header>

      <CaptionPreview caption={deal.caption} imageUrl={deal.imageUrl} />

      {deal.reasons.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {deal.reasons.map((r) => (
            <li
              key={r.code}
              className="rounded-full bg-stone-800 px-2 py-0.5 text-xs text-stone-300"
            >
              {r.message}
            </li>
          ))}
        </ul>
      )}

      <footer className="mt-3 grid grid-cols-2 gap-2">
        <button
          type="button"
          disabled={acting !== null}
          onClick={() => void act('reject')}
          className="rounded-lg bg-stone-800 py-3 text-base font-semibold text-red-400 active:bg-stone-700 disabled:opacity-50"
        >
          {acting === 'reject' ? '…' : '✕ Rejeitar'}
        </button>
        <button
          type="button"
          disabled={acting !== null}
          onClick={() => void act('approve')}
          className="rounded-lg bg-green-600 py-3 text-base font-semibold text-white active:bg-green-500 disabled:opacity-50"
        >
          {acting === 'approve' ? '…' : '✓ Aprovar'}
        </button>
      </footer>
    </article>
  );
}
