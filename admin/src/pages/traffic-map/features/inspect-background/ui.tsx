/**
 * Small building blocks the background panels share: sections, a fact grid, a status pill, a
 * collapsible body viewer, gap notes, the loading skeleton and the error state.
 */
import { ChevronRight } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { cn } from '@/lib/utils'
import { inspectErrorOf } from '../../inspect/api'
import { notFoundWhy, prettyJson, statusTone, type Tone } from './logic'

const TONE_CLS: Record<Tone, string> = {
  ok: 'border-[color-mix(in_srgb,var(--tm-create)_40%,var(--tm-line))] text-[var(--tm-create)]',
  bad: 'border-[color-mix(in_srgb,var(--tm-error)_45%,var(--tm-line))] bg-[var(--tm-error-soft)] text-[var(--tm-error-ink)]',
  warn: 'border-[color-mix(in_srgb,var(--tm-update)_45%,var(--tm-line))] text-[var(--tm-update)]',
  neutral: 'border-[var(--tm-line)] text-[var(--tm-fg-2)]'
}

export function StatusPill({ status, hook }: { status: string | null; hook?: string }) {
  const tone = statusTone(status)
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md border px-1.5 py-px text-[11.5px] font-medium',
        TONE_CLS[tone]
      )}
      data-tm-inspect-status={status ?? ''}
      data-tm-inspect-hook={hook}
    >
      {status ?? 'unknown'}
    </span>
  )
}

export function Section({
  title,
  children,
  hook,
  aside
}: {
  title: string
  children: ReactNode
  hook?: string
  aside?: ReactNode
}) {
  return (
    <section className='grid min-w-0 gap-1.5' data-tm-inspect-section={hook ?? title}>
      <div className='flex items-baseline justify-between gap-2'>
        <h3 className='text-[12.5px] font-semibold text-[var(--tm-fg)]'>{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  )
}

/** Label / value pairs, two across. Values may be links or pills. */
export function Facts({ items }: { items: Array<[string, ReactNode] | null | false> }) {
  const list = items.filter((x): x is [string, ReactNode] => !!x)
  return (
    <dl className='grid grid-cols-2 gap-x-3 gap-y-1.5'>
      {list.map(([k, v]) => (
        <div key={k} className='min-w-0'>
          <dt className='truncate text-[11.5px] text-[var(--tm-muted)]'>{k}</dt>
          <dd className='min-w-0 truncate text-[12.5px] text-[var(--tm-fg)]'>{v ?? '—'}</dd>
        </div>
      ))}
    </dl>
  )
}

/** A muted sentence that says why something is missing or partial. */
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

/** An error / failure text block in the error ink. */
export function ErrorText({ text, hook }: { text: string; hook?: string }) {
  return (
    <pre
      className='max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border border-[color-mix(in_srgb,var(--tm-error)_35%,var(--tm-line))] bg-[var(--tm-error-soft)] p-2 font-mono text-[11px] leading-snug text-[var(--tm-error-ink)]'
      data-tm-inspect-error-text={hook ?? ''}
    >
      {text}
    </pre>
  )
}

/** A body (JSON or text) behind a disclosure; open shows it monospace, scrollable. */
export function BodyBlock({
  label,
  value,
  hook,
  defaultOpen = false,
  empty = 'Nothing stored.'
}: {
  label: string
  value: unknown
  hook: string
  defaultOpen?: boolean
  empty?: string
}) {
  const [open, setOpen] = useState(defaultOpen)
  const text = prettyJson(value)
  return (
    <div className='min-w-0' data-tm-inspect-body={hook}>
      <button
        type='button'
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className='inline-flex items-center gap-1 rounded-sm text-[12px] font-medium text-[var(--tm-fg-2)] hover:text-[var(--tm-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
        data-tm-inspect-body-toggle={hook}
      >
        <ChevronRight
          className={cn('h-3.5 w-3.5 transition-transform duration-150', open && 'rotate-90')}
          aria-hidden='true'
        />
        {label}
        {text ? (
          <span className='font-normal text-[var(--tm-muted)]'>
            · {text.length.toLocaleString()} chars
          </span>
        ) : null}
      </button>
      {open ? (
        text ? (
          <pre className='mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-[var(--tm-line)] bg-[var(--tm-card-2)] p-2 font-mono text-[11px] leading-snug text-[var(--tm-fg-2)]'>
            {text}
          </pre>
        ) : (
          <p className='mt-1 text-[12px] text-[var(--tm-muted)]'>{empty}</p>
        )
      ) : null}
    </div>
  )
}

export function PanelSkeleton({ hook }: { hook: string }) {
  return (
    <div className='grid gap-2' aria-busy='true' data-tm-inspect-loading={hook}>
      {[72, 90, 58, 84, 40].map((w) => (
        <div
          key={w}
          className='h-3.5 animate-pulse rounded bg-[var(--tm-skeleton)] motion-reduce:animate-none'
          style={{ width: `${w}%` }}
        />
      ))}
    </div>
  )
}

/** The failed read, in words: a 404 says why the thing is gone; anything else, what broke. */
export function PanelError({ kind, id, error }: { kind: string; id: string; error: unknown }) {
  const e = inspectErrorOf(error)
  const text =
    e.status === 404 && e.code === 'INSPECT_NOT_FOUND'
      ? notFoundWhy(kind, id)
      : e.status === 400
        ? `That is not a valid ${kind} id.`
        : `Could not load this ${kind}: ${e.message}`
  return (
    <p
      className='text-[12.5px] text-[var(--tm-fg-2)]'
      role='alert'
      data-tm-inspect-error={`${kind}:${e.status ?? 'x'}`}
    >
      {text}
    </p>
  )
}

/** A small list row: label left, quiet detail right. */
export function Row({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <li className='flex min-w-0 items-baseline justify-between gap-2 text-[12.5px]'>
      <span className='min-w-0 truncate'>{children}</span>
      {aside ? (
        <span className='shrink-0 text-[11.5px] tabular-nums text-[var(--tm-muted)]'>{aside}</span>
      ) : null}
    </li>
  )
}

export const LIST = 'grid gap-1'

export const ACTION_BTN =
  'inline-flex h-7 items-center gap-1.5 rounded-md border border-[var(--tm-line)] bg-[var(--tm-card)] px-2.5 text-[12px] font-medium text-[var(--tm-fg)] transition-colors duration-150 ease-out hover:bg-[var(--tm-card-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan disabled:cursor-not-allowed disabled:opacity-50'
