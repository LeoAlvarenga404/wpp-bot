import { useCallback, useEffect, useState } from 'react';
import { getCalibrationStats, getOpsConfig, setOpsConfig } from '../api';
import type { CalibrationStats } from '../types';

export function ConfigPanel({
  onUnauthorized,
}: {
  onUnauthorized: () => void;
}) {
  const [configs, setConfigs] = useState<Record<string, string>>({});
  const [stats, setStats] = useState<CalibrationStats | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [saving, setSaving] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setStatus('loading');
    try {
      const [configData, statsData] = await Promise.all([
        getOpsConfig(),
        getCalibrationStats(7),
      ]);
      const configMap = configData.values.reduce(
        (acc: Record<string, string>, item: any) => {
          acc[item.key] = item.value;
          return acc;
        },
        {},
      );
      setConfigs(configMap);
      setStats(statsData);
      setStatus('ready');
    } catch (err: any) {
      if (err.message === 'unauthorized') onUnauthorized();
      else setStatus('error');
    }
  }, [onUnauthorized]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const handleSave = async (key: string, value: string) => {
    setSaving(key);
    try {
      const data = await setOpsConfig(key, value);
      const configMap = data.values.reduce(
        (acc: Record<string, string>, item: any) => {
          acc[item.key] = item.value;
          return acc;
        },
        {},
      );
      setConfigs(configMap);
    } catch (err: any) {
      if (err.message === 'unauthorized') onUnauthorized();
      else alert(`Erro ao salvar ${key}: ${err.message}`);
    } finally {
      setSaving(null);
    }
  };

  if (status === 'loading') {
    return <p className="py-16 text-center text-stone-400">Carregando…</p>;
  }

  if (status === 'error') {
    return (
      <p className="py-16 text-center text-red-400">
        Não consegui carregar as configurações.{' '}
        <button type="button" className="underline" onClick={() => void loadData()}>
          Tentar de novo
        </button>
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-2xl border border-stone-800 bg-stone-900 p-4 shadow-xl">
        <h2 className="mb-4 text-xl font-bold text-stone-100">Configurações</h2>
        <div className="flex flex-col gap-4">
          <ConfigField
            label="Threshold (Auto-approve score)"
            description="Deals com score >= a este valor são enviados automaticamente. 999 = tudo manual."
            value={configs['AUTO_APPROVE_SCORE'] || '999'}
            onSave={(val) => handleSave('AUTO_APPROVE_SCORE', val)}
            saving={saving === 'AUTO_APPROVE_SCORE'}
          />
          <ConfigField
            label="Quiet Hours Enabled"
            description="Pausa o envio de DMs de madrugada."
            value={configs['QUIET_HOURS_ENABLED'] || 'true'}
            options={['true', 'false']}
            onSave={(val) => handleSave('QUIET_HOURS_ENABLED', val)}
            saving={saving === 'QUIET_HOURS_ENABLED'}
          />
          <ConfigField
            label="Intervalo DMs (minutos)"
            description="Minutos entre os lotes de alertas."
            value={configs['DM_BATCH_INTERVAL_MIN'] || '30'}
            onSave={(val) => handleSave('DM_BATCH_INTERVAL_MIN', val)}
            saving={saving === 'DM_BATCH_INTERVAL_MIN'}
          />
        </div>
      </section>

      {stats && (
        <section className="rounded-2xl border border-stone-800 bg-stone-900 p-4 shadow-xl">
          <h2 className="mb-4 text-xl font-bold text-stone-100">
            Calibração (Últimos {stats.periodDays} dias)
          </h2>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <div className="rounded-xl border border-green-900/30 bg-green-950/20 p-3">
              <p className="text-sm text-stone-400">Aprovados</p>
              <p className="text-2xl font-bold text-green-400">{stats.approved}</p>
              <p className="mt-1 text-xs text-stone-500">
                Score Médio:{' '}
                {stats.avgApprovedScore !== null ? stats.avgApprovedScore : '-'}
              </p>
            </div>
            <div className="rounded-xl border border-red-900/30 bg-red-950/20 p-3">
              <p className="text-sm text-stone-400">Rejeitados</p>
              <p className="text-2xl font-bold text-red-400">{stats.rejected}</p>
              <p className="mt-1 text-xs text-stone-500">
                Score Médio:{' '}
                {stats.avgRejectedScore !== null ? stats.avgRejectedScore : '-'}
              </p>
            </div>
            <div className="rounded-xl border border-stone-800 bg-stone-950/50 p-3">
              <p className="text-sm text-stone-400">Expirados</p>
              <p className="text-2xl font-bold text-stone-300">{stats.expired}</p>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

function ConfigField({
  label,
  description,
  value,
  options,
  onSave,
  saving,
}: {
  label: string;
  description: string;
  value: string;
  options?: string[];
  onSave: (val: string) => void;
  saving: boolean;
}) {
  const [val, setVal] = useState(value);
  const changed = val !== value;

  // Sync internal state when external value changes (after a save, or load)
  useEffect(() => {
    setVal(value);
  }, [value]);

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-stone-800 bg-stone-950 p-3">
      <div>
        <h3 className="font-semibold text-stone-200">{label}</h3>
        <p className="text-xs text-stone-400">{description}</p>
      </div>
      <div className="flex items-center gap-2">
        {options ? (
          <select
            value={val}
            onChange={(e) => setVal(e.target.value)}
            className="flex-1 rounded bg-stone-800 px-2 py-1.5 text-sm outline-none focus:ring-1 focus:ring-stone-600"
          >
            {options.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        ) : (
          <input
            type="text"
            value={val}
            onChange={(e) => setVal(e.target.value)}
            className="flex-1 rounded bg-stone-800 px-2 py-1.5 text-sm outline-none focus:ring-1 focus:ring-stone-600"
          />
        )}
        {changed && (
          <button
            onClick={() => onSave(val)}
            disabled={saving}
            className="rounded bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-50"
          >
            {saving ? '...' : 'Salvar'}
          </button>
        )}
      </div>
    </div>
  );
}
