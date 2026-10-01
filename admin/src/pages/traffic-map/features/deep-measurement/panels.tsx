import { useQuery } from '@tanstack/react-query'
import { useContext } from 'react'
import { Link } from 'react-router'
import { api } from '@/lib/api'
import { TrafficMapContext, useTrafficMap } from '../../context'
import { callerLabel, fmtCount, fmtMs } from '../../EventTicker'
import { Bar, Empty, Section } from '../../Inspector'
import type { Selection } from '../../types'
import {
  breakdownSegments,
  collectionOfKey,
  DERIVED_LABEL,
  type EntityDetail,
  FIELD_HEAT,
  fmtMsFine,
  fmtShare,
  fmtTrips,
  GRAPHQL_FIELDS,
  HOT_RECORDS,
  READ_SHAPES,
  REQUEST_COST,
  recordHref,
  tripsFor,
  typeIsCollection
} from './logic'

/** One poll of GET /traffic-map/entity-detail per selected entity, shared by every panel. */
export function useEntityDetail(sel: Selection) {
  const { win, paused } = useTrafficMap()
  const key = sel.kind === 'entity' ? sel.id : null
  return useQuery({
    queryKey: ['traffic-map', 'entity-detail', key, win],
    queryFn: () =>
      api
        .get('/traffic-map/entity-detail', { params: { key, window: win } })
        .then((r) => (r.data?.data ?? {}) as EntityDetail),
    enabled: !!key,
    refetchInterval: paused ? false : 5000,
    staleTime: 4000
  })
}

const MONO = 'font-mono text-[11px]'
const CHIP =
  'inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium leading-none tabular-nums'
const WARN_CHIP = `${CHIP} border border-[var(--tm-update)] text-[var(--tm-fg)]`

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className='min-w-0' title={hint}>
      <div className='text-[11px] text-[var(--tm-muted)]'>{label}</div>
      <div className='truncate text-[13px] font-medium tabular-nums text-[var(--tm-fg)]'>
        {value}
      </div>
    </div>
  )
}

function windowWords(s: number): string {
  return s >= 900 ? '15 min' : s >= 300 ? '5 min' : '1 min'
}

// ── #1108 / #1151 / #1146 — request cost ─────────────────────────────────────
export function RequestCostPanel({ sel }: { sel: Selection }) {
  const { model, tick } = useTrafficMap()
  const q = useEntityDetail(sel)
  const d = q.data?.[REQUEST_COST]
  void tick
  const live = sel.kind === 'entity' ? tripsFor(model, sel.id) : null
  if (!d) {
    return (
      <Section title='Request cost'>
        <Empty>
          {q.isLoading
            ? 'Loading…'
            : 'No measured requests in this window (only /api reads and writes are timed).'}
        </Empty>
      </Section>
    )
  }
  const segs = breakdownSegments(d.breakdown)
  return (
    <Section title='Request cost'>
      <div data-tm-cost={sel.id} className='grid gap-3'>
        <div className='grid grid-cols-3 gap-2'>
          <Stat
            label='Round trips'
            value={`${fmtTrips(d.avg_trips)} / req`}
            hint={`Average SQL statements per request over ${windowWords(d.window_s)} (${fmtCount(d.n)} requests). Live last minute: ${live != null ? fmtTrips(live) : '—'}`}
          />
          <Stat
            label='SQL time'
            value={fmtShare(d.sql_share)}
            hint={`${fmtMs(d.avg_sql_ms)} of ${fmtMs(d.avg_ms)} per request waiting on the database`}
          />
          <Stat label='Per request' value={fmtMs(d.avg_ms)} />
        </div>
        {d.n_plus_one && (
          <p data-tm-n-plus-one='' className='text-[12px] text-[var(--tm-fg-2)]'>
            <span className={WARN_CHIP}>N+1</span> These requests average {fmtTrips(d.avg_trips)}{' '}
            round trips, over the {d.threshold} the map flags — one statement per row is the usual
            cause.
          </p>
        )}
        <div>
          <div className='mb-1 flex items-baseline justify-between text-[11.5px] text-[var(--tm-muted)]'>
            <span>Where the time goes</span>
            <span className='tabular-nums'>{fmtMs(d.avg_ms)} avg</span>
          </div>
          <div
            className='flex h-2.5 w-full overflow-hidden rounded-sm bg-[var(--tm-line-2)]'
            role='img'
            aria-label={segs
              .filter((s) => s.ms > 0)
              .map((s) => `${s.label} ${fmtMs(s.ms)}`)
              .join(', ')}
          >
            {segs.map((s) =>
              s.pct > 0 ? (
                <i
                  key={s.id}
                  data-tm-breakdown-seg={s.id}
                  className='block h-full'
                  style={{ width: `${s.pct}%`, background: s.color }}
                  title={`${s.label}: ${fmtMs(s.ms)} (${Math.round(s.pct)}%)`}
                />
              ) : null
            )}
          </div>
          <ul className='mt-1.5 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11.5px] text-[var(--tm-fg-2)]'>
            {segs.map((s) => (
              <li key={s.id} className='flex min-w-0 items-center gap-1.5'>
                <i className='h-2 w-2 shrink-0 rounded-sm' style={{ background: s.color }} />
                <span className='truncate'>{s.label}</span>
                <span className='ml-auto tabular-nums'>{fmtMsFine(s.ms)}</span>
              </li>
            ))}
          </ul>
          <p className='mt-1 text-[11px] text-[var(--tm-muted)]'>
            Auth, metadata and hooks include the SQL they ran; Query SQL is the rest of the database
            wait.
          </p>
        </div>
        <div data-tm-access='' className='text-[12px] text-[var(--tm-fg-2)]'>
          {d.access.checked > 0 ? (
            <>
              Access checks (row filters, User Scopes) add {fmtMsFine(d.access.avg_ms)} on the{' '}
              {fmtCount(d.access.checked)} requests that ran them — {fmtShare(d.access.share)} of
              this entity's time.
            </>
          ) : (
            <span className='text-[var(--tm-muted)]'>
              No row-filter or User Scope checks ran in this window.
            </span>
          )}
        </div>
        {d.repeat && (
          <div data-tm-repeat='' className='grid gap-1'>
            <p className='text-[12px] text-[var(--tm-fg-2)]'>
              {fmtShare(d.repeat.share)} of requests ran one statement {d.repeat.n}× in a single
              phase:
            </p>
            {d.repeat.sql && (
              <code className='block max-h-24 overflow-auto whitespace-pre-wrap break-all rounded bg-[var(--tm-card-2)] px-2 py-1.5 font-mono text-[11px] text-[var(--tm-fg)]'>
                {d.repeat.sql}
              </code>
            )}
          </div>
        )}
      </div>
    </Section>
  )
}

// ── #1145 — write amplification ──────────────────────────────────────────────
export function AmplificationPanel({ sel }: { sel: Selection }) {
  const q = useEntityDetail(sel)
  const a = q.data?.[REQUEST_COST]?.amplification
  if (!a) return null
  const kinds = Object.entries(a.derived).filter(([, n]) => n > 0)
  return (
    <Section title='Write amplification'>
      <div data-tm-amplification={sel.id} className='grid gap-2 text-[12px]'>
        <p className='text-[var(--tm-fg-2)]'>
          {a.factor != null ? (
            <>
              Each direct write caused{' '}
              <span data-tm-amp-factor='' className='font-medium tabular-nums text-[var(--tm-fg)]'>
                {a.factor}
              </span>{' '}
              more ({fmtCount(a.derived_total)} derived from {fmtCount(a.direct)} direct writes in{' '}
              {fmtCount(a.write_requests)} requests).
            </>
          ) : (
            <>{fmtCount(a.derived_total)} derived writes without a direct write of its own.</>
          )}
        </p>
        {kinds.length > 0 && (
          <div className='grid gap-1.5'>
            {kinds
              .sort((x, y) => y[1] - x[1])
              .map(([k, n]) => (
                <Bar
                  key={k}
                  label={DERIVED_LABEL[k] ?? k}
                  n={n}
                  max={Math.max(...kinds.map((x) => x[1]))}
                  mono={false}
                />
              ))}
          </div>
        )}
      </div>
    </Section>
  )
}

// ── #1135 — filter and sort shapes ───────────────────────────────────────────
export function ReadShapesPanel({ sel }: { sel: Selection }) {
  const q = useEntityDetail(sel)
  const d = q.data?.[READ_SHAPES]
  if (!d) return null
  return (
    <Section title='Filter and sort shapes'>
      <div data-tm-shapes={sel.id} className='grid gap-3'>
        <div className='grid gap-1.5'>
          {d.shapes.map((s) => (
            <Bar key={s.shape} label={s.shape} n={s.n} max={d.shapes[0]?.n ?? 1} />
          ))}
        </div>
        {d.columns.length > 0 && (
          <div className='grid gap-1'>
            <div className='text-[11.5px] text-[var(--tm-muted)]'>Columns callers use</div>
            {d.columns.map((c) => (
              <div
                key={c.path}
                data-tm-shape-col={c.path}
                className='grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-baseline gap-2 text-[12px]'
              >
                <span className='min-w-0 truncate'>
                  <span className={MONO}>{c.path}</span>
                  {c.ops.length > 0 && (
                    <span className='text-[var(--tm-muted)]'> · {c.ops.join(', ')}</span>
                  )}
                </span>
                <span className='flex items-center gap-1.5 whitespace-nowrap tabular-nums text-[var(--tm-fg-2)]'>
                  {c.filter > 0 && <span>{fmtCount(c.filter)} filter</span>}
                  {c.sort > 0 && <span>{fmtCount(c.sort)} sort</span>}
                  {c.indexed === false && (
                    <span data-tm-shape-unindexed='' className={WARN_CHIP}>
                      no index
                    </span>
                  )}
                </span>
              </div>
            ))}
            {d.columns.some((c) => c.indexed === false) && (
              <p className='mt-1 text-[11.5px] text-[var(--tm-muted)]'>
                The{' '}
                <Link to='/api-analytics' className='text-[var(--tm-accent-ink)] underline'>
                  index advisor
                </Link>{' '}
                lists these as live evidence on large tables.
              </p>
            )}
          </div>
        )}
      </div>
    </Section>
  )
}

// ── #1134 — GraphQL field heat ───────────────────────────────────────────────
export function GraphqlFieldsPanel({ sel }: { sel: Selection }) {
  const { catalog } = useTrafficMap()
  const q = useEntityDetail(sel)
  const d = q.data?.[GRAPHQL_FIELDS]
  if (!d) return null
  return (
    <Section title='Fields this operation selects'>
      <div data-tm-gql-fields={sel.id} className='grid gap-3'>
        <div className='grid gap-1.5'>
          {d.fields.slice(0, 15).map((f) => (
            <div key={f.field} className='grid gap-0.5'>
              <Bar label={f.field} n={f.n} max={d.fields[0]?.n ?? 1} />
              {f.callers.length > 0 && (
                <span className='truncate text-[11px] text-[var(--tm-muted)]'>
                  {f.callers.map((c) => `${callerLabel(catalog, c.key)} ${c.n}`).join(' · ')}
                </span>
              )}
            </div>
          ))}
        </div>
        {d.types.some((t) => t.unused.length > 0) && (
          <div className='grid gap-2'>
            <p className='text-[11.5px] text-[var(--tm-muted)]'>
              Not selected by any caller in the last {windowWords(d.unused_window_s)} on this
              process — deprecation candidates, not proof.
            </p>
            {d.types
              .filter((t) => t.unused.length > 0)
              .map((t) => (
                <div key={t.type} data-tm-gql-unused={t.type} className='grid gap-1 text-[12px]'>
                  <div className='flex items-baseline justify-between gap-2'>
                    {typeIsCollection(t.type) ? (
                      <Link
                        to={`/data-model/${encodeURIComponent(t.type)}`}
                        className={`${MONO} text-[var(--tm-accent-ink)] underline`}
                        title='Open in the Table Editor — field ⚙ → Behavior marks a field deprecated'
                      >
                        {t.type}
                      </Link>
                    ) : (
                      <span className={MONO}>{t.type}</span>
                    )}
                    <span className='tabular-nums text-[var(--tm-fg-2)]'>
                      {t.selected} of {t.total} used
                    </span>
                  </div>
                  <p className={`${MONO} break-words text-[var(--tm-fg-2)]`}>
                    {t.unused.join(', ')}
                  </p>
                </div>
              ))}
          </div>
        )}
      </div>
    </Section>
  )
}

// ── #1136 — field change heat ────────────────────────────────────────────────
export function FieldHeatPanel({ sel }: { sel: Selection }) {
  const { catalog } = useTrafficMap()
  const q = useEntityDetail(sel)
  const d = q.data?.[FIELD_HEAT]
  if (!d) return null
  return (
    <Section title='Fields that change most'>
      <div data-tm-field-heat={sel.id} className='grid gap-1.5'>
        {d.fields.map((f) => (
          <div key={f.field} className='grid gap-0.5'>
            <Bar
              label={`${f.field} · ${fmtShare(f.share)} of writes`}
              n={f.n}
              max={d.fields[0]?.n ?? 1}
            />
            {f.callers.length > 0 && (
              <span className='truncate text-[11px] text-[var(--tm-muted)]'>
                {f.callers.map((c) => `${callerLabel(catalog, c.key)} ${c.n}`).join(' · ')}
              </span>
            )}
          </div>
        ))}
        <p className='text-[11px] text-[var(--tm-muted)]'>
          {fmtCount(d.writes)} writes in the window.
        </p>
      </div>
    </Section>
  )
}

// ── #1119 — hot records ──────────────────────────────────────────────────────
export function HotRecordsPanel({ sel }: { sel: Selection }) {
  const q = useEntityDetail(sel)
  const d = q.data?.[HOT_RECORDS]
  if (!d || d.rows.length === 0) return null
  return (
    <Section title='Hot records right now'>
      <table data-tm-hot-records={sel.id} className='w-full table-fixed text-[12px]'>
        <thead>
          <tr className='text-left text-[11px] text-[var(--tm-muted)]'>
            <th className='pb-1 font-medium'>Record</th>
            <th className='w-12 pb-1 text-right font-medium'>Writes</th>
            <th className='w-10 pb-1 text-right font-medium' title='409 conflicts'>
              409s
            </th>
            <th className='w-24 pb-1 text-right font-medium'>Lock</th>
          </tr>
        </thead>
        <tbody>
          {d.rows.map((r) => (
            <tr key={r.id} data-tm-hot-record={r.id} className='border-t border-[var(--tm-line-2)]'>
              <td className='min-w-0 py-1 pr-2'>
                <Link
                  to={recordHref(d.collection, r.id)}
                  className='block truncate text-[var(--tm-accent-ink)] underline'
                  title={`Open ${d.collection} ${r.id}`}
                >
                  {r.label ?? r.id}
                </Link>
              </td>
              <td className='py-1 text-right tabular-nums'>
                {r.writes ? fmtCount(r.writes) : '—'}
              </td>
              <td
                className={`py-1 text-right tabular-nums ${r.conflicts ? 'font-medium text-[var(--tm-error-ink)]' : ''}`}
              >
                {r.conflicts ? fmtCount(r.conflicts) : '—'}
              </td>
              <td className='truncate py-1 text-right text-[var(--tm-fg-2)]'>
                {r.locked_by ? (
                  <span title={`Locked by ${r.locked_by}`}>
                    {r.locked_by.split(' ')[0]}
                    {r.queue > 0 ? ` +${r.queue}` : ''}
                  </span>
                ) : r.queue > 0 ? (
                  `${r.queue} waiting`
                ) : (
                  '—'
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  )
}

/** Hot entities column: average round trips per request (live, last minute). Reads the page
 *  context softly — a Hot entities table rendered outside the page shows a dash. */
export function TripsCell({ k }: { k: string }) {
  const ctx = useContext(TrafficMapContext)
  const trips = ctx ? tripsFor(ctx.model, k) : null
  return (
    <span data-tm-trips={k} className='tabular-nums'>
      {trips != null ? fmtTrips(trips) : '—'}
    </span>
  )
}

export function entityApplies(sel: Selection): boolean {
  return sel.kind === 'entity'
}
export function collectionApplies(sel: Selection): boolean {
  return sel.kind === 'entity' && collectionOfKey(sel.id) != null
}
export function graphqlApplies(sel: Selection): boolean {
  return sel.kind === 'entity' && sel.id.startsWith('graphql/')
}
