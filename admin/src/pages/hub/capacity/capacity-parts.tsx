import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { hubToast } from '../hub-api'
import { Field, ghostButton, smallButton } from '../hub-parts'
import {
  type AppLimits,
  capacityKeys,
  LIMIT_FIELDS,
  saveLimits,
  type TrendPoint
} from './capacity-api'

/** A small line of one figure over the trend (no axes; the newest value is the last point). */
export function Sparkline({
  points,
  pick,
  label
}: {
  points: TrendPoint[]
  pick: (p: TrendPoint) => number | null
  label: string
}) {
  const values = points.map(pick)
  const real = values.filter((v): v is number => typeof v === 'number')
  if (real.length < 2)
    return (
      <span className='text-[11px] text-slate-400 dark:text-muted-foreground'>
        Not enough samples yet
      </span>
    )
  const W = 120
  const H = 28
  const max = Math.max(...real, 1)
  const step = W / Math.max(1, values.length - 1)
  const d = values
    .map((v, i) =>
      v === null ? null : `${(i * step).toFixed(1)},${(H - (v / max) * (H - 2) - 1).toFixed(1)}`
    )
    .filter(Boolean)
    .join(' ')
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width={W}
      height={H}
      role='img'
      aria-label={`${label}: ${real.length} days, highest ${Math.round(max)}`}
      className='shrink-0 text-nvr-cyan'
    >
      <polyline points={d} fill='none' stroke='currentColor' strokeWidth='1.5' />
    </svg>
  )
}

/** A share of the deployment as a thin bar with its percentage. */
export function ShareBar({ value, strong }: { value: number | null; strong?: boolean }) {
  const w = value === null ? 0 : Math.max(2, Math.min(100, Math.round(value * 100)))
  return (
    <span className='inline-flex items-center gap-1.5'>
      <span className='relative h-1.5 w-16 overflow-hidden rounded-full bg-slate-200 dark:bg-muted'>
        <span
          className={cn(
            'absolute inset-y-0 left-0 rounded-full',
            strong ? 'bg-amber-500' : 'bg-nvr-cyan'
          )}
          style={{ width: `${w}%` }}
        />
      </span>
      <span className='tabular-nums text-[11px] text-slate-600 dark:text-slate-300'>
        {value === null ? '—' : `${Math.round(value * 100)}%`}
      </span>
    </span>
  )
}

/** The limits as one line ("600/min · 2 jobs · 1,024 MB" or "No limits"). */
export function limitsText(l: AppLimits): string {
  const parts = LIMIT_FIELDS.filter((f) => l[f.key] != null).map(
    (f) =>
      `${(l[f.key] as number).toLocaleString('en-US')}${f.unit === '/min' ? '/min' : ` ${f.unit}`}`
  )
  return parts.length ? parts.join(' · ') : 'No limits'
}

/** Inline editor of one app's limits on a shared deployment (empty = no limit). */
export function LimitsEditor({
  envId,
  label,
  limits,
  onDone
}: {
  envId: number
  label: string
  limits: AppLimits
  onDone: () => void
}) {
  const qc = useQueryClient()
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      LIMIT_FIELDS.map((f) => [f.key, limits[f.key] != null ? String(limits[f.key]) : ''])
    )
  )
  const errors = Object.fromEntries(
    LIMIT_FIELDS.map((f) => {
      const raw = values[f.key].trim()
      if (!raw) return [f.key, null]
      const n = Number(raw)
      return [
        f.key,
        Number.isInteger(n) && n >= f.min && n <= f.max
          ? null
          : `A whole number from ${f.min.toLocaleString('en-US')} to ${f.max.toLocaleString('en-US')}, or empty`
      ]
    })
  )
  const bad = Object.values(errors).some(Boolean)
  const save = useMutation({
    mutationFn: () =>
      saveLimits(
        envId,
        Object.fromEntries(
          LIMIT_FIELDS.map((f) => [f.key, values[f.key].trim() ? Number(values[f.key]) : null])
        ) as Record<keyof AppLimits, number | null>
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: capacityKeys.overview() })
      onDone()
    },
    onError: (err) => hubToast(err, `Could not save the limits of ${label}`)
  })
  return (
    <form
      aria-label={`Limits of ${label}`}
      className='space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-border dark:bg-muted/40'
      onSubmit={(e) => {
        e.preventDefault()
        if (!bad) save.mutate()
      }}
    >
      <p className='m-0 text-[12px] text-slate-600 dark:text-muted-foreground'>
        Limits of <span className='font-mono'>{label}</span> on its shared deployment. Empty = no
        limit. The deployment applies them within a minute.
      </p>
      <div className='grid gap-3 sm:grid-cols-3'>
        {LIMIT_FIELDS.map((f) => (
          <Field
            key={f.key}
            id={`lim-${envId}-${f.key}`}
            label={`${f.label} (${f.unit})`}
            hint={f.hint}
            error={errors[f.key]}
          >
            <Input
              id={`lim-${envId}-${f.key}`}
              inputMode='numeric'
              value={values[f.key]}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              placeholder='No limit'
              className='h-8 text-[13px] tabular-nums'
            />
          </Field>
        ))}
      </div>
      <div className='flex flex-wrap justify-end gap-2'>
        <button type='button' className={ghostButton} onClick={onDone} disabled={save.isPending}>
          Cancel
        </button>
        <button
          type='submit'
          className={cn(smallButton, 'bg-nvr-cyan text-white hover:opacity-90 disabled:opacity-50')}
          disabled={bad || save.isPending}
        >
          {save.isPending ? 'Saving…' : 'Save limits'}
        </button>
      </div>
    </form>
  )
}
