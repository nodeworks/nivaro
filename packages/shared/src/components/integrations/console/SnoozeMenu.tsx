import { BellOff, EyeOff, Loader2 } from 'lucide-react'
import { useState } from 'react'
import { cn } from '../../../lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover'
import { useSnooze } from './api'

type Scope = 'row' | 'group' | 'signal'
type Length = 'day' | 'week' | 'change'

const LENGTHS: Array<{ key: Length; label: string }> = [
  { key: 'day', label: '1 day' },
  { key: 'week', label: '1 week' },
  { key: 'change', label: 'Until it changes' }
]

/**
 * The quiet per-row "I've seen this one" control — notification-style: it
 * hides THIS occurrence and nothing else, coming back the moment the row's
 * occurrence changes (a new run, a new attempt...). Ghost icon button, same
 * footprint as the Snooze trigger beside it, distinguished by icon (EyeOff
 * vs BellOff) rather than color — Dismiss is not a warning action.
 */
export function DismissButton({ signal, rowKey }: { signal: string; rowKey: string }) {
  const { add } = useSnooze()
  return (
    <button
      type='button'
      data-ic-dismiss={`${signal}:${rowKey}`}
      aria-label='Dismiss this occurrence'
      data-tip='Hide until it happens again'
      disabled={add.isPending}
      onClick={() => add.mutate({ signal, row_key: rowKey, until_occurrence: true })}
      className='inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60'
    >
      {add.isPending ? (
        <Loader2 className='h-3.5 w-3.5 animate-spin' />
      ) : (
        <EyeOff className='h-3.5 w-3.5' />
      )}
    </button>
  )
}

/**
 * Quiet one problem, a whole group, or the whole signal. "Until it changes"
 * is offered only for a single row — the API hashes ONE row's payload, so a
 * group or signal can only be quieted for a set time. Dismiss lives at the
 * top for a row-scoped menu — the one-click, no-questions-asked cousin of
 * everything below it.
 */
export function SnoozeMenu({
  signal,
  signalLabel,
  rowKey,
  group,
  defaultScope,
  compact
}: {
  signal: string
  signalLabel: string
  rowKey?: string
  group?: { key: string; label: string }
  /** What the menu opens on — a group header opens on the group. */
  defaultScope?: Scope
  compact?: boolean
}) {
  const { add } = useSnooze()
  const [open, setOpen] = useState(false)
  const initialScope: Scope = defaultScope ?? (rowKey ? 'row' : group ? 'group' : 'signal')
  const [scope, setScope] = useState<Scope>(initialScope)
  const [length, setLength] = useState<Length>('day')
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)

  const scopes: Array<{ key: Scope; label: string }> = [
    ...(rowKey ? [{ key: 'row' as const, label: 'This problem' }] : []),
    ...(group ? [{ key: 'group' as const, label: `Everything in ${group.label}` }] : []),
    { key: 'signal', label: `All of “${signalLabel}”` }
  ]
  const lengthOk = (l: Length) => l !== 'change' || scope === 'row'
  const effectiveLength = lengthOk(length) ? length : 'day'

  const submit = () => {
    setError(null)
    const until =
      effectiveLength === 'change'
        ? null
        : new Date(Date.now() + (effectiveLength === 'day' ? 1 : 7) * 86_400_000).toISOString()
    add.mutate(
      {
        signal,
        row_key: scope === 'row' ? rowKey : undefined,
        group_key: scope === 'group' ? group?.key : undefined,
        until,
        until_change: effectiveLength === 'change' || undefined,
        note: note.trim() || undefined
      },
      {
        onSuccess: () => {
          setOpen(false)
          setNote('')
        },
        onError: (e: unknown) => {
          const resp = (e as { response?: { error?: string } })?.response
          setError(resp?.error ?? (e instanceof Error ? e.message : 'Could not snooze'))
        }
      }
    )
  }

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (o) {
          setScope(initialScope)
          setError(null)
        }
      }}
    >
      <PopoverTrigger asChild>
        <button
          type='button'
          data-ic-snooze={scope}
          aria-label={compact ? 'Snooze' : undefined}
          className={cn(
            'inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            open && 'bg-muted text-foreground'
          )}
        >
          <BellOff className='h-3.5 w-3.5' />
          {!compact && 'Snooze'}
        </button>
      </PopoverTrigger>
      <PopoverContent align='end' className='w-72 p-0' data-ic-snooze-menu>
        {rowKey && (
          <div className='border-b border-border p-1'>
            <button
              type='button'
              data-ic-dismiss-menu={`${signal}:${rowKey}`}
              disabled={add.isPending}
              onClick={() => {
                add.mutate(
                  { signal, row_key: rowKey, until_occurrence: true },
                  { onSuccess: () => setOpen(false) }
                )
              }}
              className='flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60'
            >
              {add.isPending ? (
                <Loader2 className='h-3.5 w-3.5 shrink-0 animate-spin' />
              ) : (
                <EyeOff className='h-3.5 w-3.5 shrink-0' />
              )}
              Dismiss — hide until it happens again
            </button>
          </div>
        )}
        <div className='space-y-3 p-3'>
          <fieldset>
            <legend className='mb-1.5 text-[12px] font-medium text-foreground'>
              What to quiet
            </legend>
            <div className='space-y-0.5'>
              {scopes.map((s) => (
                <label
                  key={s.key}
                  className='flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-[12.5px] text-foreground hover:bg-muted'
                >
                  <input
                    type='radio'
                    name={`ic-snooze-scope-${signal}-${rowKey ?? group?.key ?? 'all'}`}
                    checked={scope === s.key}
                    onChange={() => setScope(s.key)}
                    className='accent-[rgb(var(--nvr-cyan-rgb))]'
                    data-ic-snooze-scope={s.key}
                  />
                  <span className='truncate'>{s.label}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset>
            <legend className='mb-1.5 text-[12px] font-medium text-foreground'>For how long</legend>
            <div className='flex flex-wrap gap-1'>
              {LENGTHS.filter((l) => lengthOk(l.key)).map((l) => (
                <button
                  key={l.key}
                  type='button'
                  aria-pressed={effectiveLength === l.key}
                  data-ic-snooze-length={l.key}
                  onClick={() => setLength(l.key)}
                  className={cn(
                    'h-7 rounded-md border px-2.5 text-[12px] transition-colors',
                    effectiveLength === l.key
                      ? 'border-foreground/25 bg-muted font-medium text-foreground'
                      : 'border-border text-muted-foreground hover:text-foreground'
                  )}
                >
                  {l.label}
                </button>
              ))}
            </div>
            {effectiveLength === 'change' && (
              <p className='mt-1.5 text-[11.5px] leading-snug text-muted-foreground'>
                Comes back on its own if the problem's details change.
              </p>
            )}
          </fieldset>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder='Note for the team (optional)'
            maxLength={500}
            data-ic-snooze-note
            className='h-8 w-full rounded-md border border-border bg-background px-2.5 text-[12.5px] text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
          />
          {error && <p className='text-[12px] text-destructive'>{error}</p>}
        </div>
        <div className='flex justify-end gap-2 border-t border-border px-3 py-2'>
          <button
            type='button'
            onClick={() => setOpen(false)}
            className='h-7 rounded-md px-2.5 text-[12px] text-muted-foreground hover:text-foreground'
          >
            Cancel
          </button>
          <button
            type='button'
            onClick={submit}
            disabled={add.isPending}
            data-ic-snooze-confirm
            className='inline-flex h-7 items-center gap-1.5 rounded-md bg-primary px-3 text-[12px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60'
          >
            {add.isPending && <Loader2 className='h-3 w-3 animate-spin' />}
            Snooze
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
