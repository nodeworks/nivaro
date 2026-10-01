/**
 * #1124 — "Tell me when workflows errors > 5/min": a prefilled `traffic` monitor (entity, metric,
 * threshold, window) from the inspector. Nothing is created until the admin confirms; the monitor
 * then notifies its creator on an ok → failing flip, like every ops monitor.
 */
import { useMutation } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { SimpleSelect } from '@/components/ui/simple-select'
import { api } from '@/lib/api'
import { useTrafficMap } from '../context'
import type { InspectorData } from '../Inspector'
import { inspectorActions } from '../registry/inspectorActions'
import { register } from '../registry/registry'
import type { Selection } from '../types'
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

/** "workflows errors per minute > 5 over 5 min" */
export function alertName(
  entity: string,
  metric: AlertMetric,
  threshold: number,
  windowS: number
): string {
  const m = METRICS.find((x) => x.value === metric)
  return `${entity} ${m?.label ?? metric} > ${threshold}${m?.unit === '%' ? '%' : m?.unit === 'ms' ? ' ms' : ''} over ${windowS / 60} min`
}

function NodeAlert({ sel, d }: { sel: Selection; d: InspectorData }) {
  const { win } = useTrafficMap()
  const e = entityOf(sel)
  const [open, setOpen] = useState(false)
  const [metric, setMetric] = useState<AlertMetric>('errors_per_min')
  const [threshold, setThreshold] = useState('')
  const [windowS, setWindowS] = useState(String(win))
  const [created, setCreated] = useState<number | null>(null)
  const selKey = `${sel.kind}:${sel.id}`
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new node starts with the form shut
  useEffect(() => {
    setOpen(false)
    setCreated(null)
  }, [selKey])
  const create = useMutation({
    mutationFn: async () => {
      const t = Number(threshold)
      const res = await api.post('/monitors', {
        type: 'traffic',
        name: alertName(d.name, metric, t, Number(windowS)),
        config: { entity: e?.key, metric, threshold: t, window_s: Number(windowS) },
        is_active: true
      })
      return Number((res?.data as { data?: { id?: number } })?.data?.id)
    },
    onSuccess: (id) => setCreated(id)
  })
  if (!e) return null
  const t = Number(threshold)
  const valid = threshold.trim() !== '' && Number.isFinite(t) && t >= 0
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
          <div className='flex flex-wrap items-center gap-2'>
            <ConfirmButton
              id='tm-alert-create'
              label='Create alert'
              confirmLabel={`Create “${alertName(d.name, metric, valid ? t : 0, Number(windowS))}”?`}
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
              <Link to='/monitors' className={LINK}>
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
