import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** Small status pill: tone carries meaning with text, never colour alone. */
export function Pill({
  tone,
  children
}: {
  tone: 'ok' | 'warn' | 'bad' | 'muted'
  children: ReactNode
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium',
        tone === 'ok' &&
          'bg-emerald-50 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300',
        tone === 'warn' && 'bg-amber-50 text-amber-900 dark:bg-amber-500/15 dark:text-amber-200',
        tone === 'bad' && 'bg-red-50 text-red-800 dark:bg-red-500/15 dark:text-red-300',
        tone === 'muted' && 'bg-slate-100 text-slate-600 dark:bg-muted dark:text-muted-foreground'
      )}
    >
      {children}
    </span>
  )
}

/** A tiny line chart with no axes, for table cells. */
export function Sparkline({
  values,
  label,
  max
}: {
  values: number[]
  label: string
  max?: number
}) {
  if (values.length < 2) return <span className='text-slate-400'>—</span>
  const w = 96
  const h = 22
  const hi = max ?? Math.max(...values, Number.EPSILON)
  const lo = max != null ? 0 : Math.min(...values)
  const span = hi - lo || 1
  const pts = values
    .map(
      (v, i) =>
        `${((i / (values.length - 1)) * w).toFixed(1)},${(h - 1 - ((v - lo) / span) * (h - 2)).toFixed(1)}`
    )
    .join(' ')
  return (
    <svg
      width={w}
      height={h}
      role='img'
      aria-label={label}
      className='block text-nvr-navy dark:text-nvr-cyan'
    >
      <polyline points={pts} fill='none' stroke='currentColor' strokeWidth='1.25' />
    </svg>
  )
}

export function NotConfigured({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className='rounded-lg border border-slate-200 bg-white p-6 text-[13px] dark:border-border dark:bg-card'>
      <p className='font-medium text-slate-900 dark:text-foreground'>{title}</p>
      <div className='mt-1 max-w-prose text-slate-600 dark:text-muted-foreground'>{children}</div>
    </div>
  )
}

export function Code({ children }: { children: ReactNode }) {
  return (
    <code className='rounded bg-slate-100 px-1 py-0.5 text-[12px] dark:bg-muted'>{children}</code>
  )
}

export const TH =
  'px-3 py-2 text-left text-[12px] font-medium text-slate-500 dark:text-muted-foreground'
export const TD = 'px-3 py-2 align-top text-[12px]'
export const TABLE_WRAP =
  'overflow-x-auto rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'

export const fmtRate = (v: number | null): string =>
  v == null ? '—' : v >= 10 ? v.toFixed(0) : v >= 0.01 ? v.toFixed(2) : v > 0 ? '<0.01' : '0'
