import type { ReactNode } from 'react'
import { Chip, TD as KIT_TD, TH as KIT_TH, NotConnected, PANEL } from './ui'

export { Code } from './ui'

/** Small status pill: tone carries meaning with text, never colour alone. */
export function Pill({
  tone,
  children
}: {
  tone: 'ok' | 'warn' | 'bad' | 'muted'
  children: ReactNode
}) {
  return <Chip tone={tone}>{children}</Chip>
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

export const NotConfigured = NotConnected

export const TH = KIT_TH
export const TD = KIT_TD
export const TABLE_WRAP = PANEL

export const fmtRate = (v: number | null): string =>
  v == null ? '—' : v >= 10 ? v.toFixed(0) : v >= 0.01 ? v.toFixed(2) : v > 0 ? '<0.01' : '0'
