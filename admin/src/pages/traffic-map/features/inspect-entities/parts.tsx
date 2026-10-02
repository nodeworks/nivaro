/**
 * Building blocks the "entities" panels share: a titled block, a facts grid, loading / error
 * states that say why, a request row that drills by request id, a status chip and a spark.
 */
import type { ReactNode } from 'react'
import { useContext } from 'react'
import { cn } from '@/lib/utils'
import { TrafficMapContext } from '../../context'
import { callerLabel, fmtMs, fmtTime } from '../../EventTicker'
import { inspectErrorOf } from '../../inspect/api'
import { InspectLink } from '../../inspect/InspectLink'
import type { InspectRef } from '../../registry/inspectables'
import { Sparkline } from '../../Sparkline'
import type { TrafficCatalog } from '../../types'
import { callerTitle } from './logic'

/** The page's catalog when rendered inside the map (null in isolated renders). */
export function useCatalog(): TrafficCatalog | null {
  return useContext(TrafficMapContext)?.catalog ?? null
}

/** Readable name of a caller key (catalog label, else a plain fallback). */
export function callerName(cat: TrafficCatalog | null, key: string): string {
  return (
    cat?.callers[key]?.label ??
    (cat ? callerLabel(cat, key) : callerTitle({ kind: 'caller', id: key }))
  )
}

export function Block({
  title,
  aside,
  children,
  hook
}: {
  title: string
  aside?: ReactNode
  children: ReactNode
  hook?: string
}) {
  return (
    <section className='grid min-w-0 gap-1.5' data-tm-inspect-block={hook ?? title}>
      <div className='flex min-w-0 items-baseline justify-between gap-2'>
        <h3 className='text-[12px] font-medium text-[var(--tm-muted)]'>{title}</h3>
        {aside && <span className='shrink-0 text-[11.5px] text-[var(--tm-muted)]'>{aside}</span>}
      </div>
      {children}
    </section>
  )
}

/** Label / value pairs in two columns (values may be links or chips). */
export function Facts({ rows }: { rows: Array<[string, ReactNode] | null | false> }) {
  const shown = rows.filter((r): r is [string, ReactNode] => !!r)
  if (!shown.length) return null
  return (
    <dl className='grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[12px]'>
      {shown.map(([k, v]) => (
        <div key={k} className='contents'>
          <dt className='text-[var(--tm-muted)]'>{k}</dt>
          <dd className='min-w-0 break-words text-[var(--tm-fg)]'>{v}</dd>
        </div>
      ))}
    </dl>
  )
}

export function Muted({ children, hook }: { children: ReactNode; hook?: string }) {
  return (
    <p className='text-[12px] leading-snug text-[var(--tm-muted)]' data-tm-inspect-note={hook}>
      {children}
    </p>
  )
}

export function PanelLoading() {
  return (
    <div className='grid gap-2' aria-hidden='true' data-tm-inspect-loading=''>
      {[70, 92, 55, 80, 64].map((w) => (
        <div
          key={w}
          className='h-3.5 animate-pulse rounded bg-[var(--tm-skeleton)] motion-reduce:animate-none'
          style={{ width: `${w}%` }}
        />
      ))}
    </div>
  )
}

/** A failed level read, said plainly: not found, refused id, or the server's reason. */
export function PanelError({ error, what }: { error: unknown; what: string }) {
  const e = inspectErrorOf(error)
  const text =
    e.status === 404
      ? `No ${what} to show — it may have been deleted, or it is older than what this server keeps.`
      : e.status === 400
        ? `That is not a ${what} this panel can read.`
        : `The ${what} could not be read: ${e.message}`
  return (
    <p
      className='text-[12.5px] text-[var(--tm-muted)]'
      role='alert'
      data-tm-inspect-error={e.status ?? ''}
    >
      {text}
    </p>
  )
}

const STATUS_TONE = (s: number) =>
  s >= 500
    ? 'text-[var(--tm-error-ink)]'
    : s >= 400
      ? 'text-[var(--tm-update)]'
      : 'text-[var(--tm-fg-2)]'

export function Status({ status }: { status: number }) {
  return <span className={cn('tabular-nums', STATUS_TONE(status))}>{status || '—'}</span>
}

export interface RequestLine {
  at: unknown
  method: string
  path: string
  status: number
  ms: number
  request_id: string | null
  caller?: string
}

/**
 * One logged request. With a request id it drills into the request; without one it says why
 * (the row predates request ids, or came through the root /graphql alias).
 */
export function RequestRow({
  r,
  showCaller,
  cat
}: {
  r: RequestLine
  showCaller?: boolean
  cat?: TrafficCatalog | null
}) {
  const at = typeof r.at === 'string' || typeof r.at === 'number' ? r.at : ''
  const label = `${r.method} ${r.path}`
  const ref: InspectRef | null = r.request_id
    ? { kind: 'request', id: r.request_id, label, at: Date.parse(String(at)) || undefined }
    : null
  return (
    <li
      className='grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto_auto] items-baseline gap-x-2 text-[12px]'
      data-tm-inspect-request-row={r.request_id ?? ''}
    >
      <span className='tabular-nums text-[11px] text-[var(--tm-muted)]'>{fmtTime(at)}</span>
      <span className='min-w-0 truncate'>
        {ref ? (
          <InspectLink inspectRef={ref} className='font-mono text-[11px]'>
            {label}
          </InspectLink>
        ) : (
          <span
            className='font-mono text-[11px] text-[var(--tm-fg-2)]'
            data-tip='No request id on this log row — it was logged before request ids were recorded'
          >
            {label}
          </span>
        )}
        {showCaller && r.caller && (
          <>
            {' · '}
            <InspectLink
              inspectRef={{
                kind: 'caller',
                id: r.caller,
                label: callerName(cat ?? null, r.caller)
              }}
              className='text-[11.5px]'
            >
              {callerName(cat ?? null, r.caller)}
            </InspectLink>
          </>
        )}
      </span>
      <Status status={r.status} />
      <span className='tabular-nums text-[11px] text-[var(--tm-muted)]'>{fmtMs(r.ms)}</span>
    </li>
  )
}

export function RequestList({
  rows,
  showCaller,
  cat,
  empty,
  idsLogged
}: {
  rows: RequestLine[]
  showCaller?: boolean
  cat?: TrafficCatalog | null
  empty: string
  idsLogged?: boolean
}) {
  if (!rows.length) return <Muted>{empty}</Muted>
  const withoutIds = rows.every((r) => !r.request_id)
  return (
    <>
      <ul className='grid gap-1'>
        {rows.map((r, i) => (
          <RequestRow
            // biome-ignore lint/suspicious/noArrayIndexKey: log rows without ids repeat
            key={`${r.request_id ?? ''}:${i}`}
            r={r}
            showCaller={showCaller}
            cat={cat}
          />
        ))}
      </ul>
      {withoutIds && (
        <Muted hook='no-request-ids'>
          {idsLogged === false
            ? 'This database does not record request ids yet, so these rows cannot be opened one by one.'
            : 'None of these rows carries a request id (they were logged before request ids were recorded), so they cannot be opened one by one.'}
        </Muted>
      )}
    </>
  )
}

/** A compact spark with a caption; nothing when the series is empty or all zero. */
export function Spark({ data, caption }: { data: number[]; caption: string }) {
  if (!data.length || data.every((v) => !v)) return null
  return (
    <div className='grid gap-0.5' data-tm-inspect-spark=''>
      <Sparkline data={data} className='h-7 w-full' />
      <span className='text-[11px] text-[var(--tm-muted)]'>{caption}</span>
    </div>
  )
}

/** A big figure with a small label (the stat row at the top of a panel). */
export function Figure({
  label,
  value,
  tone
}: {
  label: string
  value: ReactNode
  tone?: 'error'
}) {
  return (
    <div className='grid min-w-0 gap-0.5 rounded-md border border-[var(--tm-line)] bg-[var(--tm-card)] px-2 py-1.5'>
      <span className='truncate text-[11px] text-[var(--tm-muted)]'>{label}</span>
      <span
        className={cn(
          'truncate text-[13.5px] font-semibold tabular-nums',
          tone === 'error' ? 'text-[var(--tm-error-ink)]' : 'text-[var(--tm-fg)]'
        )}
      >
        {value}
      </span>
    </div>
  )
}

export function Figures({ children }: { children: ReactNode }) {
  return (
    <div className='grid grid-cols-[repeat(auto-fit,minmax(88px,1fr))] gap-1.5'>{children}</div>
  )
}

/** The live map (model + window), re-read on every applied frame; null in isolated renders. */
export function useMapLive() {
  const ctx = useContext(TrafficMapContext)
  if (!ctx) return null
  return { model: ctx.model, win: ctx.win, tick: ctx.tick }
}

/** The map entity id of a collection (`items/x`, or `system/x` for nivaro_ / directus_ ones). */
export function collectionEntityId(collection: string): string {
  return /^(nivaro_|directus_|sys)/.test(collection)
    ? `system/${collection}`
    : `items/${collection}`
}
