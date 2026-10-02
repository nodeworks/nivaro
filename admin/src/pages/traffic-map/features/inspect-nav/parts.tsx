/** Small building blocks the "nav" panels share (skeleton, section, fact cell). */
import type { ReactNode } from 'react'

export function PanelSkeleton({ rows = [86, 64, 72, 50] }: { rows?: number[] }) {
  return (
    <div className='grid gap-2' aria-hidden='true' data-tm-inspect-skeleton=''>
      {rows.map((w, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows
          key={i}
          className='h-3.5 animate-pulse rounded bg-[var(--tm-skeleton)] motion-reduce:animate-none'
          style={{ width: `${w}%` }}
        />
      ))}
    </div>
  )
}

export function Section({
  title,
  hook,
  children
}: {
  title: string
  hook: string
  children: ReactNode
}) {
  return (
    <section className='grid gap-1.5' data-tm-inspect-section={hook}>
      <h3 className='text-[12px] font-semibold text-[var(--tm-fg-2)]'>{title}</h3>
      {children}
    </section>
  )
}

export function Fact({
  label,
  value,
  hook,
  tone
}: {
  label: string
  value: ReactNode
  hook: string
  tone?: 'error'
}) {
  return (
    <div className='min-w-0 bg-[var(--tm-card)] px-2.5 py-1.5' data-tm-inspect-fact={hook}>
      <dt className='text-[11px] text-[var(--tm-muted)]'>{label}</dt>
      <dd
        className={`truncate text-[13px] font-semibold tabular-nums ${tone === 'error' ? 'text-[var(--tm-error-ink)]' : 'text-[var(--tm-fg)]'}`}
      >
        {value}
      </dd>
    </div>
  )
}
