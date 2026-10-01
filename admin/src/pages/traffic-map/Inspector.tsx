import type { ReactNode } from 'react'
import { callerLabel, entityLabel, fmtMs, fmtPct, fmtRate, KIND_INK, KIND_VAR } from './EventTicker'
import type { TrafficModel } from './model'
import { Sparkline } from './Sparkline'
import type { Filters, Kind, Lane, Selection, SnapshotEntity, TrafficCatalog } from './types'
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
    const keys = m
      .entityKeys()
      .filter((k) => (m.entityMeta(k)?.callers ?? []).some((x) => x.key === sel.id))
    return {
      name: callerLabel(catalog, sel.id),
      type: `Caller · ${c?.kind ?? 'person'}`,
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
  return {
    name:
      catalog?.down[sel.id] ??
      (ext ? catalog?.partners[sel.id.slice(4)] : undefined) ??
      m.downLabels.get(sel.id) ??
      sel.id,
    type: ext ? 'External API' : 'Data store',
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

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className='border-t border-[var(--tm-line-2)] px-3.5 py-3 first:border-t-0'>
      <h3 className='mb-1.5 text-[12px] font-medium text-[var(--tm-muted)]'>{title}</h3>
      {children}
    </div>
  )
}
const Empty = ({ children }: { children: ReactNode }) => (
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

export function Inspector({
  d,
  catalog,
  children
}: {
  d: InspectorData
  catalog: TrafficCatalog | null
  children?: ReactNode
}) {
  const kindsMax = Math.max(1, ...d.kinds)
  const facts: Array<[string, string, boolean]> = [
    ['Requests/s', fmtRate(d.rps), false],
    ['p95', fmtMs(d.p95), false],
    ['Errors', fmtPct(d.errPct), d.errPct >= 5]
  ]
  return (
    <aside className={PANEL} aria-label='Inspector' aria-live='polite' id='tm-inspector'>
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
      {children}
      <div className='grid grid-cols-3 divide-x divide-[var(--tm-line-2)] border-b border-[var(--tm-line-2)]'>
        {facts.map(([k, v, bad]) => (
          <div key={k} className='min-w-0 px-3.5 py-2'>
            <div className='text-[12px] font-medium text-[var(--tm-muted)]'>{k}</div>
            <div
              className={`text-[15px] font-semibold tabular-nums ${bad ? 'text-[var(--tm-error-ink)]' : ''}`}
            >
              {v}
            </div>
          </div>
        ))}
      </div>
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
            d.routes.map((r) => <Bar key={r.route} label={r.route} n={r.n} max={d.routes[0].n} />)
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
    </aside>
  )
}
