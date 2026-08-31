import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Radar, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * Monitors — the always-watching checks: data freshness (an integration-fed
 * collection went quiet), deploy regression (performance degraded after a
 * version change), synthetic probes (a scripted request broke or slowed).
 * Evaluated every 5 minutes; failures raise issues and notify the creator.
 */

interface Monitor {
  id: number
  type: 'freshness' | 'deploy_regression' | 'synthetic' | 'ssl_cert'
  name: string
  config: Record<string, unknown> | null
  is_active: boolean
  last_status: 'ok' | 'failing' | 'unknown'
  last_checked_at: string | null
  last_detail: string | null
}

const TYPE_LABEL: Record<Monitor['type'], string> = {
  freshness: 'Data freshness',
  deploy_regression: 'Deploy regression',
  synthetic: 'Synthetic probe',
  ssl_cert: 'SSL certificate'
}

const STATUS_DOT: Record<string, string> = {
  ok: 'bg-emerald-500',
  failing: 'bg-red-500',
  unknown: 'bg-slate-300'
}

function rel(ts: string | null): string {
  if (!ts) return 'never'
  const diff = Date.now() - new Date(ts).getTime()
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  return `${Math.floor(diff / 3_600_000)}h ago`
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11.5px] font-medium text-slate-600 dark:text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  )
}

const inputCls =
  'h-8 w-full rounded-md border border-slate-200 bg-background px-2.5 text-[12.5px] text-slate-800 dark:border-border dark:text-foreground'

function CreateForm({ onDone }: { onDone: () => void }) {
  const [type, setType] = useState<Monitor['type']>('freshness')
  const [name, setName] = useState('')
  // freshness
  const [collection, setCollection] = useState('')
  const [maxAge, setMaxAge] = useState('24')
  // synthetic
  const [path, setPath] = useState('/api/health')
  const [latency, setLatency] = useState('5000')
  // deploy
  const [worsen, setWorsen] = useState('50')
  // ssl_cert
  const [sslHost, setSslHost] = useState('')
  const [warnDays, setWarnDays] = useState('30')

  const create = useMutation({
    mutationFn: () => {
      const config =
        type === 'freshness'
          ? { collection: collection.trim(), max_age_hours: Number(maxAge) || 24 }
          : type === 'synthetic'
            ? { path: path.trim(), latency_warn_ms: Number(latency) || 5000 }
            : type === 'ssl_cert'
              ? { host: sslHost.trim(), warn_days: Number(warnDays) || 30 }
              : { p95_worsen_pct: Number(worsen) || 50 }
      return api.post('/monitors', { type, name: name.trim(), config })
    },
    onSuccess: () => {
      toast.success('Monitor created — first check runs within 5 minutes')
      onDone()
    },
    onError: (e: { response?: { data?: { error?: string } } }) =>
      toast.error(e.response?.data?.error ?? 'Create failed')
  })

  const canSave =
    name.trim().length > 0 &&
    (type === 'freshness'
      ? collection.trim().length > 0
      : type === 'synthetic'
        ? path.trim().length > 0
        : type === 'ssl_cert'
          ? sslHost.trim().length > 0
          : true)

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card">
      <p className="text-[13px] font-semibold text-slate-800 dark:text-foreground">New monitor</p>
      <div className="mt-3 grid max-w-[720px] grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="sm:col-span-3">
          <Field label="Type">
            <span className="inline-flex rounded-md border border-slate-200 p-0.5 dark:border-border">
              {(Object.keys(TYPE_LABEL) as Monitor['type'][]).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setType(t)}
                  className={cn(
                    'whitespace-nowrap rounded px-3 py-1 text-[11.5px] font-medium transition-colors',
                    type === t
                      ? 'bg-nvr-cyan/10 text-slate-800 dark:text-foreground'
                      : 'text-slate-400 hover:text-slate-600 dark:hover:text-slate-300'
                  )}
                >
                  {TYPE_LABEL[t]}
                </button>
              ))}
            </span>
          </Field>
        </div>
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Warehouse inventory feed" className={inputCls} />
        </Field>
        {type === 'freshness' && (
          <>
            <Field label="Collection">
              <input value={collection} onChange={(e) => setCollection(e.target.value)} placeholder="warehouse_inventory" className={inputCls} />
            </Field>
            <Field label="Max age (hours)">
              <input value={maxAge} onChange={(e) => setMaxAge(e.target.value)} type="number" className={inputCls} />
            </Field>
          </>
        )}
        {type === 'synthetic' && (
          <>
            <Field label="Path or URL">
              <input value={path} onChange={(e) => setPath(e.target.value)} className={inputCls} />
            </Field>
            <Field label="Latency limit (ms)">
              <input value={latency} onChange={(e) => setLatency(e.target.value)} type="number" className={inputCls} />
            </Field>
          </>
        )}
        {type === 'deploy_regression' && (
          <Field label="p95 worsens by (%)">
            <input value={worsen} onChange={(e) => setWorsen(e.target.value)} type="number" className={inputCls} />
          </Field>
        )}
        {type === 'ssl_cert' && (
          <>
            <Field label="Domain">
              <input value={sslHost} onChange={(e) => setSslHost(e.target.value)} placeholder="efp-staging.cable.example.com" className={inputCls} />
            </Field>
            <Field label="Warn (days before expiry)">
              <input value={warnDays} onChange={(e) => setWarnDays(e.target.value)} type="number" className={inputCls} />
            </Field>
          </>
        )}
      </div>
      {type === 'freshness' && (
        <p className="mt-2 text-[11.5px] text-slate-400">
          Fails when the collection's newest timestamp is older than the limit — catches an import
          pipeline that silently stopped delivering.
        </p>
      )}
      {type === 'deploy_regression' && (
        <p className="mt-2 text-[11.5px] text-slate-400">
          Watches the API version; when a deploy lands it snapshots the prior hour's performance and
          compares an hour later — a regression names the slowest routes.
        </p>
      )}
      {type === 'synthetic' && (
        <p className="mt-2 text-[11.5px] text-slate-400">
          Requests the path every 5 minutes; a non-200 answer or a slow response fails the check.
        </p>
      )}
      {type === 'ssl_cert' && (
        <p className="mt-2 text-[11.5px] text-slate-400">
          Reads the domain's TLS certificate on every sweep and fails when it is expired or inside
          the warning window — an expiring cert raises an issue and notifies you before it bites.
        </p>
      )}
      <div className="mt-3">
        <button
          type="button"
          disabled={!canSave || create.isPending}
          onClick={() => create.mutate()}
          className="h-8 rounded-md bg-nvr-cyan px-4 text-[12.5px] font-medium text-white disabled:opacity-50"
        >
          {create.isPending ? 'Creating…' : 'Create monitor'}
        </button>
      </div>
    </div>
  )
}

export default function Monitors() {
  const qc = useQueryClient()
  const [showCreate, setShowCreate] = useState(false)
  const [checking, setChecking] = useState<number | null>(null)

  const { data: monitors = [], isLoading } = useQuery<Monitor[]>({
    queryKey: ['ops-monitors'],
    queryFn: () => api.get('/monitors').then((r) => r.data.data),
    refetchInterval: 30_000
  })

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['ops-monitors'] })

  const checkNow = async (m: Monitor) => {
    setChecking(m.id)
    try {
      const r = await api.post(`/monitors/${m.id}/check`)
      const res = r.data.data as { status: string; detail: string }
      ;(res.status === 'failing' ? toast.error : toast.success)(res.detail, { duration: 8000 })
    } finally {
      setChecking(null)
      invalidate()
    }
  }

  const patch = useMutation({
    mutationFn: ({ id, body }: { id: number; body: Record<string, unknown> }) =>
      api.patch(`/monitors/${id}`, body),
    onSuccess: invalidate
  })
  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`/monitors/${id}`),
    onSuccess: invalidate
  })

  const failing = monitors.filter((m) => m.is_active && m.last_status === 'failing')

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <header className="shrink-0 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Radar className="h-5 w-5 text-muted-foreground" />
            <div>
              <h1 className="text-[17px] font-semibold text-slate-900 dark:text-foreground">Monitors</h1>
              <p className="mt-0.5 text-[12.5px] text-slate-500 dark:text-muted-foreground">
                Always-on checks, evaluated every 5 minutes: data freshness, post-deploy
                performance, synthetic probes, SSL certificates. Failures raise issues and notify
                whoever created the monitor.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setShowCreate((v) => !v)}
            className="h-8 rounded-md bg-nvr-cyan px-3.5 text-[12.5px] font-medium text-white"
          >
            {showCreate ? 'Close' : '＋ New monitor'}
          </button>
        </div>
      </header>

      <div className="flex-1 space-y-4 overflow-y-auto p-6">
        {showCreate && (
          <CreateForm
            onDone={() => {
              setShowCreate(false)
              invalidate()
            }}
          />
        )}

        {failing.length > 0 && (
          <div className="rounded-lg border border-red-200 bg-red-50/60 px-4 py-3 dark:border-red-500/30 dark:bg-red-500/5">
            <p className="text-[12.5px] font-semibold text-red-700 dark:text-red-400">
              {failing.length} monitor{failing.length === 1 ? '' : 's'} failing
            </p>
          </div>
        )}

        <div className="space-y-2">
          {isLoading && <p className="text-[12px] text-slate-400">Loading…</p>}
          {!isLoading && monitors.length === 0 && !showCreate && (
            <div className="rounded-lg border border-dashed border-slate-300 p-8 text-center dark:border-border">
              <p className="text-[13px] font-medium text-slate-600 dark:text-foreground">No monitors yet</p>
              <p className="mt-1 text-[12px] text-slate-400">
                Start with a freshness check on an integration-fed collection, or a synthetic probe
                on /api/health.
              </p>
            </div>
          )}
          {monitors.map((m) => (
            <div
              key={m.id}
              className={cn(
                'flex items-start gap-3 rounded-lg border bg-white px-4 py-3 dark:bg-card',
                m.last_status === 'failing' && m.is_active
                  ? 'border-red-200 dark:border-red-500/30'
                  : 'border-slate-200 dark:border-border',
                !m.is_active && 'opacity-60'
              )}
            >
              <span className={cn('mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full', STATUS_DOT[m.last_status])} />
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium text-slate-800 dark:text-foreground">
                  {m.name}
                  <span className="ml-2 rounded-full bg-slate-100 px-2 py-px text-[10.5px] font-medium text-slate-500 dark:bg-muted dark:text-muted-foreground">
                    {TYPE_LABEL[m.type]}
                  </span>
                </p>
                <p className="mt-0.5 whitespace-pre-wrap text-[12px] text-slate-500 dark:text-muted-foreground">
                  {m.last_detail ?? 'Not checked yet'}
                </p>
                <p className="mt-0.5 text-[11px] text-slate-400">Checked {rel(m.last_checked_at)}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  disabled={checking === m.id}
                  onClick={() => checkNow(m)}
                  className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-[11.5px] text-slate-600 hover:border-slate-300 disabled:opacity-50 dark:border-border dark:text-muted-foreground"
                >
                  <RefreshCw className={cn('h-3 w-3', checking === m.id && 'animate-spin')} strokeWidth={2} />
                  Check now
                </button>
                <button
                  type="button"
                  onClick={() => patch.mutate({ id: m.id, body: { is_active: !m.is_active } })}
                  className={cn(
                    'rounded-full border px-2 py-0.5 text-[11px] font-medium',
                    m.is_active
                      ? 'border-emerald-300 text-emerald-700 dark:border-emerald-500/40 dark:text-emerald-400'
                      : 'border-slate-200 text-slate-400 dark:border-border'
                  )}
                >
                  {m.is_active ? 'Active' : 'Paused'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (window.confirm(`Delete monitor "${m.name}"?`)) remove.mutate(m.id)
                  }}
                  className="text-[13px] text-slate-300 transition-colors hover:text-red-500"
                >
                  ✕
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
