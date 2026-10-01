import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** Lens toggle chip (the Conflicts lens's look). */
export const CHIP =
  'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-[3px] text-[12px] font-medium leading-tight transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--tm-card)]'

export function LensChip({
  id,
  on,
  onToggle,
  color,
  label,
  count,
  title
}: {
  id: string
  on: boolean
  onToggle: () => void
  color: string
  label: string
  count?: number
  title: string
}) {
  return (
    <button
      type='button'
      id={id}
      aria-pressed={on}
      onClick={onToggle}
      title={title}
      className={cn(
        CHIP,
        on
          ? 'border-[color-mix(in_srgb,var(--tm-update)_55%,var(--tm-line))] bg-[color-mix(in_srgb,var(--tm-update)_12%,var(--tm-card))] text-[var(--tm-fg)]'
          : 'border-[var(--tm-line)] bg-[var(--tm-card)] text-[var(--tm-fg-2)] hover:bg-[var(--tm-card-2)]'
      )}
    >
      <span
        className='h-2 w-2 rounded-sm'
        style={{ background: color, opacity: on ? 1 : 0.35 }}
        aria-hidden='true'
      />
      {label}
      {count && count > 0 ? (
        <span className='tabular-nums text-[var(--tm-fg-2)]' data-tm-lens-count={count}>
          {count.toLocaleString()}
        </span>
      ) : null}
    </button>
  )
}

/** Label / figure grid (three across), a figure marked `bad` reads in the error ink. */
export function Figures({ items }: { items: Array<[string, ReactNode, boolean?]> }) {
  return (
    <dl className='grid grid-cols-3 gap-x-3 gap-y-2'>
      {items.map(([k, v, bad]) => (
        <div key={k} className='min-w-0'>
          <dt className='truncate text-[11.5px] text-[var(--tm-muted)]'>{k}</dt>
          <dd
            className={cn(
              'text-[13.5px] font-semibold tabular-nums',
              bad && 'text-[var(--tm-error-ink)]'
            )}
          >
            {v}
          </dd>
        </div>
      ))}
    </dl>
  )
}

/** One statement, monospace, clipped to two lines with the full text on hover. */
export function Sql({ text }: { text: string | null }) {
  if (!text) return null
  return (
    <code
      className='line-clamp-2 block break-all font-mono text-[10.5px] leading-snug text-[var(--tm-fg-2)]'
      title={text}
    >
      {text}
    </code>
  )
}

/** A thin used-of-budget bar: amber from 80%, red past 100%. */
export function BudgetBar({ pct }: { pct: number }) {
  const w = Math.max(2, Math.min(100, pct))
  const color = pct >= 100 ? 'var(--tm-error)' : 'var(--tm-update)'
  return (
    <span
      className='block h-1 w-full overflow-hidden rounded-full bg-[var(--tm-line-2)]'
      role='img'
      aria-label={`${pct}% of the budget`}
    >
      <span className='block h-full rounded-full' style={{ width: `${w}%`, background: color }} />
    </span>
  )
}
