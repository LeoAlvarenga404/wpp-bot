import { useEffect, useRef, useState } from 'react';
import {
  previewManual,
  resolveManual,
  submitManual,
  UnauthorizedError,
} from '../api';
import type { ManualFields } from '../types';
import { CaptionPreview } from './CaptionPreview';

const EMPTY: ManualFields = {
  store: 'ml',
  title: '',
  priceCents: 0,
  originalPriceCents: undefined,
  installmentsNoInterest: false,
  coupon: undefined,
  thumbnail: '',
  permalink: '',
};

function reais(cents: number): string {
  return (cents / 100).toFixed(2).replace('.', ',');
}
function cents(v: string): number {
  const n = Math.round(parseFloat(v.replace(',', '.')) * 100);
  return Number.isFinite(n) ? n : 0;
}

export function ManualComposer({
  onUnauthorized,
  onDone,
}: {
  onUnauthorized: () => void;
  onDone: (msg: string) => void;
}) {
  const [url, setUrl] = useState('');
  const [f, setF] = useState<ManualFields>(EMPTY);
  const [couponCode, setCouponCode] = useState('');
  const [couponFinal, setCouponFinal] = useState('');
  const [resolving, setResolving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ caption: string; imageUrl: string }>(
    { caption: '', imageUrl: '' },
  );
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const set = <K extends keyof ManualFields>(k: K, v: ManualFields[K]) =>
    setF((prev) => ({ ...prev, [k]: v }));

  // Assemble the coupon into the field payload.
  const fields: ManualFields = {
    ...f,
    coupon: couponCode.trim()
      ? {
          code: couponCode.trim(),
          finalCents: couponFinal ? cents(couponFinal) : undefined,
        }
      : undefined,
  };

  const canSend =
    f.title.trim() !== '' && f.priceCents > 0 && f.thumbnail.trim() !== '';

  // Debounced live preview — mirrors exactly what a card/dispatch would show.
  useEffect(() => {
    if (!canSend) {
      setPreview({ caption: '', imageUrl: '' });
      return;
    }
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => {
      previewManual(fields)
        .then(setPreview)
        .catch((e) => {
          if (e instanceof UnauthorizedError) onUnauthorized();
        });
    }, 400);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    f.title,
    f.priceCents,
    f.originalPriceCents,
    f.installmentsNoInterest,
    f.thumbnail,
    f.permalink,
    f.store,
    couponCode,
    couponFinal,
  ]);

  async function onResolve() {
    if (!url.trim()) return;
    setResolving(true);
    setError(null);
    try {
      const v = await resolveManual(url.trim());
      setF({
        store: v.source,
        title: v.title,
        priceCents: v.priceCents,
        originalPriceCents: v.originalPriceCents ?? undefined,
        installmentsNoInterest: v.installmentsNoInterest,
        thumbnail: v.thumbnail,
        permalink: v.permalink,
      });
    } catch (e) {
      if (e instanceof UnauthorizedError) return onUnauthorized();
      setError((e as Error).message);
    } finally {
      setResolving(false);
    }
  }

  async function onSubmit(dispatch: boolean) {
    if (!canSend) {
      setError('Preencha título, preço e imagem.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await submitManual(fields, dispatch);
      if (dispatch && res.enqueued === 0) {
        onDone(
          'Enviado, mas nada foi pra fila (dedup ou sem alvo). Veja a Fila.',
        );
      } else if (dispatch) {
        onDone(`Disparado para ${res.targets ?? 0} canal(is).`);
      } else {
        onDone('Adicionado à fila.');
      }
      setF(EMPTY);
      setUrl('');
      setCouponCode('');
      setCouponFinal('');
    } catch (e) {
      if (e instanceof UnauthorizedError) return onUnauthorized();
      // recently_posted (409) surfaces as a message; the card já ficou na fila.
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const inp =
    'w-full rounded-md border border-stone-700 bg-stone-900 px-2 py-1.5 text-sm text-stone-100 placeholder-stone-500 focus:border-stone-400 focus:outline-none';
  const lbl = 'mb-1 block text-xs font-medium text-stone-400';

  return (
    <div className="flex flex-col gap-4 md:flex-row">
      {/* form */}
      <div className="flex-1">
        <label className={lbl}>Colar link (opcional)</label>
        <div className="mb-4 flex gap-2">
          <input
            className={inp}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="meli.la/… ou link do anúncio"
          />
          <button
            type="button"
            disabled={resolving || !url.trim()}
            onClick={() => void onResolve()}
            className="shrink-0 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-40"
          >
            {resolving ? '…' : 'Resolver'}
          </button>
        </div>

        <div className="mb-3">
          <label className={lbl}>Título</label>
          <input
            className={inp}
            value={f.title}
            onChange={(e) => set('title', e.target.value)}
          />
        </div>

        <div className="mb-3 grid grid-cols-2 gap-2">
          <div>
            <label className={lbl}>De (R$)</label>
            <input
              className={inp}
              value={f.originalPriceCents ? reais(f.originalPriceCents) : ''}
              onChange={(e) =>
                set(
                  'originalPriceCents',
                  e.target.value ? cents(e.target.value) : undefined,
                )
              }
            />
          </div>
          <div>
            <label className={lbl}>Por PIX (R$)</label>
            <input
              className={inp}
              value={f.priceCents ? reais(f.priceCents) : ''}
              onChange={(e) => set('priceCents', cents(e.target.value))}
            />
          </div>
        </div>

        <label className="mb-3 flex items-center gap-2 text-sm text-stone-300">
          <input
            type="checkbox"
            checked={!!f.installmentsNoInterest}
            onChange={(e) => set('installmentsNoInterest', e.target.checked)}
          />
          Parcela sem juros
        </label>

        <div className="mb-3 grid grid-cols-2 gap-2">
          <div>
            <label className={lbl}>Cupom (código)</label>
            <input
              className={inp}
              value={couponCode}
              onChange={(e) => setCouponCode(e.target.value)}
            />
          </div>
          <div>
            <label className={lbl}>Preço c/ cupom (R$)</label>
            <input
              className={inp}
              value={couponFinal}
              onChange={(e) => setCouponFinal(e.target.value)}
            />
          </div>
        </div>

        <div className="mb-3">
          <label className={lbl}>Imagem (URL)</label>
          <input
            className={inp}
            value={f.thumbnail}
            onChange={(e) => set('thumbnail', e.target.value)}
          />
        </div>

        <div className="mb-4">
          <label className={lbl}>Link (opcional)</label>
          <input
            className={inp}
            value={f.permalink ?? ''}
            onChange={(e) => set('permalink', e.target.value)}
          />
        </div>

        {error && <p className="mb-3 text-sm text-red-400">{error}</p>}

        <div className="flex gap-2">
          <button
            type="button"
            disabled={busy || !canSend}
            onClick={() => void onSubmit(false)}
            className="flex-1 rounded-md border border-stone-600 px-3 py-2 text-sm font-semibold text-stone-100 disabled:opacity-40"
          >
            ➕ Pra fila
          </button>
          <button
            type="button"
            disabled={busy || !canSend}
            onClick={() => void onSubmit(true)}
            className="flex-1 rounded-md bg-green-700 px-3 py-2 text-sm font-semibold text-white disabled:opacity-40"
          >
            ⚡ Dispara já
          </button>
        </div>
      </div>

      {/* live preview */}
      <div className="flex-1">
        <label className={lbl}>Preview ao vivo</label>
        {preview.caption ? (
          <CaptionPreview
            caption={preview.caption}
            imageUrl={preview.imageUrl}
          />
        ) : (
          <p className="rounded-lg border border-dashed border-stone-700 px-3 py-16 text-center text-sm text-stone-500">
            Preencha título, preço e imagem pra ver o preview.
          </p>
        )}
      </div>
    </div>
  );
}
