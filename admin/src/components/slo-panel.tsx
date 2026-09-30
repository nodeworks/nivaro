import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Gauge } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * Service levels (#666) — availability, p95 latency and error-budget burn per
 * instance against the targets in Settings, for this database's instances
 * and for every other environment's registered API (asked server-side).
 */

interface SloTargets {
  availability_pct: number
  p95_ms: number
  window_days: number
}
interface InstanceSlo {
  instance: string
  requests: number
  errors_5xx: number
  availability_pct: number | null
  p95_ms: number | null
  budget: { allowed: number; consumed: number; remaining_pct: number | null }
  burn: { h1: number | null; h6: number | null; h24: number | null }
  days: Array<{
    day: string
    requests: number
    availability_pct: number | null
    p95_ms: number | null
  }>
  meets: { availability: boolean | null; p95: boolean | null }
}
interface SloReport {
  targets: SloTargets
  instances: InstanceSlo[]
  monitors: Array<{ monitor: string; checks: number; failing: number; uptime_pct: number | null }>
  instance_tracked: boolean
}
interface RemoteSlo {
  id: number
  name: string
  environment: string | null
  state: 'ok' | 'no-token' | 'unreachable' | 'not-supported'
  note?: string
  slo: SloReport | null
}

const n = (v: number) => v.toLocaleString()

/** Multi-window burn: 1h ≥ 14 spends a 30-day budget in ~2 days — page now. */
function burnTone(v: number | null, fast: boolean): string {
  if (v == null) return 'text-slate-400'
  if (v >= (fast ? 14 : 6)) return 'text-red-700 dark:text-red-300'
  if (v >= (fast ? 6 : 2)) return 'text-amber-700 dark:text-amber-300'
  return 'text-slate-600 dark:text-slate-300'
}

function DayBars({ days, target }: { days: InstanceSlo['days']; target: number }) {
  if (days.length === 0) return null
  return (
    <div className='flex h-6 items-end gap-0.5' title='Availability per day (UTC)'>
      {days.map((d) => {
        const ok = d.availability_pct == null || d.availability_pct >= target
        return (
          <span
            key={d.day}
            title={`${d.day}: ${d.availability_pct ?? '—'}% of ${n(d.requests)} · p95 ${d.p95_ms ?? '—'} ms`}
            className={cn(
              'w-2 rounded-sm',
              ok ? 'bg-emerald-500/70 dark:bg-emerald-400/60' : 'bg-red-500/80 dark:bg-red-400/70'
            )}
            style={{ height: `${Math.max(20, Math.min(100, d.requests ? 100 : 20))}%` }}
          />
        )
      })}
    </div>
  )
}

function InstanceRow({ label, i, t }: { label: string; i: InstanceSlo; t: SloTargets }) {
  const remaining = i.budget.remaining_pct
  return (
    <tr
      data-slo-instance={label}
      className='border-b border-slate-100 align-middle last:border-0 dark:border-border/50'
    >
      <td className='py-2 pr-3'>
        <p className='text-[12px] font-medium text-slate-800 dark:text-slate-100'>{label}</p>
        <p className='text-[10.5px] text-slate-500 dark:text-slate-400'>{n(i.requests)} requests</p>
      </td>
      <td className='py-2 pr-3 tabular-nums'>
        <span
          data-slo-availability={i.meets.availability === false ? 'miss' : 'ok'}
          className={cn(
            'text-[13px] font-semibold',
            i.meets.availability === false
              ? 'text-red-700 dark:text-red-300'
              : 'text-slate-800 dark:text-slate-100'
          )}
        >
          {i.availability_pct == null ? '—' : `${i.availability_pct}%`}
        </span>
        <span className='ml-1 text-[10.5px] text-slate-500'>≥ {t.availability_pct}%</span>
      </td>
      <td className='py-2 pr-3 tabular-nums'>
        <span
          className={cn(
            'text-[13px] font-semibold',
            i.meets.p95 === false
              ? 'text-red-700 dark:text-red-300'
              : 'text-slate-800 dark:text-slate-100'
          )}
        >
          {i.p95_ms == null ? '—' : `${n(i.p95_ms)} ms`}
        </span>
        <span className='ml-1 text-[10.5px] text-slate-500'>≤ {n(t.p95_ms)}</span>
      </td>
      <td className='w-44 py-2 pr-3'>
        <div className='h-1.5 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700'>
          <div
            className={cn(
              'h-full rounded-full',
              remaining == null || remaining > 50
                ? 'bg-emerald-500'
                : remaining > 0
                  ? 'bg-amber-500'
                  : 'bg-red-500'
            )}
            style={{ width: `${Math.max(0, Math.min(100, remaining ?? 100))}%` }}
          />
        </div>
        <p className='mt-0.5 text-[10.5px] text-slate-500 dark:text-slate-400' data-slo-budget>
          {remaining == null ? '—' : `${Math.max(remaining, -999)}% budget left`} ·{' '}
          {n(i.budget.consumed)} of {n(i.budget.allowed)} errors
        </p>
      </td>
      <td className='py-2 pr-3 text-[11px] tabular-nums' data-slo-burn>
        <span className={burnTone(i.burn.h1, true)}>1h {i.burn.h1 ?? '—'}×</span>
        <span className='mx-1 text-slate-300'>·</span>
        <span className={burnTone(i.burn.h6, false)}>6h {i.burn.h6 ?? '—'}×</span>
        <span className='mx-1 text-slate-300'>·</span>
        <span className='text-slate-500'>24h {i.burn.h24 ?? '—'}×</span>
      </td>
      <td className='py-2'>
        <DayBars days={i.days} target={t.availability_pct} />
      </td>
    </tr>
  )
}

function TargetsEditor({ t }: { t: SloTargets }) {
  const qc = useQueryClient()
  const [draft, setDraft] = useState({
    availability_pct: String(t.availability_pct),
    p95_ms: String(t.p95_ms),
    window_days: String(t.window_days)
  })
  const save = useMutation({
    mutationFn: () =>
      api.patch('/settings', {
        slo_targets: {
          availability_pct: Number(draft.availability_pct),
          p95_ms: Number(draft.p95_ms),
          window_days: Number(draft.window_days)
        }
      }),
    onSuccess: () => {
      toast.success('SLO targets saved')
      void qc.invalidateQueries({ queryKey: ['slo'] })
    },
    onError: (e: unknown) =>
      toast.error(
        (e as { response?: { data?: { error?: string } } })?.response?.data?.error ??
          'Could not save'
      )
  })
  const field = (k: keyof typeof draft, label: string) => (
    <label className='flex items-center gap-1 text-[11px] text-slate-500'>
      {label}
      <input
        data-slo-target={k}
        value={draft[k]}
        onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}
        className='h-6 w-16 rounded border border-slate-300 bg-white px-1 text-[11px] tabular-nums text-slate-800 dark:border-border dark:bg-background dark:text-foreground'
      />
    </label>
  )
  return (
    <div className='flex flex-wrap items-center gap-3'>
      {field('availability_pct', 'Availability %')}
      {field('p95_ms', 'p95 ms')}
      {field('window_days', 'Window days')}
      <button
        type='button'
        onClick={() => save.mutate()}
        disabled={save.isPending}
        className='rounded bg-nvr-cyan px-2 py-0.5 text-[11px] font-medium text-white disabled:opacity-50'
      >
        Save targets
      </button>
    </div>
  )
}

export function SloPanel() {
  const [editing, setEditing] = useState(false)
  const local = useQuery<SloReport | null>({
    queryKey: ['slo', 'local'],
    queryFn: () => api.get<{ data: SloReport }>('/health/slo').then((r) => r.data.data),
    refetchInterval: 120_000
  })
  const remote = useQuery<RemoteSlo[]>({
    queryKey: ['slo', 'environments'],
    queryFn: () =>
      api
        .get<{ data: RemoteSlo[] }>('/environments/slo')
        .then((r) => r.data.data)
        .catch(() => []),
    refetchInterval: 300_000
  })
  const r = local.data
  const t = r?.targets
  return (
    <section
      data-slo-panel
      className='mt-6 rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'
    >
      <div className='flex flex-wrap items-baseline gap-x-3 gap-y-1'>
        <h2 className='flex items-center gap-1.5 text-[13px] font-semibold text-slate-800 dark:text-slate-100'>
          <Gauge className='h-4 w-4 text-slate-400' /> Service levels
        </h2>
        {t && (
          <p className='text-[12px] text-slate-600 dark:text-slate-300'>
            {t.availability_pct}% of requests without a server error and p95 under {n(t.p95_ms)} ms,
            over {t.window_days} days
          </p>
        )}
        <button
          type='button'
          onClick={() => setEditing((v) => !v)}
          className='ml-auto text-[11px] text-slate-500 hover:text-slate-800 dark:text-slate-400'
        >
          {editing ? 'Close' : 'Edit targets'}
        </button>
      </div>
      {editing && t && (
        <div className='mt-2'>
          <TargetsEditor t={t} />
        </div>
      )}
      {!r ? (
        <div className='mt-3 h-16 animate-pulse rounded bg-muted' />
      ) : (
        <div className='mt-3 overflow-x-auto'>
          <table className='w-full text-left'>
            <thead>
              <tr className='text-[10px] uppercase tracking-wide text-slate-400'>
                <th className='pb-1 font-medium'>Instance</th>
                <th className='pb-1 font-medium'>Availability</th>
                <th className='pb-1 font-medium'>p95</th>
                <th className='pb-1 font-medium'>Error budget</th>
                <th className='pb-1 font-medium'>Burn rate</th>
                <th className='pb-1 font-medium'>Days</th>
              </tr>
            </thead>
            <tbody>
              {r.instances.map((i) => (
                <InstanceRow
                  key={`l-${i.instance}`}
                  label={`${i.instance} · this database`}
                  i={i}
                  t={r.targets}
                />
              ))}
              {(remote.data ?? []).flatMap((c) =>
                c.state === 'ok' && c.slo
                  ? c.slo.instances.map((i) => (
                      <InstanceRow
                        key={`r-${c.id}-${i.instance}`}
                        label={`${c.environment ?? c.name} · ${i.instance}`}
                        i={i}
                        t={c.slo!.targets}
                      />
                    ))
                  : []
              )}
            </tbody>
          </table>
          {(remote.data ?? []).some((c) => c.state !== 'ok') && (
            <p className='mt-2 text-[11px] text-slate-500 dark:text-slate-400'>
              {(remote.data ?? [])
                .filter((c) => c.state !== 'ok')
                .map(
                  (c) =>
                    `${c.environment ?? c.name}: ${
                      c.state === 'no-token'
                        ? 'no API token on the component'
                        : c.state === 'not-supported'
                          ? 'runs a version without SLOs'
                          : `unreachable${c.note ? ` (${c.note})` : ''}`
                    }`
                )
                .join(' · ')}
            </p>
          )}
          {r.monitors.length > 0 && (
            <div className='mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-slate-100 pt-2 text-[11px] dark:border-border/50'>
              <span className='text-slate-500'>Monitor uptime:</span>
              {r.monitors.map((m) => (
                <span
                  key={m.monitor}
                  data-slo-monitor={m.monitor}
                  className={cn(
                    'tabular-nums',
                    (m.uptime_pct ?? 100) < r.targets.availability_pct
                      ? 'text-red-700 dark:text-red-300'
                      : 'text-slate-600 dark:text-slate-300'
                  )}
                >
                  {m.monitor.split(':').slice(1).join(':') || m.monitor} {m.uptime_pct ?? '—'}%
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
