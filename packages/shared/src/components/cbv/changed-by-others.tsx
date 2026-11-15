import { Check, History, X } from 'lucide-react'
import { useState } from 'react'
import { cn, formatDateTime } from '../../lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'

/**
 * "Changed by others" (realtime program 2026-11-14, item 11): a list filter that keeps the
 * records someone other than the reader created, edited or moved in a time window. The server
 * reads the activity log (api services/changed-filter.ts); the chip only states the window.
 *
 * Stored in the list's filters like any chip, so saved views, shared links and the filter
 * sentence carry it: `{path: ['$changed'], op: '_changed', value: '24h' | 'custom:<from>..<to>'}`.
 * A rolling window stays rolling ("last 24 hours" means the last 24 hours whenever the list is
 * read); a custom range is fixed.
 */

export const CHANGED_PATH = '$changed'
export const CHANGED_LABEL = 'Changed by others'

export const CHANGED_PERIODS: Array<{ value: string; label: string; short: string }> = [
  { value: '1h', label: 'Last hour', short: 'last hour' },
  { value: '24h', label: 'Last 24 hours', short: 'last 24 hours' },
  { value: '2d', label: 'Last 2 days', short: 'last 2 days' },
  { value: '5d', label: 'Last 5 days', short: 'last 5 days' },
  { value: '7d', label: 'Last 7 days', short: 'last 7 days' }
]

export interface ChangedChipFilter {
  id: string
  path: string[]
  pathLabels: string[]
  fieldType: string
  op: string
  value: string | Array<string | number>
  not?: boolean
}

export function isChangedFilter(f: { path: string[] }): boolean {
  return f.path[0] === CHANGED_PATH && f.path.length === 1
}

/** A custom range from the picker's two local date-times ('' = open end). */
export function customChangedValue(fromLocal: string, toLocal: string): string | null {
  const from = fromLocal ? new Date(fromLocal) : null
  const to = toLocal ? new Date(toLocal) : null
  if (!from || Number.isNaN(from.getTime())) return null
  if (to && (Number.isNaN(to.getTime()) || to.getTime() < from.getTime())) return null
  return `custom:${from.toISOString()}..${to ? to.toISOString() : ''}`
}

export function parseCustomChanged(value: string): { since: string; until: string | null } | null {
  if (!value.startsWith('custom:')) return null
  const [since, until] = value.slice(7).split('..')
  if (!since) return null
  return { since, until: until || null }
}

/** The chip's value compiled to the items route's `conditions` dialect. */
export function changedCondition(f: { value: unknown; not?: boolean }): {
  path: string[]
  op: string
  value: unknown
} {
  const v = String(f.value ?? '24h')
  const custom = parseCustomChanged(v)
  const value = custom
    ? { since: custom.since, ...(custom.until ? { until: custom.until } : {}), others: true }
    : { window: CHANGED_PERIODS.some((p) => p.value === v) ? v : '24h', others: true }
  return { path: [CHANGED_PATH], op: f.not ? '_neq' : '_eq', value }
}

/** "last 24 hours" / "Nov 12, 9:00 AM – Nov 13, 5:00 PM" / "since Nov 12, 9:00 AM". */
export function changedWindowText(value: unknown): string {
  const v = String(value ?? '')
  const custom = parseCustomChanged(v)
  if (custom) {
    const a = formatDateTime(custom.since)
    return custom.until ? `${a} – ${formatDateTime(custom.until)}` : `since ${a}`
  }
  return CHANGED_PERIODS.find((p) => p.value === v)?.short ?? 'last 24 hours'
}

/** The filter-sentence phrase. */
export function changedPhrase(f: { value: unknown; not?: boolean }): string {
  const w = changedWindowText(f.value)
  const inWin = parseCustomChanged(String(f.value ?? '')) ? w : `in the ${w}`
  return `${f.not ? 'not ' : ''}changed by others ${inWin}`
}

export function changedFilterEntry(value: string, id?: string): ChangedChipFilter {
  return {
    id: id ?? `${CHANGED_PATH}-${Date.now()}`,
    path: [CHANGED_PATH],
    pathLabels: [CHANGED_LABEL],
    fieldType: 'changed',
    op: '_changed',
    value
  }
}

/** `YYYY-MM-DDTHH:mm` in local time, for a datetime-local input. */
function localInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * The toolbar chip: off = a quiet dashed button; on = a filled chip naming the window. Both
 * open the period picker. Choosing a period applies it at once; Custom asks for a range.
 */
export function ChangedByOthersChip({
  filter,
  onChange
}: {
  filter: ChangedChipFilter | undefined
  onChange: (next: ChangedChipFilter | null) => void
}) {
  const [open, setOpen] = useState(false)
  const current = filter ? String(filter.value ?? '') : null
  const custom = current ? parseCustomChanged(current) : null
  const [customOpen, setCustomOpen] = useState(false)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')

  const openPicker = (o: boolean) => {
    setOpen(o)
    if (o) {
      setCustomOpen(!!custom)
      const now = new Date()
      setFrom(
        custom
          ? localInput(new Date(custom.since))
          : localInput(new Date(now.getTime() - 86_400_000))
      )
      setTo(custom?.until ? localInput(new Date(custom.until)) : '')
    }
  }
  const pick = (value: string) => {
    onChange(changedFilterEntry(value, filter?.id))
    setOpen(false)
  }
  const customValue = customChangedValue(from, to)

  return (
    <Popover open={open} onOpenChange={openPicker}>
      {filter ? (
        <span
          data-cbv-changed-chip='on'
          className='nvr-pop-in inline-flex h-8 min-w-0 max-w-full items-center gap-1 overflow-hidden whitespace-nowrap rounded-md border border-nvr-cyan/40 bg-nvr-cyan/10 pl-2 pr-1 text-[12px] text-slate-700 dark:text-slate-100'
        >
          <PopoverTrigger asChild>
            <button
              type='button'
              aria-label={`${CHANGED_LABEL}: ${changedWindowText(current)}. Change the period`}
              className='inline-flex min-w-0 items-center gap-1.5'
            >
              <History
                aria-hidden
                className='h-3.5 w-3.5 shrink-0 text-[#0089a8] dark:text-nvr-cyan'
              />
              <span className='min-w-0 shrink-[10] truncate'>
                {filter.not ? 'Not changed by others' : CHANGED_LABEL}
              </span>
              <span className='min-w-0 truncate font-semibold text-[#04516b] dark:text-nvr-cyan'>
                {changedWindowText(current)}
              </span>
            </button>
          </PopoverTrigger>
          <button
            type='button'
            onClick={() => onChange(null)}
            aria-label='Remove the changed by others filter'
            className='inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-slate-400 hover:bg-white/60 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200'
          >
            <X className='h-3 w-3' />
          </button>
        </span>
      ) : (
        <PopoverTrigger asChild>
          <button
            type='button'
            data-cbv-changed-chip='off'
            data-tip='Show only records other people changed recently'
            className='inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-dashed border-slate-300 px-2.5 text-[12.5px] text-slate-500 hover:border-slate-400 hover:text-slate-700 dark:border-slate-600 dark:text-slate-400 dark:hover:border-slate-500 dark:hover:text-slate-200'
          >
            <History aria-hidden className='h-3.5 w-3.5' />
            {CHANGED_LABEL}
          </button>
        </PopoverTrigger>
      )}
      <PopoverContent align='start' className='w-64 p-1' data-cbv-changed-picker=''>
        <p className='px-2 pb-1 pt-1.5 text-[11px] text-slate-500 dark:text-slate-400'>
          Records someone else created, edited or moved
        </p>
        {CHANGED_PERIODS.map((p) => {
          const on = current === p.value
          return (
            <button
              key={p.value}
              type='button'
              aria-pressed={on}
              data-changed-period={p.value}
              onClick={() => pick(p.value)}
              className='flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12.5px] hover:bg-muted'
            >
              <Check className={cn('h-3.5 w-3.5 shrink-0', on ? 'opacity-100' : 'opacity-0')} />
              {p.label}
            </button>
          )
        })}
        <button
          type='button'
          aria-pressed={!!custom}
          aria-expanded={customOpen}
          data-changed-period='custom'
          onClick={() => setCustomOpen((o) => !o)}
          className='flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12.5px] hover:bg-muted'
        >
          <Check className={cn('h-3.5 w-3.5 shrink-0', custom ? 'opacity-100' : 'opacity-0')} />
          Custom range…
        </button>
        {customOpen && (
          <div className='mx-1 mb-1 mt-0.5 space-y-2 rounded-md border border-slate-200 p-2 dark:border-slate-700'>
            <label className='block text-[11px] text-slate-500 dark:text-slate-400'>
              From
              <input
                type='datetime-local'
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className='mt-0.5 h-8 w-full rounded-md border border-slate-200 bg-white px-2 text-[12.5px] text-slate-800 outline-none focus:border-nvr-cyan/50 focus:ring-2 focus:ring-nvr-cyan/30 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:[color-scheme:dark]'
              />
            </label>
            <label className='block text-[11px] text-slate-500 dark:text-slate-400'>
              To <span className='text-slate-400'>(empty = now)</span>
              <input
                type='datetime-local'
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className='mt-0.5 h-8 w-full rounded-md border border-slate-200 bg-white px-2 text-[12.5px] text-slate-800 outline-none focus:border-nvr-cyan/50 focus:ring-2 focus:ring-nvr-cyan/30 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:[color-scheme:dark]'
              />
            </label>
            {from && !customValue && (
              <p className='text-[11px] text-amber-700 dark:text-amber-400'>
                The end must come after the start.
              </p>
            )}
            <button
              type='button'
              disabled={!customValue}
              onClick={() => customValue && pick(customValue)}
              className='h-7 w-full rounded-md bg-nvr-cyan text-[12px] font-medium text-white disabled:opacity-40'
            >
              Apply range
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

// ── Saved views: "N changed since you last opened this view" (item 10) ──────

/** The view's own conditions plus "changed by others since `since`". */
export function viewChangedConditions(
  viewConds: unknown[],
  since: string
): Array<{ path: string[]; op: string; value: unknown } | unknown> {
  return [...viewConds, { path: [CHANGED_PATH], op: '_eq', value: { since, others: true } }]
}

/** The pill's sentence. */
export function viewChangedTip(n: number): string {
  return `${n.toLocaleString()} changed since you last opened this view`
}
