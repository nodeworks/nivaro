import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useNivaroClient } from '../context'
import { get } from '../lib/commands'
import { cn, formatRelative } from '../lib/utils'

/**
 * #7 / #12 — "shipped n / m" for a record whose collection declares
 * `browser_config.fulfilment`, with a hover card of the last three events an
 * integration recorded on the record (the same read-only entries the Notes
 * thread shows — carrier, date, what moved). Shared by the collection
 * browser and the queue tables. Needs `<NivaroProvider>` for the hover
 * fetch; without a status it renders a dash.
 */
export interface FulfilmentFigures {
  shipped: number
  requested: number
  status: 'none' | 'partial' | 'complete'
}

export function fulfilmentFigures(shipped: unknown, requested: unknown): FulfilmentFigures {
  const s = Number(shipped ?? 0) || 0
  const r = Number(requested ?? 0) || 0
  return {
    shipped: s,
    requested: r,
    status: !(s > 0) ? 'none' : r > 0 && s >= r ? 'complete' : 'partial'
  }
}

export const FULFILMENT_FILTER_OPTIONS = [
  { value: 'none', label: 'Not shipped' },
  { value: 'partial', label: 'Partially shipped' },
  { value: 'complete', label: 'Shipped' }
]

interface RelatedEvent {
  id: string
  source: string
  label: string
  text: string
  context: string | null
  created_at: string
  status?: string | null
}

export function FulfilmentPill({
  collection,
  itemId,
  figures,
  label,
  className
}: {
  collection: string
  itemId: string
  figures: FulfilmentFigures | null | undefined
  /** The integration's name for the hover card title ("MDSi"). */
  label?: string | null
  className?: string
}) {
  const client = useNivaroClient()
  const [hover, setHover] = useState(false)
  const { data: events } = useQuery({
    queryKey: ['fulfilment-events', collection, itemId],
    queryFn: () =>
      client
        .request<{ data: RelatedEvent[] }>(get('/comments/related', { collection, item: itemId }))
        .then((r) => (r.data ?? []).filter((e) => e.source === 'external'))
        .then((rows) =>
          rows
            .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
            .slice(0, 3)
        )
        .catch(() => [] as RelatedEvent[]),
    enabled: hover && !!figures && figures.status !== 'none',
    staleTime: 60_000
  })
  if (!figures) return <span className='text-slate-300'>—</span>
  const { shipped, requested, status } = figures
  const tone =
    status === 'complete'
      ? {
          dot: 'bg-emerald-500',
          text: 'text-emerald-700 dark:text-emerald-300',
          box: 'border-emerald-200 bg-emerald-50/70 dark:border-emerald-900/40 dark:bg-emerald-900/10'
        }
      : status === 'partial'
        ? {
            dot: 'bg-amber-500',
            text: 'text-amber-700 dark:text-amber-300',
            box: 'border-amber-200 bg-amber-50/70 dark:border-amber-900/40 dark:bg-amber-900/10'
          }
        : {
            dot: 'bg-slate-300 dark:bg-slate-600',
            text: 'text-slate-500 dark:text-slate-400',
            box: 'border-slate-200 bg-slate-50 dark:border-border dark:bg-muted'
          }
  const word = status === 'complete' ? 'Shipped' : status === 'partial' ? 'Partial' : 'Not shipped'
  return (
    <button
      type='button'
      className={cn('relative inline-flex cursor-default', className)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
      onClick={(e) => {
        e.stopPropagation()
        setHover((h) => !h)
      }}
      aria-label={`${word}${requested > 0 ? ` — ${fmt(shipped)} of ${fmt(requested)}` : ''}`}
      data-fulfilment={status}
      data-fulfilment-open={hover ? 'true' : undefined}
    >
      <span
        className={cn(
          'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium tabular-nums',
          tone.box,
          tone.text
        )}
      >
        <span aria-hidden className={cn('h-1.5 w-1.5 shrink-0 rounded-full', tone.dot)} />
        {requested > 0 ? `${fmt(shipped)} / ${fmt(requested)}` : word}
        {requested > 0 && <span className='opacity-70'>· {word}</span>}
      </span>
      {hover && status !== 'none' && (
        <span
          className='absolute left-0 top-full z-30 mt-1 w-[280px] rounded-md border border-slate-200 bg-white p-2 text-left text-[11px] shadow-lg dark:border-border dark:bg-popover'
          data-fulfilment-events
        >
          <span className='block text-[10px] font-semibold uppercase tracking-wide text-slate-400'>
            {label ? `${label} · ` : ''}latest events
          </span>
          {!events ? (
            <span className='mt-1 block text-slate-400'>Loading…</span>
          ) : events.length === 0 ? (
            <span className='mt-1 block text-slate-400'>No events recorded yet.</span>
          ) : (
            <ul className='mt-1 space-y-1'>
              {events.map((e) => (
                <li key={e.id} className='leading-snug'>
                  <span className='font-medium text-slate-700 dark:text-slate-200'>
                    {e.context ?? e.label}
                  </span>
                  <span className='text-slate-400'> · {formatRelative(e.created_at)}</span>
                  <span className='block truncate text-slate-500 dark:text-slate-400'>
                    {e.text}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </span>
      )}
    </button>
  )
}

function fmt(n: number): string {
  return Number.isInteger(n)
    ? n.toLocaleString()
    : n.toLocaleString(undefined, { maximumFractionDigits: 2 })
}
