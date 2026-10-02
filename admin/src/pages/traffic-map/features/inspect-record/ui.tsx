/** Small pieces the record group's panels share: a facts grid, a note, loading and failure. */
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { inspectErrorOf } from '../../inspect/api'

export function Skeleton({ rows = [86, 64, 72, 50] }: { rows?: number[] }) {
  return (
    <div className='grid gap-2' aria-hidden='true' data-tm-inspect-loading=''>
      {rows.map((w, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder bars, never reordered
          key={i}
          className='h-3.5 animate-pulse rounded bg-[var(--tm-skeleton)] motion-reduce:animate-none'
          style={{ width: `${w}%` }}
        />
      ))}
    </div>
  )
}

/** A plain-language reason something is missing. */
export function Note({ children, hook }: { children: ReactNode; hook?: string }) {
  return (
    <p
      className='text-[12px] leading-snug text-[var(--tm-muted)]'
      data-tm-inspect-note={hook ?? ''}
    >
      {children}
    </p>
  )
}

/** Why a panel could not load, in words: not found, invalid id, or the server's reason. */
export function LoadFailed({ error, what }: { error: unknown; what: string }) {
  const e = inspectErrorOf(error)
  const text =
    e.status === 404
      ? `There is no ${what} to show — it is gone, or it never existed.`
      : e.status === 400
        ? `That is not a valid ${what} id.`
        : `Could not load this ${what}: ${e.message}`
  return (
    <p className='text-[12.5px] text-[var(--tm-error-ink)]' data-tm-inspect-error={e.code ?? ''}>
      {text}
    </p>
  )
}

export function Facts({ rows }: { rows: Array<[string, ReactNode] | null | false> }) {
  const shown = rows.filter((r): r is [string, ReactNode] => !!r)
  return (
    <dl className='grid grid-cols-[minmax(84px,auto)_minmax(0,1fr)] gap-x-3 gap-y-1 text-[12px]'>
      {shown.map(([k, v]) => (
        <div key={k} className='contents'>
          <dt className='text-[var(--tm-muted)]'>{k}</dt>
          <dd className='min-w-0 text-[var(--tm-fg)] [overflow-wrap:anywhere]'>{v ?? '—'}</dd>
        </div>
      ))}
    </dl>
  )
}

export function Block({
  title,
  children,
  className,
  hook
}: {
  title: string
  children: ReactNode
  className?: string
  hook?: string
}) {
  return (
    <section className={cn('grid min-w-0 gap-1.5', className)} data-tm-inspect-block={hook ?? ''}>
      <h3 className='text-[12px] font-medium text-[var(--tm-muted)]'>{title}</h3>
      {children}
    </section>
  )
}

export function Mono({ children, max = 'max-h-64' }: { children: ReactNode; max?: string }) {
  return (
    <pre
      className={cn(
        'min-w-0 overflow-auto whitespace-pre-wrap rounded-md border border-[var(--tm-line)] bg-[var(--tm-card-2)] px-2.5 py-2 font-mono text-[11px] leading-relaxed text-[var(--tm-fg)] [overflow-wrap:anywhere]',
        max
      )}
    >
      {children}
    </pre>
  )
}
