import { useCallback, useEffect, useRef, useState } from 'react';
import {
  approveDeal,
  confirmRepost,
  fetchPending,
  GoneError,
  RecentlyPostedError,
  rejectDeal,
  setApiKey,
  UnauthorizedError,
} from './api';
import { DealCard } from './components/DealCard';
import type { ApproveOptions, PendingDeal } from './types';

const POLL_MS = 20_000;

type Status = 'loading' | 'ready' | 'unauthorized' | 'error';

export default function App() {
  const [deals, setDeals] = useState<PendingDeal[]>([]);
  const [status, setStatus] = useState<Status>('loading');
  const [toast, setToast] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2500);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const pending = await fetchPending();
      setDeals(pending);
      setStatus('ready');
      setNow(Date.now());
    } catch (err) {
      setStatus(err instanceof UnauthorizedError ? 'unauthorized' : 'error');
    }
  }, []);

  useEffect(() => {
    void refresh();
    const poll = setInterval(() => void refresh(), POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(poll);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  const decide = useCallback(
    async (id: string, kind: 'approve' | 'reject', opts?: ApproveOptions) => {
      const snapshot = deals;
      setDeals((current) => current.filter((d) => d.id !== id));
      try {
        let enqueued: number | null = null;
        try {
          if (kind === 'approve') {
            enqueued = (await approveDeal(id, opts)).enqueued;
          } else {
            await rejectDeal(id);
          }
        } catch (err) {
          // Posted < 14 days ago (state changed since the card rendered):
          // the send only proceeds with the curator's explicit confirmation.
          if (err instanceof RecentlyPostedError && kind === 'approve') {
            if (!confirmRepost(err.days)) {
              setDeals(snapshot);
              return;
            }
            enqueued = (await approveDeal(id, { ...opts, dedupOverride: true }))
              .enqueued;
          } else {
            throw err;
          }
        }
        showToast(
          kind === 'reject'
            ? 'Rejeitado ✕'
            : enqueued === 0
              ? 'Aprovado, mas nada enfileirado ⚠️'
              : opts?.urgent
                ? 'Enviando agora ⚡'
                : 'Aprovado ✓',
        );
      } catch (err) {
        if (err instanceof GoneError) {
          // Decided or expired elsewhere — it no longer belongs in the queue.
          showToast('Este deal já saiu da fila');
          return;
        }
        setDeals(snapshot);
        if (err instanceof UnauthorizedError) {
          setStatus('unauthorized');
          return;
        }
        showToast('Falha — tente de novo');
      }
    },
    [deals, showToast],
  );

  if (status === 'unauthorized') {
    return <ApiKeyGate onSaved={() => void refresh()} />;
  }

  return (
    <div className="min-h-dvh bg-stone-950 text-stone-100">
      <header className="sticky top-0 z-10 border-b border-stone-800 bg-stone-950/95 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-md items-center justify-between">
          <h1 className="text-lg font-bold">Fila de aprovação</h1>
          <span className="rounded-full bg-stone-800 px-2.5 py-0.5 text-sm text-stone-300">
            {deals.length} pendente{deals.length === 1 ? '' : 's'}
          </span>
        </div>
      </header>

      <main className="mx-auto flex max-w-md flex-col gap-4 px-3 py-4 pb-10">
        {status === 'loading' && (
          <p className="py-16 text-center text-stone-400">Carregando…</p>
        )}
        {status === 'error' && (
          <p className="py-16 text-center text-red-400">
            Não consegui falar com a API.{' '}
            <button
              type="button"
              className="underline"
              onClick={() => void refresh()}
            >
              Tentar de novo
            </button>
          </p>
        )}
        {status === 'ready' && deals.length === 0 && (
          <p className="py-16 text-center text-stone-400">
            Fila vazia — nada aguardando aprovação. 🎉
          </p>
        )}
        {deals.map((deal) => (
          <DealCard
            key={deal.id}
            deal={deal}
            now={now}
            onApprove={(id, opts) => decide(id, 'approve', opts)}
            onReject={(id) => decide(id, 'reject')}
          />
        ))}
      </main>

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 rounded-full bg-stone-800 px-4 py-2 text-sm text-white shadow-xl">
          {toast}
        </div>
      )}
    </div>
  );
}

/**
 * Shown on 401: the API has API_KEY set (production behind Cloudflare Access
 * still keeps the app-level key). Stores the key locally and retries.
 */
function ApiKeyGate({ onSaved }: { onSaved: () => void }) {
  const [value, setValue] = useState('');
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-stone-950 px-6 text-stone-100">
      <h1 className="text-lg font-bold">Chave da API</h1>
      <p className="text-center text-sm text-stone-400">
        A API respondeu 401. Informe o valor de <code>API_KEY</code> para
        continuar.
      </p>
      <input
        type="password"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="w-full max-w-xs rounded-lg border border-stone-700 bg-stone-900 px-3 py-2"
        placeholder="x-api-key"
      />
      <button
        type="button"
        className="w-full max-w-xs rounded-lg bg-green-600 py-2.5 font-semibold text-white disabled:opacity-50"
        disabled={!value.trim()}
        onClick={() => {
          setApiKey(value.trim());
          onSaved();
        }}
      >
        Salvar e entrar
      </button>
    </div>
  );
}
