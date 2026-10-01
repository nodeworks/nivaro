import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { cn } from '@/lib/utils'
import {
  callerLabel,
  entityLabel,
  fmtCount,
  fmtMs,
  fmtPct,
  fmtRate,
  KIND_INK,
  KIND_VAR
} from './EventTicker'
import type { TrafficModel } from './model'
import { downKindOf, downLabel } from './nodeKinds'
import { InspectorActions } from './registry/inspectorActions'
import { InspectorPanels } from './registry/inspectorPanels'
import { Sparkline } from './Sparkline'
import type {
  DownHistory,
  EntityHistory,
  Filters,
  Kind,
  Lane,
  Selection,
  SnapshotEntity,
  TrafficCatalog
} from './types'
import { KIND_ORDER, LANE_LABEL } from './types'

export { KIND_VAR }

export interface InspectorData {
  name: string
  type: string
  route: string
  rps: number
  p95: number
  errPct: number
  series: number[]
  /** [read, create, update, delete, error] in the window (deselected kinds read 0). */
  kinds: number[]
  routes: Array<{ route: string; n: number }>
  callers: Array<{ key: string; n: number }>
  errors: SnapshotEntity['recent_errors']
  writes: SnapshotEntity['recent_writes']
}

const SERIES_POINTS = 40
/** Inspector type line for group-C node kinds. */
const SOURCE_TYPE: Record<string, string> = {
  cron: 'scheduled job',
  flow: 'flow',
  import: 'staged-import worker',
  socket: 'browser sockets'
}
const DOWN_TYPE: Record<string, string> = {
  partner: 'Partner · declared by an extension',
  channel: 'Notification channel',
  ai: 'AI provider',
  webhook: 'Outgoing webhook'
}
const zeros = (n: number) => new Array<number>(n).fill(0)

function kindsOf(sums: number[], f: Filters): number[] {
  return KIND_ORDER.map((k, i) => (f.kinds.has(k) ? (sums[i + 1] ?? 0) : 0))
}

export function describeSelection(
  m: TrafficModel,
  sel: Selection,
  f: Filters,
  catalog: TrafficCatalog | null
): InspectorData {
  const win = f.win
  if (sel.kind === 'entity') {
    const meta = m.entityMeta(sel.id)
    const s = m.entitySum(sel.id, win)
    const cut = sel.id.indexOf('/')
    const lane = sel.id.slice(0, cut) as Lane
    const entity = sel.id.slice(cut + 1)
    return {
      name: entityLabel(catalog, lane, entity),
      type: `${LANE_LABEL[lane] ?? lane}${meta?.system ? ' · system collection' : ''}`,
      route: meta?.routes[0]?.route ?? '',
      rps: s[0] / win,
      p95: m.entityP95(sel.id),
      errPct: s[0] ? (100 * s[5]) / s[0] : Number.NaN,
      series: m.entitySeries(sel.id, win, SERIES_POINTS),
      kinds: kindsOf(s, f),
      routes: meta?.routes ?? [],
      callers: meta?.callers ?? [],
      errors: meta?.recent_errors ?? [],
      writes: meta?.recent_writes ?? []
    }
  }
  if (sel.kind === 'lane') {
    const keys = m.entityKeys().filter((k) => k.startsWith(`${sel.id}/`))
    const tot = zeros(6)
    const series = zeros(SERIES_POINTS)
    const routes = new Map<string, number>()
    const callers = new Map<string, number>()
    for (const k of keys) {
      const s = m.entitySum(k, win)
      for (let i = 0; i < 6; i++) tot[i] += s[i]
      const sr = m.entitySeries(k, win, SERIES_POINTS)
      for (let i = 0; i < SERIES_POINTS; i++) series[i] += sr[i] ?? 0
      const meta = m.entityMeta(k)
      for (const r of meta?.routes ?? []) routes.set(r.route, (routes.get(r.route) ?? 0) + r.n)
      for (const c of meta?.callers ?? []) callers.set(c.key, (callers.get(c.key) ?? 0) + c.n)
    }
    const top = (mm: Map<string, number>) => [...mm].sort((a, b) => b[1] - a[1]).slice(0, 5)
    return {
      name: LANE_LABEL[sel.id] ?? sel.id,
      type: `Lane · ${keys.length} ${keys.length === 1 ? 'entity' : 'entities'}`,
      route: '',
      rps: tot[0] / win,
      p95: Math.max(0, ...keys.map((k) => m.entityP95(k))),
      errPct: tot[0] ? (100 * tot[5]) / tot[0] : Number.NaN,
      series,
      kinds: kindsOf(tot, f),
      routes: top(routes).map(([route, n]) => ({ route, n })),
      callers: top(callers).map(([key, n]) => ({ key, n })),
      errors: keys
        .flatMap((k) => m.entityMeta(k)?.recent_errors ?? [])
        .sort((a, b) => b.at.localeCompare(a.at))
        .slice(0, 12),
      writes: keys
        .flatMap((k) => m.entityMeta(k)?.recent_writes ?? [])
        .sort((a, b) => b.at.localeCompare(a.at))
        .slice(0, 12)
    }
  }
  if (sel.kind === 'caller') {
    const [req, err] = m.callerSum(sel.id, win)
    const c = catalog?.callers[sel.id]
    const srcKind = sel.id.includes(':') ? sel.id.slice(0, sel.id.indexOf(':')) : null
    const keys = m
      .entityKeys()
      .filter((k) => (m.entityMeta(k)?.callers ?? []).some((x) => x.key === sel.id))
    return {
      name: callerLabel(catalog, sel.id),
      type: srcKind
        ? `Source · ${SOURCE_TYPE[srcKind] ?? srcKind}`
        : `Caller · ${c?.kind ?? 'person'}`,
      route: '',
      rps: req / win,
      p95: Math.max(0, ...keys.map((k) => m.entityP95(k))),
      errPct: req ? (100 * err) / req : Number.NaN,
      series: zeros(SERIES_POINTS),
      kinds: [req - err, 0, 0, 0, err],
      routes: keys
        .map((k) => ({
          route: k,
          n: m.entityMeta(k)?.callers.find((x) => x.key === sel.id)?.n ?? 0
        }))
        .sort((a, b) => b.n - a.n)
        .slice(0, 5),
      callers: [],
      errors: keys
        .flatMap((k) => (m.entityMeta(k)?.recent_errors ?? []).filter((e) => e.caller === sel.id))
        .sort((a, b) => b.at.localeCompare(a.at))
        .slice(0, 12),
      writes: keys
        .flatMap((k) => (m.entityMeta(k)?.recent_writes ?? []).filter((w) => w.caller === sel.id))
        .sort((a, b) => b.at.localeCompare(a.at))
        .slice(0, 12)
    }
  }
  const [req, err, p95] = m.downSum(sel.id, win)
  const keys = m.entityKeys().filter((k) => m.entityMeta(k)?.down?.[sel.id])
  const ext = sel.id.startsWith('ext:')
  const kind = downKindOf(m, sel.id)
  return {
    name:
      catalog?.down[sel.id] ??
      (ext ? catalog?.partners[sel.id.slice(4)] : undefined) ??
      downLabel(m, catalog, sel.id),
    type: ext
      ? 'External API'
      : (DOWN_TYPE[kind] ?? (['db', 'cache', 'storage'].includes(kind) ? 'Data store' : 'Service')),
    route: '',
    rps: req / win,
    p95,
    errPct: req ? (100 * err) / req : Number.NaN,
    series: zeros(SERIES_POINTS),
    kinds: [req - err, 0, 0, 0, err],
    routes: keys
      .map((k) => ({ route: k, n: m.entityMeta(k)?.down[sel.id] ?? 0 }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 5),
    callers: [],
    errors: [],
    writes: []
  }
}

export function Bar({
  label,
  n,
  max,
  color,
  mono = true
}: {
  label: string
  n: number
  max: number
  color?: string
  mono?: boolean
}) {
  const pct = max > 0 ? Math.min(100, (100 * n) / max) : 0
  return (
    <div className='grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-0.5 text-[12px]'>
      <span className={`min-w-0 truncate ${mono ? 'font-mono text-[11px]' : ''}`} title={label}>
        {label}
      </span>
      <span className='tabular-nums text-[var(--tm-fg-2)]'>{Math.round(n).toLocaleString()}</span>
      <span className='col-span-2 block h-1 overflow-hidden rounded-sm bg-[var(--tm-accent-soft)]'>
        <i
          className='block h-full'
          style={{ width: `${pct}%`, background: color ?? 'var(--tm-accent)' }}
        />
      </span>
    </div>
  )
}

export const t = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : d.toTimeString().slice(0, 8)
}

/** An inspector section (title + body) — plug-in panels use it too. */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className='border-t border-[var(--tm-line-2)] px-3.5 py-3 first:border-t-0'>
      <h3 className='mb-1.5 text-[12px] font-medium text-[var(--tm-muted)]'>{title}</h3>
      {children}
    </div>
  )
}
export const Empty = ({ children }: { children: ReactNode }) => (
  <p className='text-[12px] text-[var(--tm-muted)]'>{children}</p>
)

const PANEL =
  'min-w-0 rounded-lg border border-[var(--tm-line)] bg-[var(--tm-card)] min-[1100px]:sticky min-[1100px]:top-6'

/** Shown while the snapshot loads (skeleton) or when nothing is selected (teaching line). */
export function InspectorPlaceholder({ loading }: { loading: boolean }) {
  return (
    <aside className={PANEL} aria-label='Inspector' id='tm-inspector' aria-busy={loading}>
      {loading ? (
        <div className='grid gap-3 px-3.5 py-3' aria-hidden='true'>
          {[40, 24, 100, 70, 85, 60].map((w, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder lines
              key={i}
              className='h-3.5 animate-pulse rounded bg-[var(--tm-skeleton)] motion-reduce:animate-none'
              style={{ width: `${w}%` }}
            />
          ))}
        </div>
      ) : (
        <p className='px-3.5 py-4 text-[12.5px] text-[var(--tm-muted)]'>
          Select an entity on the map or in the table.
        </p>
      )}
    </aside>
  )
}

export type Hours = 0 | 1 | 6 | 24
export const HOURS: Hours[] = [0, 1, 6, 24]
export type HistoryState = 'idle' | 'loading' | 'error'

/** History is read from the request / outbound logs; lanes and callers have no history route. */
export function historyAvailable(sel: Selection | null): boolean {
  if (!sel) return false
  if (sel.kind === 'down') return true
  // `__other__` folds many entities; `__background__` has no request rows behind it.
  // socket events never reach the request log
  return (
    sel.kind === 'entity' &&
    !sel.id.endsWith('/__other__') &&
    !sel.id.endsWith('/__background__') &&
    !sel.id.startsWith('socket/')
  )
}
export function historyUrl(sel: Selection, hours: Hours): string {
  if (sel.kind === 'entity') {
    const cut = sel.id.indexOf('/')
    const lane = sel.id.slice(0, cut)
    const entity = sel.id.slice(cut + 1)
    return `/traffic-map/entity/${lane}/${encodeURIComponent(entity)}?hours=${hours}`
  }
  return `/traffic-map/down/${encodeURIComponent(sel.id)}?hours=${hours}`
}
export function hoursPhrase(h: Hours): string {
  return h === 1 ? 'last hour' : `last ${h} hours`
}
function bucketPhrase(bucketS: number | undefined): string {
  if (!bucketS || bucketS <= 60) return 'minute'
  return `${Math.round(bucketS / 60)} minutes`
}

export interface InspectorHistory {
  hours: Hours
  onHours: (h: Hours) => void
  /** Selection has a history route (entity or down node). */
  available: boolean
  data: EntityHistory | DownHistory | null
  state: HistoryState
  error?: string | null
  onRetry: () => void
}

const SEG =
  'px-2.5 py-[3px] text-[12px] font-medium leading-tight transition-colors duration-150 ease-out focus-visible:relative focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan'
const LINK =
  'rounded-sm text-[var(--tm-accent-ink)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'

function HoursBar({ hours, onHours }: { hours: Hours; onHours: (h: Hours) => void }) {
  return (
    <div className='flex items-center gap-2 border-b border-[var(--tm-line-2)] px-3.5 py-2'>
      <span id='tm-hours-label' className='text-[12px] font-medium text-[var(--tm-muted)]'>
        Range
      </span>
      <fieldset
        className='inline-flex min-w-0 overflow-hidden rounded-md border border-[var(--tm-line)]'
        aria-labelledby='tm-hours-label'
      >
        {HOURS.map((h, i) => {
          const on = hours === h
          return (
            <button
              key={h}
              type='button'
              id={h === 0 ? 'tm-hours-live' : `tm-hours-${h}`}
              aria-pressed={on}
              onClick={() => onHours(h)}
              className={cn(
                SEG,
                i > 0 && 'border-l border-[var(--tm-line)]',
                on
                  ? 'bg-[var(--tm-accent-soft)] text-[var(--tm-accent-ink)]'
                  : 'bg-[var(--tm-card)] text-[var(--tm-fg-2)] hover:bg-[var(--tm-card-2)]'
              )}
            >
              {h === 0 ? 'Live' : `${h}h`}
            </button>
          )
        })}
      </fieldset>
      {hours > 0 && (
        <span className='ml-auto truncate text-[11.5px] text-[var(--tm-muted)]'>
          From the request log
        </span>
      )}
    </div>
  )
}

function Facts({ facts }: { facts: Array<[string, string, boolean, string?]> }) {
  return (
    <div className='grid grid-cols-3 divide-x divide-[var(--tm-line-2)] border-b border-[var(--tm-line-2)]'>
      {facts.map(([k, v, bad, testId]) => (
        <div key={k} className='min-w-0 px-3.5 py-2'>
          <div className='truncate text-[12px] font-medium text-[var(--tm-muted)]'>{k}</div>
          <div
            className={`text-[15px] font-semibold tabular-nums ${bad ? 'text-[var(--tm-error-ink)]' : ''}`}
            data-testid={testId}
          >
            {v}
          </div>
        </div>
      ))}
    </div>
  )
}

const SEVERITY_INK: Record<string, string> = {
  critical: 'var(--tm-error-ink)',
  high: 'var(--tm-error-ink)',
  error: 'var(--tm-error-ink)',
  medium: 'var(--tm-update)',
  warning: 'var(--tm-update)'
}

function HistorySkeleton() {
  return (
    <div className='grid gap-3 px-3.5 py-3' aria-hidden='true' data-testid='tm-history-loading'>
      {[90, 100, 60, 75, 85, 50].map((w, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder lines
          key={i}
          className='h-3.5 animate-pulse rounded bg-[var(--tm-skeleton)] motion-reduce:animate-none'
          style={{ width: `${w}%` }}
        />
      ))}
    </div>
  )
}

function HistoryBody({
  h,
  catalog,
  selKey
}: {
  h: InspectorHistory
  catalog: TrafficCatalog | null
  selKey: string
}) {
  const span = hoursPhrase(h.hours)
  if (h.state === 'error') {
    return (
      <div className='px-3.5 py-3'>
        <div
          role='alert'
          id='tm-history-error'
          className='grid gap-2 rounded-md border border-[var(--tm-error)] bg-[var(--tm-error-soft)] px-3 py-2 text-[12.5px]'
        >
          <span>
            The history for the {span} could not be loaded.
            {h.error ? (
              <>
                {' '}
                <span className='font-mono text-[11.5px] text-[var(--tm-fg-2)]'>{h.error}</span>
              </>
            ) : null}
          </span>
          <button
            type='button'
            id='tm-history-retry'
            onClick={h.onRetry}
            className='w-fit rounded-md border border-[var(--tm-line)] bg-[var(--tm-card)] px-2.5 py-[3px] text-[12px] font-medium text-[var(--tm-fg-2)] transition-colors duration-150 ease-out hover:bg-[var(--tm-card-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan focus-visible:ring-offset-2'
          >
            Retry
          </button>
        </div>
      </div>
    )
  }
  const data = h.data
  if (!data) return <HistorySkeleton />
  const eh = 'top_routes' in data ? (data as EntityHistory) : null
  const dh = eh ? null : (data as DownHistory)
  if (dh?.note) {
    return (
      <div className='grid gap-2 px-3.5 py-3 text-[12.5px]' id='tm-history-note'>
        <p className='text-[var(--tm-fg-2)]'>{dh.note}</p>
        {(selKey === 'db' || selKey === 'redis' || selKey === 'store') && (
          <Link to='/db-health' id='tm-history-db-health' className={cn(LINK, 'w-fit text-[12px]')}>
            Open DB Health
          </Link>
        )}
      </div>
    )
  }
  const req = eh ? eh.totals.req : (dh?.totals?.req ?? 0)
  const err = eh ? eh.totals.error : (dh?.totals?.error ?? 0)
  const p95 = eh ? eh.totals.p95 : Math.max(0, ...(dh?.series ?? []).map((s) => s.p95))
  const errPct = req ? (100 * err) / req : Number.NaN
  const facts: Array<[string, string, boolean, string?]> = [
    ['Requests', fmtCount(req), false, 'tm-inspector-req'],
    [eh ? 'p95' : 'Worst p95', fmtMs(p95), false],
    ['Errors', fmtPct(errPct), errPct >= 3]
  ]
  const codes = Object.entries(data.status_codes ?? {}).sort((a, b) => b[1] - a[1])
  const routes = eh ? eh.top_routes : (dh?.top_paths ?? []).map((p) => ({ route: p.path, n: p.n }))
  const empty = `Nothing in the ${span}.`
  return (
    <>
      <Facts facts={facts} />
      <div className='px-3.5 pb-1 pt-3'>
        <Sparkline data={data.series.map((s) => s.req)} className='block h-11 w-full' />
        <div className='mt-1 flex flex-wrap justify-between gap-x-3 text-[11.5px] text-[var(--tm-muted)]'>
          <span>
            Requests per {bucketPhrase(data.bucket_s)} · {span}
          </span>
          {eh && (
            <span className='tabular-nums'>
              {fmtCount(eh.totals.read)} reads · {fmtCount(eh.totals.write_requests)} writes
            </span>
          )}
        </div>
        {data.truncated && (
          <p className='mt-1 text-[11.5px] text-[var(--tm-muted)]' id='tm-history-truncated'>
            Showing the newest 20,000 requests; older ones in this range are not counted.
          </p>
        )}
        {selKey.startsWith('graphql/') && (
          <p className='mt-1 text-[11.5px] text-[var(--tm-muted)]'>
            Calls through the root /graphql alias can log without an operation name and count under
            anonymous.
          </p>
        )}
      </div>
      <Section title='Status codes'>
        <div className='flex flex-wrap gap-1.5'>
          {codes.length ? (
            codes.map(([code, n]) => {
              const bad = code === 'network' || Number(code) >= 400
              return (
                <span
                  key={code}
                  className={cn(
                    'inline-flex items-baseline gap-1.5 rounded-md border px-1.5 py-0.5 text-[11.5px] tabular-nums',
                    bad
                      ? 'border-[color-mix(in_srgb,var(--tm-error)_45%,var(--tm-line))] bg-[var(--tm-error-soft)]'
                      : 'border-[var(--tm-line)]'
                  )}
                >
                  <span
                    className={cn('font-mono font-medium', bad && 'text-[var(--tm-error-ink)]')}
                  >
                    {code}
                  </span>
                  <span className='text-[var(--tm-fg)]'>{fmtCount(n)}</span>
                </span>
              )
            })
          ) : (
            <Empty>{empty}</Empty>
          )}
        </div>
      </Section>
      <Section title={eh ? 'Top routes' : 'Top paths'}>
        <div className='grid gap-1.5'>
          {routes.length ? (
            routes.map((r) => <Bar key={r.route} label={r.route} n={r.n} max={routes[0].n} />)
          ) : (
            <Empty>{empty}</Empty>
          )}
        </div>
      </Section>
      {eh && (
        <>
          <Section title='Top callers'>
            <div className='grid gap-1.5'>
              {eh.top_callers.length ? (
                eh.top_callers.map((c) => (
                  <Bar
                    key={c.key}
                    label={callerLabel(catalog, c.key)}
                    n={c.n}
                    max={eh.top_callers[0].n}
                    mono={false}
                  />
                ))
              ) : (
                <Empty>{empty}</Empty>
              )}
            </div>
          </Section>
          <Section title='Open issues on this route family'>
            <div className='grid gap-1 text-[12px]'>
              {eh.issues.length ? (
                eh.issues.map((i) => (
                  <Link
                    key={i.id}
                    to={`/issues/${i.id}`}
                    id={`tm-issue-${i.id}`}
                    title={i.title}
                    className={cn(
                      LINK,
                      'grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-2'
                    )}
                  >
                    <span
                      className='text-[11px] font-medium'
                      style={{ color: SEVERITY_INK[i.severity] ?? 'var(--tm-muted)' }}
                    >
                      {i.severity}
                    </span>
                    <span className='min-w-0 truncate'>{i.title}</span>
                    <span className='tabular-nums text-[var(--tm-muted)]'>
                      ×{fmtCount(i.occurrence_count)}
                    </span>
                  </Link>
                ))
              ) : (
                <Empty>No open server issues name this route family.</Empty>
              )}
            </div>
          </Section>
          <Section title='Slow requests'>
            <div className='grid gap-1 text-[12px]'>
              {eh.slow_traces.length ? (
                eh.slow_traces.map((s) => (
                  <Link
                    key={s.id}
                    to='/api-analytics'
                    id={`tm-slow-${s.id}`}
                    title={s.route}
                    className={cn(
                      LINK,
                      'grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-2'
                    )}
                  >
                    <span className='font-mono text-[10.5px] tabular-nums text-[var(--tm-muted)]'>
                      {t(s.ts)}
                    </span>
                    <span className='min-w-0 truncate font-mono text-[11px]'>{s.route}</span>
                    <span className='tabular-nums'>{fmtMs(s.total_ms)}</span>
                  </Link>
                ))
              ) : (
                <Empty>None over the slow-request threshold kept on this node.</Empty>
              )}
            </div>
          </Section>
        </>
      )}
    </>
  )
}

export function Inspector({
  d,
  catalog,
  history,
  selKey = '',
  sel,
  children
}: {
  d: InspectorData
  catalog: TrafficCatalog | null
  history?: InspectorHistory
  /** Selection key (`<lane>/<entity>` or a down id), for history notes. */
  selKey?: string
  /** The current selection — plug-in actions and panels (registry/) need it. */
  sel?: Selection
  children?: ReactNode
}) {
  const showHistory = !!history?.available && history.hours > 0
  const kindsMax = Math.max(1, ...d.kinds)
  const facts: Array<[string, string, boolean, string?]> = [
    ['Requests/s', fmtRate(d.rps), false],
    ['p95', fmtMs(d.p95), false],
    ['Errors', fmtPct(d.errPct), d.errPct >= 3]
  ]
  return (
    <aside className={PANEL} aria-label='Inspector' id='tm-inspector'>
      <div className='flex items-start justify-between gap-3 border-b border-[var(--tm-line-2)] px-3.5 py-2.5'>
        <div className='min-w-0'>
          <h2
            className='truncate font-mono text-[13.5px] font-semibold'
            data-testid='tm-inspector-name'
            title={d.name}
          >
            {d.name}
          </h2>
          <div className='mt-0.5 text-[12px] text-[var(--tm-muted)]'>{d.type}</div>
        </div>
        {d.route && (
          <span
            className='max-w-[55%] truncate pt-0.5 font-mono text-[11px] text-[var(--tm-muted)]'
            title={d.route}
          >
            {d.route}
          </span>
        )}
      </div>
      {sel && <InspectorActions sel={sel} d={d} />}
      {children}
      {history?.available && <HoursBar hours={history.hours} onHours={history.onHours} />}
      {showHistory && history ? (
        <>
          <HistoryBody h={history} catalog={catalog} selKey={selKey} />
          {sel && <InspectorPanels sel={sel} d={d} mode='history' />}
        </>
      ) : (
        <>
          <Facts facts={facts} />
          <div className='px-3.5 pb-1 pt-3'>
            <Sparkline data={d.series} className='block h-11 w-full' />
          </div>
          <Section title='Kinds in window'>
            <div className='grid gap-1.5'>
              {KIND_ORDER.map((k: Kind, i) => (
                <Bar
                  key={k}
                  label={k}
                  n={d.kinds[i] ?? 0}
                  max={kindsMax}
                  color={KIND_VAR[k]}
                  mono={false}
                />
              ))}
            </div>
          </Section>
          <Section title='Top routes'>
            <div className='grid gap-1.5'>
              {d.routes.length ? (
                d.routes.map((r) => (
                  <Bar key={r.route} label={r.route} n={r.n} max={d.routes[0].n} />
                ))
              ) : (
                <Empty>Nothing in this window.</Empty>
              )}
            </div>
          </Section>
          <Section title='Top callers'>
            <div className='grid gap-1.5'>
              {d.callers.length ? (
                d.callers.map((c) => (
                  <Bar
                    key={c.key}
                    label={callerLabel(catalog, c.key)}
                    n={c.n}
                    max={d.callers[0].n}
                    mono={false}
                  />
                ))
              ) : (
                <Empty>Nothing in this window.</Empty>
              )}
            </div>
          </Section>
          <Section title='Recent errors'>
            <div className='grid gap-1 text-[11.5px]'>
              {d.errors.length ? (
                d.errors.slice(0, 6).map((e, i) => (
                  <div
                    // biome-ignore lint/suspicious/noArrayIndexKey: errors can share a timestamp
                    key={`${e.at}-${i}`}
                    className='grid min-w-0 grid-cols-[auto_auto_minmax(0,1fr)] items-baseline gap-2'
                  >
                    <span className='font-mono text-[10.5px] tabular-nums text-[var(--tm-muted)]'>
                      {t(e.at)}
                    </span>
                    <span className='font-mono font-medium tabular-nums text-[var(--tm-error-ink)]'>
                      {e.status}
                    </span>
                    <span
                      className='min-w-0 truncate'
                      title={`${e.code ?? 'error'} · ${e.route}${e.record ? ` · ${e.record}` : ''}`}
                    >
                      <span className='font-mono text-[11px]'>{e.code ?? 'error'}</span>
                      {' · '}
                      <span className='font-mono text-[11px]'>{e.route}</span>
                      {e.record ? (
                        <>
                          {' · '}
                          <span className='font-mono text-[11px]'>{e.record}</span>
                        </>
                      ) : null}
                      <span className='text-[var(--tm-muted)]'>
                        {' '}
                        · {callerLabel(catalog, e.caller)}
                      </span>
                    </span>
                  </div>
                ))
              ) : (
                <Empty>No errors recently.</Empty>
              )}
            </div>
          </Section>
          <Section title='Recent writes'>
            <div className='grid gap-1 text-[11.5px]'>
              {d.writes.length ? (
                d.writes.slice(0, 6).map((w, i) => (
                  <div
                    // biome-ignore lint/suspicious/noArrayIndexKey: writes can share a timestamp
                    key={`${w.at}-${i}`}
                    className='grid min-w-0 grid-cols-[auto_auto_minmax(0,1fr)] items-baseline gap-2'
                  >
                    <span className='font-mono text-[10.5px] tabular-nums text-[var(--tm-muted)]'>
                      {t(w.at)}
                    </span>
                    <span className='font-medium' style={{ color: KIND_INK[w.action] }}>
                      {w.action}
                    </span>
                    <span className='min-w-0 truncate'>
                      <span className='font-mono text-[11px]'>{w.record}</span>
                      {w.fields.length ? (
                        <>
                          {' · '}
                          <span className='font-mono text-[11px] text-[var(--tm-fg-2)]'>
                            {w.fields.join(', ')}
                          </span>
                        </>
                      ) : null}
                      <span className='text-[var(--tm-muted)]'>
                        {' '}
                        · {callerLabel(catalog, w.caller)}
                      </span>
                    </span>
                  </div>
                ))
              ) : (
                <Empty>No writes recently.</Empty>
              )}
            </div>
          </Section>
          {sel && <InspectorPanels sel={sel} d={d} mode='live' />}
        </>
      )}
    </aside>
  )
}
