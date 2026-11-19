/**
 * Request story — small shared pieces: status pill, section frame, fact list, leaf rows (one
 * keyboard model for every list: ↑/↓ move between rows of the same list, Enter opens).
 */
import { Check, Copy } from 'lucide-react'
import { type KeyboardEvent, type ReactNode, useState } from 'react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { statusText, statusTone, type Tone } from './logic'

export const TONE_TEXT: Record<Tone, string> = {
  ok: 'text-emerald-700 dark:text-emerald-400',
  info: 'text-sky-700 dark:text-sky-400',
  warn: 'text-amber-700 dark:text-amber-400',
  bad: 'text-red-700 dark:text-red-400',
  muted: 'text-slate-500 dark:text-muted-foreground'
}

const TONE_PILL: Record<Tone, string> = {
  ok: 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300',
  info: 'border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-300',
  warn: 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300',
  bad: 'border-red-200 bg-red-50 text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300',
  muted:
    'border-slate-200 bg-slate-50 text-slate-600 dark:border-border dark:bg-muted/40 dark:text-muted-foreground'
}

export function TonePill({
  tone,
  children,
  className
}: {
  tone: Tone
  children: ReactNode
  className?: string
}) {
  return (
    <span
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-1 rounded border px-1.5 text-[11px] font-semibold tabular-nums',
        TONE_PILL[tone],
        className
      )}
    >
      {children}
    </span>
  )
}

/** "409 Conflict" — the code always, the words when there is room. */
export function StatusPill({
  status,
  words = true,
  className
}: {
  status: number | null | undefined
  words?: boolean
  className?: string
}) {
  return (
    <TonePill tone={statusTone(status)} className={className}>
      {status || '—'}
      {words && <span className='font-medium'>{statusText(status)}</span>}
    </TonePill>
  )
}

export function MethodTag({ method }: { method: string }) {
  return (
    <span className='inline-flex h-5 shrink-0 items-center rounded bg-slate-100 px-1.5 font-mono text-[10.5px] font-semibold tracking-wide text-slate-700 dark:bg-muted dark:text-slate-300'>
      {method.toUpperCase()}
    </span>
  )
}

/** One section of the story: a heading with its count, an optional aside, the body. */
export function Section({
  id,
  title,
  count,
  aside,
  children,
  className
}: {
  id: string
  title: string
  count?: ReactNode
  aside?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section
      aria-labelledby={`rs-${id}`}
      className={cn('scroll-mt-4', className)}
      id={`rs-section-${id}`}
    >
      <div className='mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1'>
        <h2
          id={`rs-${id}`}
          className='m-0 text-[13.5px] font-semibold text-slate-900 dark:text-foreground'
        >
          {title}
          {count != null && (
            <span className='ml-1.5 font-normal tabular-nums text-slate-500 dark:text-muted-foreground'>
              {count}
            </span>
          )}
        </h2>
        {aside && (
          <div className='ml-auto flex flex-wrap items-center gap-2 text-[12px]'>{aside}</div>
        )}
      </div>
      {children}
    </section>
  )
}

/** A bordered surface the rows sit on. */
export function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card',
        className
      )}
    >
      {children}
    </div>
  )
}

/** One fact; falsy entries (a `cond && [k, v]`) are left out. */
export type FactRow = [string, ReactNode] | null | false | undefined | '' | 0

/** Key/value facts of a leaf. */
export function Facts({ rows }: { rows: FactRow[] }) {
  const shown = rows.filter((r): r is [string, ReactNode] => !!r && r[1] != null && r[1] !== '')
  if (shown.length === 0) return null
  return (
    <dl className='m-0 grid grid-cols-[minmax(96px,34%)_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[12.5px]'>
      {shown.map(([k, v]) => (
        <div key={k} className='contents'>
          <dt className='text-slate-500 dark:text-muted-foreground'>{k}</dt>
          <dd className='m-0 min-w-0 break-words text-slate-900 dark:text-foreground'>{v}</dd>
        </div>
      ))}
    </dl>
  )
}

/** ↑/↓ move between rows of the same list (rows carry data-rs-row="<list>"); Home/End jump. */
export function rowKeys(e: KeyboardEvent<HTMLElement>) {
  const el = e.currentTarget
  const list = el.dataset.rsRow
  if (!list) return
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
  const all = Array.from(document.querySelectorAll<HTMLElement>(`[data-rs-row="${list}"]`))
  const i = all.indexOf(el)
  const next =
    e.key === 'Home'
      ? all[0]
      : e.key === 'End'
        ? all[all.length - 1]
        : all[i + (e.key === 'ArrowDown' ? 1 : -1)]
  if (next) {
    e.preventDefault()
    next.focus()
  }
}

/** A row that opens a leaf. */
export function LeafRow({
  list,
  selected,
  onOpen,
  children,
  className,
  label
}: {
  list: string
  selected: boolean
  onOpen: () => void
  children: ReactNode
  className?: string
  label?: string
}) {
  return (
    <button
      type='button'
      data-rs-row={list}
      aria-current={selected ? 'true' : undefined}
      aria-label={label}
      onClick={onOpen}
      onKeyDown={rowKeys}
      className={cn(
        'group/row relative w-full min-w-0 text-left outline-none transition-colors',
        'hover:bg-slate-50 focus-visible:bg-slate-50 dark:hover:bg-muted/50 dark:focus-visible:bg-muted/50',
        'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan/60',
        selected &&
          'bg-nvr-cyan/[0.08] ring-1 ring-inset ring-nvr-cyan/40 hover:bg-nvr-cyan/[0.12] dark:bg-nvr-cyan/[0.12] dark:hover:bg-nvr-cyan/[0.16]',
        className
      )}
    >
      {children}
    </button>
  )
}

export function CopyText({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type='button'
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(
          () => {
            setDone(true)
            setTimeout(() => setDone(false), 1500)
          },
          () => toast.error('Could not copy — select the text and copy it instead.')
        )
      }}
      className='inline-flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-[11.5px] text-slate-500 hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:text-muted-foreground dark:hover:bg-muted dark:hover:text-foreground'
      data-tip={label}
      aria-label={label}
    >
      {done ? (
        <Check className='h-3.5 w-3.5 text-emerald-600' aria-hidden />
      ) : (
        <Copy className='h-3.5 w-3.5' aria-hidden />
      )}
    </button>
  )
}

export function MonoBlock({ children }: { children: ReactNode }) {
  return (
    <pre className='m-0 max-h-[360px] overflow-auto whitespace-pre-wrap break-words rounded-md border border-slate-200 bg-slate-50 p-2.5 font-mono text-[11.5px] leading-relaxed text-slate-800 dark:border-border dark:bg-muted/30 dark:text-slate-200'>
      {children}
    </pre>
  )
}

export function Hint({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p
      className={cn(
        'm-0 text-[12px] leading-relaxed text-slate-500 dark:text-muted-foreground',
        className
      )}
    >
      {children}
    </p>
  )
}
