import { AlertTriangle, Check, ClipboardCopy, Copy, KeyRound } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { type ChipState, HUB_MASK, STATUS_COPY, STATUS_DOT, STATUS_TONE } from './hub-api'

/** Pieces the Apps hub screens share: status chips, section cards, labelled fields. */

export function StatusChip({
  state,
  label,
  tip,
  ariaLabel,
  glyph,
  compact
}: {
  state: ChipState
  /** Overrides the status copy (e.g. an environment key in the list's chips). */
  label?: string
  tip?: string
  /** The chip's whole meaning for screen readers (the colour alone says nothing to them). */
  ariaLabel?: string
  /** Show a glyph for any state that is not fine, so status never rides on colour alone. */
  glyph?: boolean
  compact?: boolean
}) {
  const text =
    label ??
    (state === 'checking'
      ? 'Checking…'
      : state === 'failed'
        ? 'Could not check'
        : STATUS_COPY[state])
  const Glyph = !glyph
    ? null
    : state === 'link_refused'
      ? KeyRound
      : state === 'degraded' || state === 'unreachable' || state === 'failed'
        ? AlertTriangle
        : null
  const className = cn(
    'inline-flex max-w-full items-center gap-1.5 rounded-full border font-medium',
    compact ? 'px-1.5 py-px text-[10px]' : 'px-2 py-0.5 text-[11px]',
    STATUS_TONE[state]
  )
  const body = (
    <>
      <span aria-hidden className={cn('h-1.5 w-1.5 shrink-0 rounded-full', STATUS_DOT[state])} />
      <span className='truncate'>{text}</span>
      {Glyph && <Glyph className='h-2.5 w-2.5 shrink-0' aria-hidden />}
    </>
  )
  // With a label the chip is one image to a screen reader ("staging: Not answering").
  return ariaLabel ? (
    <span data-tip={tip} role='img' aria-label={ariaLabel} className={className}>
      {body}
    </span>
  ) : (
    <span data-tip={tip} className={className}>
      {body}
    </span>
  )
}

export function SectionCard({
  title,
  description,
  actions,
  children,
  className
}: {
  title: string
  description?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section
      className={cn(
        'rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card',
        className
      )}
    >
      <header className='flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-slate-200 px-4 py-3 dark:border-border'>
        <div className='min-w-0 flex-[1_1_240px]'>
          <h3 className='m-0 text-[13px] font-semibold text-slate-900 dark:text-foreground'>
            {title}
          </h3>
          {description && (
            <p className='m-0 mt-0.5 text-[12px] text-slate-500 dark:text-muted-foreground'>
              {description}
            </p>
          )}
        </div>
        {actions && <div className='flex flex-wrap items-center gap-2'>{actions}</div>}
      </header>
      {children}
    </section>
  )
}

export function Field({
  id,
  label,
  hint,
  error,
  children
}: {
  id: string
  label: string
  hint?: ReactNode
  error?: string | null
  children: ReactNode
}) {
  return (
    <div className='space-y-1.5'>
      <Label htmlFor={id} className='text-[12px] font-medium text-slate-700 dark:text-foreground'>
        {label}
      </Label>
      {children}
      {error ? (
        <p className='m-0 text-[11px] text-red-600 dark:text-red-400'>{error}</p>
      ) : hint ? (
        <p className='m-0 text-[11px] text-slate-500 dark:text-muted-foreground'>{hint}</p>
      ) : null}
    </div>
  )
}

/**
 * A secret the API shows only as '••••••'. Left as is, the stored value stays; cleared, it is
 * removed; typed over, it is replaced. Never filled from the browser's saved passwords.
 */
export function SecretInput({
  id,
  value,
  onChange,
  stored,
  placeholder
}: {
  id: string
  value: string
  onChange: (v: string) => void
  /** Whether a value is stored now (the field starts at the mask). */
  stored: boolean
  placeholder?: string
}) {
  return (
    <Input
      id={id}
      type='password'
      autoComplete='new-password'
      spellCheck={false}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onFocus={(e) => {
        if (stored && value === HUB_MASK) e.currentTarget.select()
      }}
      placeholder={placeholder}
      className='h-8 font-mono text-[13px]'
    />
  )
}

export const smallButton =
  'inline-flex h-8 items-center justify-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50'

export const ghostButton = cn(
  smallButton,
  'text-slate-600 hover:bg-slate-100 disabled:opacity-50 dark:text-slate-300 dark:hover:bg-muted'
)

export const dangerGhost = cn(
  smallButton,
  'text-red-600 hover:bg-red-50 disabled:opacity-50 dark:text-red-400 dark:hover:bg-red-950/40'
)

export const dangerArmed =
  'bg-red-600 text-white hover:bg-red-700 dark:bg-red-600 dark:text-white dark:hover:bg-red-700'

/**
 * The Apps hub's Copy button. Without a clipboard (a plain-http page) or when the browser refuses
 * the write, it turns into a read-only field holding the text, selected once, with a note to press
 * Ctrl+C. `label` is the accessible name of both; `compact` = an icon button (checklist rows).
 */
export function CopyButton({
  value,
  label,
  compact
}: {
  value: string
  label: string
  compact?: boolean
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'manual'>('idle')
  const box = useRef<HTMLInputElement>(null)
  const manual = state === 'manual'
  // Select once when the field appears; never again on a re-render (a refetch), so a selection
  // the person made stays theirs.
  useEffect(() => {
    if (!manual) return
    box.current?.focus()
    box.current?.select()
  }, [manual])
  useEffect(() => {
    if (state !== 'copied') return
    const t = window.setTimeout(() => setState('idle'), 1500)
    return () => window.clearTimeout(t)
  }, [state])

  if (manual)
    return (
      <span className='inline-flex min-w-0 max-w-full flex-wrap items-center gap-1.5'>
        <input
          ref={box}
          readOnly
          aria-label={label}
          value={value}
          className='h-7 min-w-0 max-w-[260px] flex-1 rounded border border-slate-300 bg-white px-1.5 font-mono text-[11px] text-slate-900 dark:border-border dark:bg-card dark:text-foreground'
        />
        <span role='status' className='text-[11px] text-amber-800 dark:text-amber-300'>
          Copying is not available here: the text is selected, press Ctrl+C (⌘C on a Mac).
        </span>
      </span>
    )
  const copy = () => {
    const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined
    if (!clip?.writeText) return setState('manual')
    clip.writeText(value).then(
      () => setState('copied'),
      () => setState('manual')
    )
  }
  const done = state === 'copied'
  if (compact)
    return (
      <button
        type='button'
        data-tip={done ? 'Copied' : 'Copy'}
        aria-label={label}
        onClick={copy}
        className='inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-slate-500 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:text-muted-foreground dark:hover:bg-muted'
      >
        {done ? (
          <Check className='h-3.5 w-3.5' aria-hidden />
        ) : (
          <ClipboardCopy className='h-3.5 w-3.5' aria-hidden />
        )}
      </button>
    )
  return (
    <Button
      type='button'
      variant='outline'
      size='sm'
      aria-label={label}
      data-tip={label}
      className='h-7 shrink-0 gap-1 px-2 text-[11.5px]'
      onClick={copy}
    >
      {done ? <Check className='h-3 w-3' aria-hidden /> : <Copy className='h-3 w-3' aria-hidden />}
      {done ? 'Copied' : 'Copy'}
    </Button>
  )
}

/**
 * Spread on the box that shows a secret once (a deployment token, an agent token, a sign-in
 * client secret), together with `NO_RECORD_CLASS` in its className: session replay
 * (`[data-replay-block]`, REPLAY_BLOCK_SELECTOR) records a blank box of the same size in its place,
 * and a Report-a-problem screenshot blanks `.nvr-no-record`. Only inputs are masked otherwise, so
 * a value shown as text would be kept in clear for anyone who may open replays.
 */
export const NO_RECORD_ATTRS = { 'data-replay-block': '' } as const
export const NO_RECORD_CLASS = 'nvr-no-record'
