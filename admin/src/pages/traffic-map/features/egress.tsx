import { useQuery } from '@tanstack/react-query'
import { ArrowUpRight } from 'lucide-react'
import { useState } from 'react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useTrafficMap } from '../context'
import { entityLabel, fmtCount } from '../EventTicker'
import { Empty } from '../Inspector'
import { pagePanels } from '../registry/pagePanels'
import { register } from '../registry/registry'
import { toolbarItems } from '../registry/toolbarItems'
import { ago, createStore, inPage, TAG, useStore } from './b1-shared'
import { usePeopleNames } from './people-names'
import { BTN } from './shared'
import { useFrozenSnapshotId } from './snapshots'

/**
 * #1179 — data egress lens: who pulled how many rows out. List reads through the API (rows
 * returned per caller over the map window, with "large reads" of 500+ rows) beside the exports
 * people ran — CSV / xlsx exports, export presets, PDF renders, dossiers, backups and bundle
 * exports from the activity log. A compliance view, opened from the More menu.
 */
export interface EgressReader {
  caller: string
  rows: number
  reads: number
  large: number
  top: Array<{ key: string; rows: number }>
}
export interface EgressExport {
  caller: string
  exports: number
  rows: number
  by: Array<{ action: string; label: string; n: number; rows: number }>
  last_at: string
  recent: Array<{
    action: string
    label: string
    collection: string | null
    rows: number | null
    at: string
  }>
}
export interface Egress {
  window_s: number
  exports_span_s: number
  readers: EgressReader[]
  exports: EgressExport[]
}

export const egressOpen = createStore(false)

const SPANS: Array<[number, string]> = [
  [0, 'Map window'],
  [1, '1 h'],
  [6, '6 h'],
  [24, '24 h']
]

function EgressMenuItem() {
  const open = useStore(egressOpen)
  const frozen = useFrozenSnapshotId()
  if (frozen) return null
  return (
    <button
      type='button'
      id='tm-egress-toggle'
      aria-pressed={open}
      onClick={() => egressOpen.set(!open)}
      title='Who pulled how many rows out: list reads and exports, ranked by caller'
      className={cn(
        BTN,
        open && 'border-[var(--tm-accent)] bg-[var(--tm-accent-soft)] text-[var(--tm-accent-ink)]'
      )}
    >
      <ArrowUpRight className='h-3.5 w-3.5' aria-hidden='true' />
      Data egress
    </button>
  )
}

const SEG =
  'px-2 py-[3px] text-[11.5px] font-medium leading-tight transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan'

function EgressPanel() {
  const open = useStore(egressOpen)
  const { win, paused, ready, catalog, setSelection } = useTrafficMap()
  const [hours, setHours] = useState(0)
  const q = useQuery({
    queryKey: ['traffic-map', 'egress', win, hours],
    queryFn: async () =>
      (await api.get('/traffic-map/egress', { params: { window: win, hours: hours || undefined } }))
        .data.data as Egress,
    enabled: open && ready,
    refetchInterval: paused ? false : 15_000,
    staleTime: 10_000
  })
  const d = q.data
  const name = usePeopleNames([
    ...(d?.readers ?? []).map((r) => r.caller),
    ...(d?.exports ?? []).map((x) => x.caller)
  ])
  if (!open) return null
  const span = hours ? `${hours} h` : win >= 900 ? '15 min' : win >= 300 ? '5 min' : '1 min'
  const maxRows = Math.max(1, ...(d?.readers ?? []).map((r) => r.rows))
  return (
    <section
      className='min-w-0 rounded-lg border border-[var(--tm-line)] bg-[var(--tm-card)] min-[1100px]:col-span-2'
      aria-label='Data egress'
      id='tm-egress'
    >
      <div className='flex flex-wrap items-start justify-between gap-3 border-b border-[var(--tm-line-2)] px-3.5 py-2'>
        <div className='min-w-0'>
          <h2 className='text-[13px] font-semibold'>Data egress</h2>
          <p className='text-[11.5px] text-[var(--tm-muted)]'>
            Rows returned by list reads in the map window, and exports in the last {span}.
          </p>
        </div>
        <div className='flex items-center gap-2'>
          <fieldset
            className='inline-flex overflow-hidden rounded-md border border-[var(--tm-line)]'
            aria-label='Exports span'
          >
            {SPANS.map(([h, label], i) => (
              <button
                key={h}
                type='button'
                aria-pressed={hours === h}
                data-tm-egress-span={h}
                onClick={() => setHours(h)}
                className={cn(
                  SEG,
                  i > 0 && 'border-l border-[var(--tm-line)]',
                  hours === h
                    ? 'bg-[var(--tm-accent-soft)] text-[var(--tm-accent-ink)]'
                    : 'bg-[var(--tm-card)] text-[var(--tm-fg-2)] hover:bg-[var(--tm-card-2)]'
                )}
              >
                {label}
              </button>
            ))}
          </fieldset>
          <button type='button' className={BTN} onClick={() => egressOpen.set(false)}>
            Close
          </button>
        </div>
      </div>
      <div className='grid gap-4 px-3.5 py-3 min-[1100px]:grid-cols-2'>
        <div className='min-w-0'>
          <h3 className='mb-1.5 text-[12px] font-medium text-[var(--tm-muted)]'>
            Rows read through the API
          </h3>
          {q.isLoading ? (
            <Empty>Loading…</Empty>
          ) : !d?.readers.length ? (
            <Empty>No list reads in this window.</Empty>
          ) : (
            <ul className='grid gap-2' id='tm-egress-readers'>
              {d.readers.map((r) => (
                <li key={r.caller} className='min-w-0' data-tm-egress-reader={r.caller}>
                  <div className='flex min-w-0 items-baseline justify-between gap-2 text-[12px]'>
                    <button
                      type='button'
                      className='min-w-0 truncate text-left font-semibold hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
                      onClick={() => setSelection({ kind: 'caller', id: r.caller })}
                    >
                      {name(r.caller)}
                    </button>
                    <span className='shrink-0 tabular-nums text-[var(--tm-fg-2)]'>
                      {fmtCount(r.rows)} rows · {fmtCount(r.reads)} reads
                      {r.large > 0 && (
                        <span className={cn(TAG, 'ml-1.5')} data-tm-egress-large=''>
                          {r.large} large
                        </span>
                      )}
                    </span>
                  </div>
                  <span className='mt-0.5 block h-1 overflow-hidden rounded-sm bg-[var(--tm-accent-soft)]'>
                    <i
                      className='block h-full bg-[var(--tm-accent)]'
                      style={{ width: `${Math.min(100, (100 * r.rows) / maxRows)}%` }}
                    />
                  </span>
                  <p className='mt-0.5 truncate text-[11.5px] text-[var(--tm-fg-2)]'>
                    {r.top
                      .map((e) => {
                        const cut = e.key.indexOf('/')
                        return `${entityLabel(catalog, e.key.slice(0, cut), e.key.slice(cut + 1))} ${fmtCount(e.rows)}`
                      })
                      .join(' · ')}
                  </p>
                </li>
              ))}
            </ul>
          )}
          <p className='mt-2 text-[11.5px] text-[var(--tm-muted)]'>
            REST list reads on this node; a read of 500 rows or more counts as large.
          </p>
        </div>
        <div className='min-w-0'>
          <h3 className='mb-1.5 text-[12px] font-medium text-[var(--tm-muted)]'>Exports</h3>
          {q.isLoading ? (
            <Empty>Loading…</Empty>
          ) : !d?.exports.length ? (
            <Empty>No exports in the last {span}.</Empty>
          ) : (
            <ul className='grid gap-2.5' id='tm-egress-exports'>
              {d.exports.map((x) => (
                <li key={x.caller} className='min-w-0 text-[12px]' data-tm-egress-export={x.caller}>
                  <div className='flex min-w-0 items-baseline justify-between gap-2'>
                    <span className='min-w-0 truncate font-semibold'>{name(x.caller)}</span>
                    <span className='shrink-0 tabular-nums text-[var(--tm-fg-2)]'>
                      {fmtCount(x.exports)} {x.exports === 1 ? 'export' : 'exports'}
                      {x.rows > 0 ? ` · ${fmtCount(x.rows)} rows` : ''} · last {ago(x.last_at)}
                    </span>
                  </div>
                  <div className='mt-1 flex flex-wrap gap-1'>
                    {x.by.map((b) => (
                      <span key={b.action} className={TAG}>
                        {b.label} {b.n}
                      </span>
                    ))}
                  </div>
                  <ul className='mt-1 grid gap-0.5 text-[11.5px] text-[var(--tm-fg-2)]'>
                    {x.recent.map((r, i) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: two exports can share a second; the list is never reordered
                      <li key={`${r.at}-${r.action}-${i}`} className='truncate'>
                        {r.label}
                        {r.collection ? ` of ${r.collection}` : ''}
                        {r.rows != null ? ` · ${fmtCount(r.rows)} rows` : ''} · {ago(r.at)}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
          <p className='mt-2 text-[11.5px] text-[var(--tm-muted)]'>
            From the activity log: browser exports report their row count when they finish.
          </p>
        </div>
      </div>
    </section>
  )
}

register(toolbarItems, { id: 'egress', order: 60, slot: 'menu', Component: inPage(EgressMenuItem) })
register(pagePanels, { id: 'egress', order: 5, Component: inPage(EgressPanel) })
