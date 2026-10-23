/**
 * #1124 — "Tell me when workflows errors > 5/min": a prefilled `traffic` monitor (entity, metric,
 * threshold, window) from the inspector. Nothing is created until the admin confirms; the monitor
 * then notifies its creator on an ok → failing flip, like every ops monitor.
 *
 * #2247 — the alert can be on an edge instead of the whole node: one caller's traffic into it, or
 * its calls out to one partner (same metrics, thresholds and channels; config `edge`).
 * #2222 — while the form is open it replays the alert over the last two weeks of the request log
 * and lists each moment it would have fired, so the threshold can be set before saving.
 */
import { useMutation, useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { SimpleSelect } from '@/components/ui/simple-select'
import { api } from '@/lib/api'
import { useTrafficMap } from '../context'
import { callerLabel } from '../EventTicker'
import type { InspectorData } from '../Inspector'
import { inspectorActions } from '../registry/inspectorActions'
import { register } from '../registry/registry'
import { Sparkline } from '../Sparkline'
import type { Selection, TrafficCatalog } from '../types'
import { BTN, ConfirmButton, entityOf, errorOf, INPUT, LINK, Note } from './shared'

export type AlertMetric = 'errors_per_min' | 'requests_per_min' | 'p95_ms' | 'error_pct'
export const METRICS: Array<{ value: AlertMetric; label: string; unit: string }> = [
  { value: 'errors_per_min', label: 'errors per minute', unit: '/min' },
  { value: 'error_pct', label: 'error rate', unit: '%' },
  { value: 'requests_per_min', label: 'requests per minute', unit: '/min' },
  { value: 'p95_ms', label: 'p95 latency', unit: 'ms' }
]
const WINDOWS = [
  { value: '60', label: '1 min' },
  { value: '300', label: '5 min' },
  { value: '900', label: '15 min' }
]

/** A starting threshold a little above what the node does now (whole numbers, ≥ 1). */
export function suggestThreshold(metric: AlertMetric, d: InspectorData): number {
  const errPerMin = d.rps * 60 * (Number.isFinite(d.errPct) ? d.errPct / 100 : 0)
  const v =
    metric === 'errors_per_min'
      ? errPerMin * 2
      : metric === 'requests_per_min'
        ? d.rps * 60 * 2
        : metric === 'p95_ms'
          ? d.p95 * 1.5
          : (Number.isFinite(d.errPct) ? d.errPct : 0) * 2
  return Math.max(metric === 'p95_ms' ? 500 : 5, Math.ceil(v))
}

/** "workflows errors per minute > 5 over 5 min" (`scope` names an edge: "from Ops key"). */
export function alertName(
  entity: string,
  metric: AlertMetric,
  threshold: number,
  windowS: number,
  scope?: string
): string {
  const m = METRICS.find((x) => x.value === metric)
  return `${entity}${scope ? ` ${scope}` : ''} ${m?.label ?? metric} > ${threshold}${m?.unit === '%' ? '%' : m?.unit === 'ms' ? ' ms' : ''} over ${windowS / 60} min`
}

/** #2247 — the edge a scope value names (`from:<caller>` / `to:<down id>`; '' = whole node). */
export function edgeOfScope(scope: string): { from: string } | { to: string } | null {
  if (scope.startsWith('from:')) return { from: scope.slice(5) }
  if (scope.startsWith('to:')) return { to: scope.slice(3) }
  return null
}

const CALLER_KEY = /^(k\d+|u[0-9A-F-]{36}|anon|cron)$/

/** Scope choices for an entity: the whole node, each top caller in, each partner out. */
export function scopeOptions(
  d: InspectorData,
  downs: string[],
  catalog: TrafficCatalog | null
): Array<{ value: string; label: string }> {
  const out = [{ value: '', label: 'all its traffic' }]
  for (const c of d.callers.slice(0, 6))
    if (CALLER_KEY.test(c.key))
      out.push({ value: `from:${c.key}`, label: `from ${callerLabel(catalog, c.key)}` })
  for (const id of downs.filter((x) => x.startsWith('ext:')).slice(0, 6))
    out.push({ value: `to:${id}`, label: `calling ${catalog?.partners[id.slice(4)] ?? id}` })
  return out
}

interface Preview {
  kind: 'ok' | 'unsupported'
  reason?: string
  fired?: number
  failing_checks?: number
  checks?: number
  episodes?: Array<{ from: number; to: number; peak: number; checks: number }>
  hourly?: number[]
  peak?: number
  truncated?: boolean
}

const when = (ms: number) =>
  new Date(ms).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit'
  })

/** #2222 — the alert replayed over two weeks of history (debounced while the form changes). */
function AlertPreview({ config }: { config: Record<string, unknown> | null }) {
  const key = config ? JSON.stringify(config) : ''
  const [cfgKey, setCfgKey] = useState(key)
  useEffect(() => {
    const t = setTimeout(() => setCfgKey(key), 500)
    return () => clearTimeout(t)
  }, [key])
  const q = useQuery({
    queryKey: ['traffic-map', 'alert-preview', cfgKey],
    queryFn: async () => {
      const res = await api.post('/traffic-map/alert-preview', JSON.parse(cfgKey))
      return (res.data as { data: Preview }).data
    },
    enabled: !!cfgKey,
    staleTime: 5 * 60_000,
    retry: false
  })
  if (!config) return null
  const p = q.data
  return (
    <div
      className='grid gap-1.5 text-[11.5px]'
      id='tm-alert-preview'
      data-tm-fired={p?.fired ?? ''}
    >
      {q.isLoading || cfgKey !== key ? (
        <p className='text-[var(--tm-muted)]'>Replaying the last two weeks…</p>
      ) : q.isError ? (
        <p className='text-[var(--tm-error-ink)]'>{errorOf(q.error)}</p>
      ) : p?.kind === 'unsupported' ? (
        <p className='text-[var(--tm-muted)]'>{p.reason}</p>
      ) : p ? (
        <>
          <p className='text-[var(--tm-fg-2)]'>
            {p.fired
              ? `Over the last two weeks this would have fired ${p.fired} time${p.fired === 1 ? '' : 's'} (failing in ${p.failing_checks} of ${p.checks} checks).`
              : `Over the last two weeks this would never have fired (highest figure ${p.peak}).`}
            {p.truncated ? ' Only the newest 200,000 requests were replayed.' : ''}
          </p>
          {p.hourly?.some((v) => v > 0) && (
            <Sparkline
              data={p.hourly}
              color={p.fired ? 'var(--tm-error)' : 'var(--tm-accent)'}
              className='block h-7 w-full'
            />
          )}
          {p.episodes && p.episodes.length > 0 && (
            <ul className='grid gap-0.5 text-[var(--tm-fg-2)]'>
              {p.episodes.slice(0, 5).map((e) => (
                <li key={e.from} className='tabular-nums'>
                  {when(e.from)}
                  {e.to > e.from ? ` for ${Math.round((e.to - e.from) / 60_000) + 5} min` : ''} ·
                  peak {e.peak}
                </li>
              ))}
              {p.episodes.length > 5 && (
                <li className='text-[var(--tm-muted)]'>and {p.episodes.length - 5} more</li>
              )}
            </ul>
          )}
        </>
      ) : null}
    </div>
  )
}

function NodeAlert({ sel, d }: { sel: Selection; d: InspectorData }) {
  const { win, model, catalog } = useTrafficMap()
  const e = entityOf(sel)
  const [open, setOpen] = useState(false)
  const [scope, setScope] = useState('')
  const [metric, setMetric] = useState<AlertMetric>('errors_per_min')
  const [threshold, setThreshold] = useState('')
  const [windowS, setWindowS] = useState(String(win))
  const [created, setCreated] = useState<number | null>(null)
  const selKey = `${sel.kind}:${sel.id}`
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new node starts with the form shut
  useEffect(() => {
    setOpen(false)
    setCreated(null)
    setScope('')
  }, [selKey])
  const downs = e ? Object.keys(model.entityMeta(e.key)?.down ?? {}) : []
  const scopes = scopeOptions(d, downs, catalog)
  const scopeLabel = scope ? (scopes.find((x) => x.value === scope)?.label ?? '') : ''
  const edge = edgeOfScope(scope)
  const create = useMutation({
    mutationFn: async () => {
      const t = Number(threshold)
      const res = await api.post('/monitors', {
        type: 'traffic',
        name: alertName(d.name, metric, t, Number(windowS), scopeLabel),
        config: {
          entity: e?.key,
          metric,
          threshold: t,
          window_s: Number(windowS),
          ...(edge ? { edge } : {})
        },
        is_active: true
      })
      return Number((res?.data as { data?: { id?: number } })?.data?.id)
    },
    onSuccess: (id) => setCreated(id)
  })
  if (!e) return null
  const t = Number(threshold)
  const valid = threshold.trim() !== '' && Number.isFinite(t) && t >= 0
  const previewConfig =
    open && valid && created == null
      ? {
          entity: e.key,
          metric,
          threshold: t,
          window_s: Number(windowS),
          ...(edge ? { edge } : {})
        }
      : null
  return (
    <>
      <button
        type='button'
        className={BTN}
        id='tm-alert'
        aria-expanded={open}
        onClick={() => {
          if (!open) setThreshold(String(suggestThreshold(metric, d)))
          setOpen((v) => !v)
          setCreated(null)
        }}
      >
        Alert
      </button>
      {open && (
        <div
          className='grid basis-full gap-2 rounded-md border border-[var(--tm-line)] bg-[var(--tm-card-2)] px-2.5 py-2 text-[12px]'
          data-tm-alert-form=''
        >
          <div className='flex flex-wrap items-center gap-1.5'>
            <span className='text-[var(--tm-fg-2)]'>Tell me when</span>
            <span className='font-mono text-[11.5px] font-medium'>{d.name}</span>
            {scopes.length > 1 && (
              <SimpleSelect
                value={scope}
                onChange={setScope}
                options={scopes}
                ariaLabel='Traffic'
                triggerProps={{ id: 'tm-alert-scope' }}
                className='h-7 w-auto min-w-[120px] max-w-[220px] border-[var(--tm-line)] bg-[var(--tm-card)] px-2 text-[12px]'
              />
            )}
            <SimpleSelect
              value={metric}
              onChange={(v) => {
                setMetric(v as AlertMetric)
                setThreshold(String(suggestThreshold(v as AlertMetric, d)))
              }}
              options={METRICS.map((m) => ({ value: m.value, label: m.label }))}
              ariaLabel='Metric'
              triggerProps={{ id: 'tm-alert-metric' }}
              className='h-7 w-auto min-w-[150px] border-[var(--tm-line)] bg-[var(--tm-card)] px-2 text-[12px]'
            />
            <span className='text-[var(--tm-fg-2)]'>is above</span>
            <input
              id='tm-alert-threshold'
              aria-label='Threshold'
              inputMode='decimal'
              value={threshold}
              onChange={(ev) => setThreshold(ev.target.value)}
              className={`${INPUT} w-20 tabular-nums`}
            />
            <span className='text-[var(--tm-fg-2)]'>over</span>
            <SimpleSelect
              value={windowS}
              onChange={setWindowS}
              options={WINDOWS}
              ariaLabel='Window'
              triggerProps={{ id: 'tm-alert-window' }}
              className='h-7 w-auto min-w-[84px] border-[var(--tm-line)] bg-[var(--tm-card)] px-2 text-[12px]'
            />
          </div>
          <p className='text-[11.5px] text-[var(--tm-muted)]'>
            A traffic monitor, checked every 5 minutes by the instance that runs scheduled jobs, on
            its own traffic. You are told when it starts failing.
          </p>
          <AlertPreview config={previewConfig} />
          <div className='flex flex-wrap items-center gap-2'>
            <ConfirmButton
              id='tm-alert-create'
              label='Create alert'
              confirmLabel={`Create “${alertName(d.name, metric, valid ? t : 0, Number(windowS), scopeLabel)}”?`}
              disabled={!valid || created != null}
              busy={create.isPending}
              onConfirm={() => create.mutate()}
            />
            <button type='button' className={BTN} onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
          {create.isError && <Note tone='error'>{errorOf(create.error)}</Note>}
          {created != null && (
            <Note tone='ok'>
              Monitor #{created} created.{' '}
              <Link to='/health/monitors' className={LINK}>
                Open Monitors
              </Link>
            </Note>
          )}
        </div>
      )}
    </>
  )
}

register(inspectorActions, {
  id: 'node-alert',
  order: 50,
  applies: (sel) => {
    const e = entityOf(sel)
    return !!e && !e.entity.startsWith('__')
  },
  Component: NodeAlert
})
