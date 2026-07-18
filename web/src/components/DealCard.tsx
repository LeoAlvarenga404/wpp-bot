import { useEffect, useMemo, useRef, useState } from 'react';
import { previewDeal } from '../api';
import type { CuratorEdits, PendingDeal } from '../types';
import { CaptionPreview } from './CaptionPreview';

const PREVIEW_DEBOUNCE_MS = 400;

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

/** "84,90" | "84.90" | "84" -> cents; null for empty/invalid/non-positive. */
function parsePriceToCents(input: string): number | null {
  const s = input.replace(/[R$\s]/g, '').replace(',', '.');
  if (!s) return null;
  const reais = Number(s);
  if (!Number.isFinite(reais) || reais <= 0) return null;
  return Math.round(reais * 100);
}

interface EditFields {
  headline: string;
  price: string;
  couponCode: string;
  couponPrice: string;
}

const EMPTY_FIELDS: EditFields = {
  headline: '',
  price: '',
  couponCode: '',
  couponPrice: '',
};

/** Empty fields mean "keep as is" — only filled fields become edits. */
function buildEdits(f: EditFields): CuratorEdits | undefined {
  const edits: CuratorEdits = {};
  if (f.headline.trim()) edits.headline = f.headline.trim();
  const priceCents = parsePriceToCents(f.price);
  if (priceCents != null) edits.priceCents = priceCents;
  if (f.couponCode.trim()) {
    const finalCents = parsePriceToCents(f.couponPrice);
    edits.coupon = {
      code: f.couponCode.trim(),
      ...(finalCents != null ? { finalCents } : {}),
    };
  }
  return Object.keys(edits).length > 0 ? edits : undefined;
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
  onApprove: (id: string, edits?: CuratorEdits) => Promise<void>;
  onReject: (id: string) => Promise<void>;
}) {
  const [acting, setActing] = useState<'approve' | 'reject' | null>(null);
  const [editing, setEditing] = useState(false);
  const [fields, setFields] = useState<EditFields>(EMPTY_FIELDS);
  const [preview, setPreview] = useState<{
    caption: string;
    imageUrl: string;
  } | null>(null);
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewSeq = useRef(0);

  const edits = useMemo(() => buildEdits(fields), [fields]);

  // Live preview: debounce while the curator types, ignore stale responses
  // (out-of-order network) and fall back silently to the last good caption.
  useEffect(() => {
    if (previewTimer.current) clearTimeout(previewTimer.current);
    if (!editing || !edits) {
      // Invalidate any in-flight preview so a late response can't resurrect
      // an edited caption after the fields were cleared or the editor closed.
      previewSeq.current++;
      setPreview(null);
      return;
    }
    const seq = ++previewSeq.current;
    previewTimer.current = setTimeout(() => {
      previewDeal(deal.id, edits)
        .then((p) => {
          if (previewSeq.current === seq) setPreview(p);
        })
        .catch(() => undefined);
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      if (previewTimer.current) clearTimeout(previewTimer.current);
    };
  }, [deal.id, editing, edits]);

  // A filled-but-unparseable price must never be silently dropped: block the
  // approve until the curator fixes or clears it.
  const priceInvalid =
    fields.price.trim() !== '' && parsePriceToCents(fields.price) == null;
  const couponPriceInvalid =
    fields.couponPrice.trim() !== '' &&
    parsePriceToCents(fields.couponPrice) == null;
  const invalidEdits = editing && (priceInvalid || couponPriceInvalid);

  const act = async (kind: 'approve' | 'reject') => {
    setActing(kind);
    try {
      await (kind === 'approve'
        ? onApprove(deal.id, editing ? edits : undefined)
        : onReject(deal.id));
    } finally {
      setActing(null);
    }
  };

  const toggleEditing = () => {
    setEditing((was) => {
      if (was) {
        setFields(EMPTY_FIELDS);
        setPreview(null);
      }
      return !was;
    });
  };

  const setField = (key: keyof EditFields) => (value: string) =>
    setFields((f) => ({ ...f, [key]: value }));

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
        <button
          type="button"
          onClick={toggleEditing}
          className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
            editing
              ? 'bg-amber-600 text-white'
              : 'bg-stone-800 text-stone-300 active:bg-stone-700'
          }`}
        >
          {editing ? 'Fechar ✕' : '✏️ Editar'}
        </button>
      </header>

      <CaptionPreview
        caption={editing && preview ? preview.caption : deal.caption}
        imageUrl={editing && preview ? preview.imageUrl : deal.imageUrl}
      />

      {editing && (
        <fieldset className="mt-3 flex flex-col gap-2" disabled={acting !== null}>
          <EditInput
            label="Headline"
            value={fields.headline}
            placeholder={deal.preview.title}
            onChange={setField('headline')}
          />
          <EditInput
            label="Preço final (R$)"
            value={fields.price}
            placeholder={(deal.preview.priceCents / 100).toFixed(2).replace('.', ',')}
            inputMode="decimal"
            onChange={setField('price')}
          />
          <div className="grid grid-cols-2 gap-2">
            <EditInput
              label="Cupom"
              value={fields.couponCode}
              placeholder="CÓDIGO"
              onChange={setField('couponCode')}
            />
            <EditInput
              label="Preço c/ cupom (R$)"
              value={fields.couponPrice}
              placeholder="—"
              inputMode="decimal"
              onChange={setField('couponPrice')}
            />
          </div>
          {invalidEdits ? (
            <p className="text-xs text-red-400">
              Preço inválido — corrija ou limpe o campo para aprovar.
            </p>
          ) : (
            edits && (
              <p className="text-xs text-amber-400">
                Aprovar publica com os valores editados.
              </p>
            )
          )}
        </fieldset>
      )}

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
          disabled={acting !== null || invalidEdits}
          onClick={() => void act('approve')}
          className="rounded-lg bg-green-600 py-3 text-base font-semibold text-white active:bg-green-500 disabled:opacity-50"
        >
          {acting === 'approve'
            ? '…'
            : editing && edits
              ? '✓ Aprovar editado'
              : '✓ Aprovar'}
        </button>
      </footer>
    </article>
  );
}

function EditInput({
  label,
  value,
  placeholder,
  inputMode,
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  inputMode?: 'decimal';
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-stone-400">{label}</span>
      <input
        type="text"
        inputMode={inputMode}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-lg border border-stone-700 bg-stone-950 px-2.5 py-2 text-sm text-stone-100 placeholder:text-stone-600"
      />
    </label>
  );
}
