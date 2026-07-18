import { useEffect, useState } from 'react';
import { fetchHistory, UnauthorizedError } from '../api';
import type { HistoryItem } from '../types';

export function HistoryPanel({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    fetchHistory(page, 20)
      .then((res) => {
        if (!active) return;
        setItems(res.items);
        setTotal(res.total);
        setLoading(false);
        setError(false);
      })
      .catch((err) => {
        if (!active) return;
        if (err instanceof UnauthorizedError) {
          onUnauthorized();
        } else {
          setError(true);
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [page, onUnauthorized]);

  if (loading && items.length === 0) {
    return <p className="py-16 text-center text-stone-400">Carregando...</p>;
  }

  if (error) {
    return <p className="py-16 text-center text-red-400">Falha ao carregar o histórico.</p>;
  }

  if (items.length === 0) {
    return <p className="py-16 text-center text-stone-400">Nenhum envio registrado.</p>;
  }

  const totalPages = Math.ceil(total / 20);

  return (
    <div className="flex flex-col gap-4 pb-10">
      <div className="flex flex-col gap-3">
        {items.map((item) => (
          <div key={item.id} className="rounded-lg bg-stone-900 border border-stone-800 p-3 flex flex-col gap-2">
            <div className="flex items-center justify-between text-xs text-stone-400">
              <span>{new Date(item.sentAt).toLocaleString('pt-BR')}</span>
              {item.score !== null && (
                <span className="rounded-full bg-stone-800 px-2 py-0.5 text-amber-200">
                  Score: {item.score}
                </span>
              )}
            </div>
            
            <div className="text-sm text-stone-200 line-clamp-3 whitespace-pre-wrap">
              {item.caption}
            </div>

            <div className="flex items-center gap-2 mt-2 pt-2 border-t border-stone-800 text-xs text-stone-400">
              <span className="bg-stone-800 px-2 py-0.5 rounded truncate max-w-[50%]">
                Alvo: {item.targetJid}
              </span>
              {item.variant && (
                <span className="bg-stone-800 px-2 py-0.5 rounded">
                  Var: {item.variant}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between pt-4">
        <button
          className="rounded bg-stone-800 px-3 py-1.5 text-sm disabled:opacity-50"
          disabled={page <= 1}
          onClick={() => setPage(p => p - 1)}
        >
          Anterior
        </button>
        <span className="text-sm text-stone-400">
          Página {page} de {totalPages || 1}
        </span>
        <button
          className="rounded bg-stone-800 px-3 py-1.5 text-sm disabled:opacity-50"
          disabled={page >= totalPages}
          onClick={() => setPage(p => p + 1)}
        >
          Próxima
        </button>
      </div>
    </div>
  );
}
