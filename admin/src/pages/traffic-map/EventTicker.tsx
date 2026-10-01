import { useEffect, useRef } from 'react'
import type { Kind, TrafficCatalog, TrafficEventWire } from './types'

/** Data colour of a kind (swatches, bars, spark lines). */
export const KIND_VAR: Record<Kind, string> = {
  read: 'var(--tm-read)',
  create: 'var(--tm-create)',
  update: 'var(--tm-update)',
  delete: 'var(--tm-delete)',
  error: 'var(--tm-error)'
}
/** Text form of a kind colour — passes 4.5:1 where it is used as text. */
export const KIND_INK: Record<Kind, string> = {
  read: 'var(--tm-read-ink)',
  create: 'var(--tm-create)',
  update: 'var(--tm-update)',
  delete: 'var(--tm-delete)',
  error: 'var(--tm-error-ink)'
}

/** Rates: one decimal under 10, whole numbers above; never NaN/Infinity. */
export function fmtRate(n: number): string {
  if (!Number.isFinite(n)) return '—'
  return n < 10 ? n.toFixed(1) : Math.round(n).toLocaleString()
}
/** Latency with its unit ("558 ms", "1.2 s"); "—" when there is no figure. */
export function fmtMs(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '—'
  return n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${Math.round(n)} ms`
}
/** Counts: whole numbers (snapshot seeding spreads counts as fractions, so always round). */
export function fmtCount(n: number): string {
  return Number.isFinite(n) ? Math.round(n).toLocaleString() : '—'
}
export function fmtPct(n: number): string {
  return Number.isFinite(n) ? `${n.toFixed(1)}%` : '—'
}
export function fmtTime(t: number | string): string {
  const d = new Date(t)
  return Number.isNaN(d.getTime()) ? '—' : d.toTimeString().slice(0, 8)
}

export function callerLabel(cat: TrafficCatalog | null, key: string): string {
  const known = cat?.callers[key]?.label
  if (known) return known
  if (key === 'cron') return 'Crons & flows'
  if (key === 'anon') return 'Unauthenticated'
  if (key.startsWith('k')) return `API key ${key.slice(1)}`
  return key.slice(1, 9) || key
}
export function entityLabel(cat: TrafficCatalog | null, lane: string, entity: string): string {
  if (entity === '__other__') return 'other'
  if (entity === '__background__') return 'Background jobs'
  if (!cat) return entity
  if (lane === 'widgets') return cat.widgets[entity] ?? `widget ${entity}`
  if (lane === 'pages') return cat.pages[entity] ?? entity
  if (lane === 'queries') return cat.queries[entity] ?? entity
  if (lane === 'inbound') return cat.inbound[entity] ?? entity
  if (lane === 'extension') return cat.extensions[entity] ?? entity
  return entity
}

const VERB: Record<string, string> = { create: 'created', update: 'updated', delete: 'deleted' }
const TICKER_ROWS = 60

/** Kind pill: coloured dot + normal-case kind name (D1). */
export function KindPill({ kind, onTint }: { kind: Kind; onTint?: boolean }) {
  return (
    <span
      className='inline-flex items-center gap-1.5 whitespace-nowrap text-[11px] font-medium'
      style={{ color: onTint && kind !== 'error' ? 'var(--tm-fg-2)' : KIND_INK[kind] }}
    >
      <span
        className='inline-block h-1.5 w-1.5 shrink-0 rounded-full'
        style={{ background: KIND_VAR[kind] }}
        aria-hidden='true'
      />
      {kind}
    </span>
  )
}

function SkeletonRows({ n }: { n: number }) {
  return (
    <div className='grid gap-2 px-3.5 py-3' aria-hidden='true'>
      {Array.from({ length: n }, (_, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows
          key={i}
          className='h-3.5 animate-pulse rounded bg-[var(--tm-skeleton)] motion-reduce:animate-none'
          style={{ width: `${88 - ((i * 13) % 30)}%` }}
        />
      ))}
    </div>
  )
}

const FADE_MS = 600
const WINDOW_TEXT: Record<number, string> = { 60: '60 s', 300: '5 min', 900: '15 min' }

export function EventTicker({
  events,
  newestT,
  win,
  catalog,
  total,
  loading
}: {
  events: TrafficEventWire[]
  /** Newest event time across the whole model (filtered out or not). */
  newestT: number
  win: number
  catalog: TrafficCatalog | null
  total: number
  loading: boolean
}) {
  // Stable row keys (so a row is not remounted as newer rows push it down).
  const ids = useRef(new WeakMap<TrafficEventWire, number>())
  const next = useRef(0)
  // Fade only events that ARRIVED since the previous render: newer than the model's newest event
  // then. Rows merely revealed by a filter change are older and never flash. The fade deadline is
  // fixed at first sight, so a re-render inside the 600 ms neither restarts nor cuts it.
  const lastNewest = useRef(Number.NEGATIVE_INFINITY)
  const fadeUntil = useRef(new WeakMap<TrafficEventWire, number>())
  const rows = events.slice(0, TICKER_ROWS)
  const now = Date.now()
  const fadeOf = (ev: TrafficEventWire) => {
    let until = fadeUntil.current.get(ev)
    if (until === undefined) {
      until = ev.t > lastNewest.current ? now + FADE_MS : 0
      fadeUntil.current.set(ev, until)
    }
    return until > now
  }
  const keyOf = (ev: TrafficEventWire) => {
    let id = ids.current.get(ev)
    if (id === undefined) {
      id = next.current++
      ids.current.set(ev, id)
    }
    return id
  }
  useEffect(() => {
    if (newestT > lastNewest.current) lastNewest.current = newestT
  }, [newestT])

  return (
    <section
      className='min-w-0 rounded-lg border border-[var(--tm-line)] bg-[var(--tm-card)]'
      aria-label='Live events'
      id='tm-ticker'
    >
      <div className='flex items-center justify-between gap-3 border-b border-[var(--tm-line-2)] px-3.5 py-2'>
        <div className='min-w-0'>
          <h2 className='text-[13px] font-semibold'>Live events</h2>
          <p className='text-[11.5px] text-[var(--tm-muted)]'>
            Writes with record ids and changed fields · errors with status and route
          </p>
        </div>
        <span className='shrink-0 text-[11.5px] tabular-nums text-[var(--tm-muted)]'>
          {total.toLocaleString()} since open
        </span>
      </div>
      <div className='max-h-[440px] overflow-auto' data-tm-ticker=''>
        {loading && rows.length === 0 ? (
          <SkeletonRows n={8} />
        ) : rows.length === 0 ? (
          <p className='px-3.5 py-3 text-[12px] text-[var(--tm-muted)]'>
            {total === 0
              ? `No traffic in the last ${WINDOW_TEXT[win] ?? `${win} s`}. Requests appear here as they happen.`
              : 'Nothing matches the current filters.'}
          </p>
        ) : (
          rows.map((ev) => {
            const who = callerLabel(catalog, ev.caller)
            const name = entityLabel(catalog, ev.lane, ev.entity)
            const isErr = ev.kind === 'error'
            const isRead = ev.kind === 'read'
            const fresh = fadeOf(ev) && !isErr
            const quiet = isErr ? 'text-[var(--tm-fg-2)]' : 'text-[var(--tm-muted)]'
            return (
              <div
                key={keyOf(ev)}
                data-tm-event={ev.kind}
                className={`grid grid-cols-[58px_62px_minmax(0,1fr)] items-baseline gap-2 border-b border-[var(--tm-line-2)] px-3.5 py-1 text-[12px] last:border-0 ${
                  isErr ? 'bg-[var(--tm-error-soft)]' : ''
                } ${fresh ? 'tm-ev-fresh' : ''}`}
              >
                <span className={`font-mono text-[10.5px] tabular-nums ${quiet}`}>
                  {fmtTime(ev.t)}
                </span>
                <KindPill kind={ev.kind} />
                <span
                  className={`min-w-0 truncate ${isRead ? 'text-[var(--tm-fg-2)]' : ''}`}
                  title={ev.route}
                >
                  {isErr ? (
                    <>
                      <span className='font-mono text-[11px] font-medium tabular-nums text-[var(--tm-error-ink)]'>
                        {ev.status ?? 'error'}
                      </span>{' '}
                      <span className='font-mono text-[11px]'>{ev.route}</span>
                      {ev.code ? (
                        <>
                          {' · '}
                          <span className='font-mono text-[11px]'>{ev.code}</span>
                        </>
                      ) : null}
                      {ev.record ? (
                        <>
                          {' · '}
                          <span className='font-mono text-[11px]'>{ev.record}</span>
                        </>
                      ) : null}
                      <span className={quiet}>
                        {' · '}
                        {who}
                        {ev.ms != null ? ` · ${fmtMs(ev.ms)}` : ''}
                      </span>
                    </>
                  ) : isRead ? (
                    <>
                      <span className='font-mono text-[11px] font-medium'>{name}</span>{' '}
                      <span className='font-mono text-[11px]'>{ev.route}</span>
                      <span className={quiet}>
                        {' · '}
                        {who}
                        {ev.ms != null ? ` · ${fmtMs(ev.ms)}` : ''}
                      </span>
                    </>
                  ) : (
                    <>
                      <span className='font-mono text-[11px] font-semibold'>{name}</span>
                      {ev.record ? (
                        <>
                          {' '}
                          <span className='font-mono text-[11px]'>{ev.record}</span>
                        </>
                      ) : null}{' '}
                      {VERB[ev.kind]}
                      {ev.fields?.length ? (
                        <>
                          {' · '}
                          <span className='font-mono text-[11px] text-[var(--tm-fg-2)]'>
                            {ev.fields.join(', ')}
                          </span>
                        </>
                      ) : null}
                      <span className={quiet}>
                        {' · '}
                        {who}
                      </span>
                    </>
                  )}
                </span>
              </div>
            )
          })
        )}
      </div>
    </section>
  )
}
