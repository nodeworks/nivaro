/**
 * Small building blocks the request group's panels share: sections, a facts grid, notes, code
 * blocks, copy buttons, status pills and a panel skeleton. Page tokens only (tm-*).
 */
import { Check, Copy } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { BTN } from '../shared'

export function Section({
  title,
  aside,
  children,
  hook
}: {
  title: ReactNode
  aside?: ReactNode
  children: ReactNode
  hook?: string
}) {
  return (
    <section className='grid gap-1.5' data-tm-inspect-section={hook}>
      <div className='flex items-center gap-2'>
        <h3 className='text-[12px] font-semibold text-[var(--tm-fg)]'>{title}</h3>
        {aside && <div className='ml-auto flex items-center gap-1.5'>{aside}</div>}
      </div>
      {children}
    </section>
  )
}

export function Facts({
  items
}: {
  items: Array<[string, ReactNode] | null | false | undefined | '' | 0>
}) {
  const rows = items.filter((x): x is [string, ReactNode] => !!x)
  return (
    <dl className='grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-[12px]'>
      {rows.map(([k, v]) => (
        <div key={k} className='contents'>
          <dt className='text-[var(--tm-muted)]'>{k}</dt>
          <dd className='min-w-0 truncate text-[var(--tm-fg)]'>{v}</dd>
        </div>
      ))}
    </dl>
  )
}

/** A plain-language note: why something is missing, what to do about it. */
export function Note({
  children,
  tone = 'muted',
  hook
}: {
  children: ReactNode
  tone?: 'muted' | 'warn' | 'error'
  hook?: string
}) {
  return (
    <p
      className={cn(
        'rounded-md border px-2 py-1.5 text-[12px] leading-snug',
        tone === 'muted' && 'border-[var(--tm-line-2)] bg-[var(--tm-card-2)] text-[var(--tm-fg-2)]',
        tone === 'warn' &&
          'border-[color-mix(in_srgb,var(--tm-update)_45%,var(--tm-line))] bg-[color-mix(in_srgb,var(--tm-update)_10%,var(--tm-card))] text-[var(--tm-fg)]',
        tone === 'error' &&
          'border-[var(--tm-error)] bg-[var(--tm-error-soft)] text-[var(--tm-error-ink)]'
      )}
      data-tm-inspect-note={hook}
    >
      {children}
    </p>
  )
}

export function Code({
  text,
  hook,
  max = 'max-h-64'
}: {
  text: string
  hook?: string
  max?: string
}) {
  return (
    <pre
      className={cn(
        'overflow-auto whitespace-pre-wrap break-words rounded-md border border-[var(--tm-line-2)] bg-[var(--tm-card-2)] px-2 py-1.5 font-mono text-[11px] leading-relaxed text-[var(--tm-fg)]',
        max
      )}
      data-tm-inspect-code={hook}
    >
      {text}
    </pre>
  )
}

export function CopyButton({
  text,
  label = 'Copy',
  hook
}: {
  text: string
  label?: string
  hook?: string
}) {
  const [done, setDone] = useState(false)
  return (
    <button
      type='button'
      className={BTN}
      data-tm-inspect-copy={hook}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setDone(true)
          setTimeout(() => setDone(false), 1500)
        } catch {
          toast.error('The browser would not let the page write to the clipboard')
        }
      }}
    >
      {done ? (
        <Check className='h-3 w-3' aria-hidden='true' />
      ) : (
        <Copy className='h-3 w-3' aria-hidden='true' />
      )}
      {done ? 'Copied' : label}
    </button>
  )
}

export function StatusPill({ status }: { status: number | null | undefined }) {
  const s = status ?? 0
  const bad = s >= 400
  return (
    <span
      className={cn(
        'inline-flex items-center rounded px-1.5 py-[1px] font-mono text-[11px] font-medium tabular-nums',
        bad
          ? 'bg-[var(--tm-error-soft)] text-[var(--tm-error-ink)]'
          : 'bg-[var(--tm-card-2)] text-[var(--tm-fg-2)]'
      )}
      data-tm-inspect-status={s}
    >
      {s || '—'}
    </span>
  )
}

export function Tag({
  children,
  tip,
  warn
}: {
  children: ReactNode
  tip?: string
  warn?: boolean
}) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded px-1 py-[1px] text-[10.5px] font-medium',
        warn
          ? 'bg-[color-mix(in_srgb,var(--tm-update)_16%,var(--tm-card))] text-[var(--tm-fg)]'
          : 'bg-[var(--tm-card-2)] text-[var(--tm-fg-2)]'
      )}
      data-tip={tip}
    >
      {children}
    </span>
  )
}

export function PanelSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className='grid gap-2' data-tm-inspect-loading=''>
      {Array.from({ length: rows }, (_, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows
          key={i}
          className='h-3.5 animate-pulse rounded bg-[var(--tm-skeleton)]'
          style={{ width: `${90 - ((i * 17) % 45)}%` }}
        />
      ))}
    </div>
  )
}
