/**
 * Traffic Map partner and API-shape lenses: partner response times against the agreed figures
 * (#2150), partner payload shape drift (#2200), inbound mapping outcomes (#2201), GraphQL query
 * cost (#2205) and REST field heat (#2206). Each is an inspector panel on the node it describes.
 */
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { api } from '@/lib/api'
import { useTrafficMap } from '../../context'
import { callerLabel, fmtCount, fmtMs, fmtPct } from '../../EventTicker'
import { Bar, Empty, Section } from '../../Inspector'
import { inspectorPanels } from '../../registry/inspectorPanels'
import { register } from '../../registry/registry'
import type { Selection } from '../../types'
import { entityOf, errorOf, LINK, useEntityDetail } from '../shared'
import {
  breachText,
  driftHeadline,
  type GraphqlCost,
  type GraphqlCostRow,
  type InboundOutcomes,
  type PartnerContract,
  type PartnerShapes,
  type RestFields,
  type ShapeGroup,
  starShare,
  stripScale
} from './logic'

const PARTNER_ID = /^ext:(\d+)$/
const isPartner = (sel: Selection) => sel.kind === 'down' && PARTNER_ID.test(sel.id)
const apiIdOf = (sel: Selection) => Number(PARTNER_ID.exec(sel.id)?.[1] ?? 0)

const CHIP =
  'inline-flex items-baseline gap-1 rounded-md border border-[var(--tm-line)] px-1.5 py-0.5 text-[11.5px]'

// ── #2150 partner response times against the agreed figures ────────────────────────────

function Verdict({ met }: { met: boolean | null | undefined }) {
  if (met == null) return null
  return (
    <span className={met ? 'text-[var(--tm-accent-ink)]' : 'text-[var(--tm-error-ink)]'}>
      {met ? 'met' : 'missed'}
    </span>
  )
}

function HourStrip({ data }: { data: PartnerContract }) {
  const series = data.series ?? []
  const { heights, targetAt } = stripScale(series, data.targets?.p95_ms ?? null)
  return (
    <div className='relative' data-tm-contract-strip=''>
      <div className='flex h-10 items-end gap-px'>
        {series.map((p, i) => (
          <span
            key={p.t}
            className='relative flex h-full flex-1 items-end'
            data-tip={`${new Date(p.t).toTimeString().slice(0, 5)} · ${
              p.req
                ? `${p.req} calls · p95 ${fmtMs(p.p95 ?? 0)} · ${fmtPct(p.avail_pct ?? 0)} answered`
                : 'no calls'
            }${p.judged ? ` · ${breachText(p.breach)}` : p.req ? ' · too few calls to judge' : ''}`}
            data-tm-hour-breach={p.breach ?? ''}
          >
            <i
              className='block w-full rounded-t-[1px]'
              style={{
                height: `${Math.max(heights[i] * 100, p.req ? 4 : 0)}%`,
                background: p.breach
                  ? 'var(--tm-error)'
                  : p.judged
                    ? 'var(--tm-accent)'
                    : 'var(--tm-line)'
              }}
            />
          </span>
        ))}
      </div>
      {targetAt != null ? (
        <span
          className='pointer-events-none absolute inset-x-0 border-t border-dashed border-[var(--tm-fg-2)]'
          style={{ bottom: `${targetAt * 100}%` }}
          aria-hidden='true'
        />
      ) : null}
    </div>
  )
}

function PartnerContractPanel({ sel }: { sel: Selection }) {
  const q = useQuery({
    queryKey: ['traffic-map', 'partner-contract', sel.id],
    queryFn: async () =>
      (
        (await api.get('/traffic-map/partner-contract', { params: { id: sel.id } }))?.data as {
          data?: PartnerContract
        }
      )?.data ?? null,
    staleTime: 60_000,
    refetchInterval: 120_000
  })
  const d = q.data
  const id = apiIdOf(sel)
  return (
    <Section title='Against what was agreed'>
      {q.isLoading ? (
        <Empty>Reading this month's calls…</Empty>
      ) : q.isError ? (
        <Empty>The agreed figures could not be read: {errorOf(q.error)}</Empty>
      ) : !d?.targets ? (
        <Empty>
          No response time or availability is agreed for this partner. Set them on the{' '}
          <Link to={`/external-apis/${id}`} className={LINK}>
            external API
          </Link>{' '}
          to see breaches here.
        </Empty>
      ) : (
        <div className='grid gap-2.5 text-[12px]' data-tm-partner-contract={d.api.name}>
          <div className='flex flex-wrap gap-1.5'>
            {d.targets.p95_ms != null ? (
              <span className={CHIP} data-tm-contract='latency'>
                <span className='text-[var(--tm-fg-2)]'>95th percentile</span>
                <span className='font-semibold tabular-nums'>
                  {d.p95_ms != null ? fmtMs(d.p95_ms) : '—'}
                </span>
                <span className='text-[var(--tm-muted)]'>of {fmtMs(d.targets.p95_ms)}</span>
                <Verdict met={d.latency_met} />
              </span>
            ) : null}
            {d.targets.uptime_pct != null ? (
              <span className={CHIP} data-tm-contract='uptime'>
                <span className='text-[var(--tm-fg-2)]'>Answered</span>
                <span className='font-semibold tabular-nums'>
                  {d.avail_pct != null ? fmtPct(d.avail_pct) : '—'}
                </span>
                <span className='text-[var(--tm-muted)]'>of {d.targets.uptime_pct}%</span>
                <Verdict met={d.uptime_met} />
              </span>
            ) : null}
          </div>
          <p className='text-[12px] text-[var(--tm-fg-2)]' data-tm-contract-attainment=''>
            {d.attainment_pct == null ? (
              'No hour this month had enough calls to judge.'
            ) : (
              <>
                <b className='font-semibold tabular-nums text-[var(--tm-fg)]'>
                  {fmtPct(d.attainment_pct)}
                </b>{' '}
                of {d.hours_judged} judged hour{d.hours_judged === 1 ? '' : 's'} this month inside
                what was agreed
                {d.hours_breached ? ` (${d.hours_breached} breached)` : ''}.
              </>
            )}
          </p>
          <HourStrip data={d} />
          <p className='text-[11.5px] text-[var(--tm-muted)]'>
            Last 24 hours, one bar per hour: p95 response time, red where the hour broke the
            agreement (3 or more calls to judge). The dashed line is the agreed figure. An answer
            counts as available unless it is a 5xx or never arrived.
            {d.truncated
              ? ' The month has more calls than were read; figures cover the newest.'
              : ''}
          </p>
        </div>
      )}
    </Section>
  )
}

register(inspectorPanels, {
  id: 'partner-contract',
  order: 22,
  applies: isPartner,
  Component: PartnerContractPanel
})

// ── #2200 partner payload shape drift ───────────────────────────────────────────────────

function PathList({
  title,
  rows,
  detail
}: {
  title: string
  rows: Array<{ path: string; text: string }>
  detail?: boolean
}) {
  if (!rows.length) return null
  return (
    <div className='grid gap-0.5'>
      <span className='text-[11.5px] font-medium text-[var(--tm-fg-2)]'>{title}</span>
      {rows.map((r) => (
        <span
          key={r.path}
          className='flex min-w-0 items-baseline gap-2 font-mono text-[11px]'
          data-tm-drift-path={r.path}
        >
          <span className='min-w-0 truncate' title={r.path}>
            {r.path}
          </span>
          {detail === false ? null : (
            <span className='shrink-0 font-sans text-[11px] text-[var(--tm-muted)]'>{r.text}</span>
          )}
        </span>
      ))}
    </div>
  )
}

function ShapeCard({ g }: { g: ShapeGroup }) {
  const r = g.report
  return (
    <div
      className='grid min-w-0 gap-1.5 rounded-md border border-[var(--tm-line)] px-2 py-1.5'
      data-tm-shape-group={`${g.side} ${g.endpoint}`}
      data-tm-shape-status={r.status}
    >
      <span className='flex min-w-0 items-baseline gap-1.5'>
        <span className='shrink-0 text-[11px] text-[var(--tm-muted)]'>
          {g.side === 'request' ? 'We send' : 'They send'}
        </span>
        <span className='min-w-0 truncate font-mono text-[11px]' title={g.endpoint}>
          {g.endpoint}
        </span>
      </span>
      <span
        className={`text-[11.5px] ${r.status === 'drifting' ? 'font-medium text-[var(--tm-error-ink)]' : 'text-[var(--tm-muted)]'}`}
      >
        {driftHeadline(r)}
      </span>
      <PathList
        title='Started sending'
        rows={r.new_fields.map((f) => ({
          path: f.path,
          text: `in ${f.recent} of the last ${r.recent_bodies}`
        }))}
      />
      <PathList
        title='Stopped sending'
        rows={r.missing_fields.map((f) => ({
          path: f.path,
          text: `usually in ${f.baseline_pct}%`
        }))}
      />
      <PathList
        title='Changed type'
        rows={r.type_changes.map((f) => ({ path: f.path, text: `${f.from} to ${f.to}` }))}
      />
    </div>
  )
}

function PayloadDriftPanel({ sel }: { sel: Selection }) {
  const q = useQuery({
    queryKey: ['traffic-map', 'partner-shapes', sel.id],
    queryFn: async () =>
      (
        (await api.get('/traffic-map/partner-shapes', { params: { id: sel.id } }))?.data as {
          data?: PartnerShapes
        }
      )?.data ?? null,
    staleTime: 120_000
  })
  const d = q.data
  return (
    <Section title='Payload shape'>
      {q.isLoading ? (
        <Empty>Reading recorded bodies…</Empty>
      ) : q.isError ? (
        <Empty>Bodies could not be read: {errorOf(q.error)}</Empty>
      ) : !d?.available || d.groups.length === 0 ? (
        <Empty>
          No JSON bodies recorded for this partner in the last {d?.bodies_hours ?? 24} hours. Bodies
          are kept for a day and only when the outbound recorder captures them.
        </Empty>
      ) : (
        <div className='grid gap-2' data-tm-payload-drift=''>
          {d.groups.map((g) => (
            <ShapeCard key={`${g.side}|${g.endpoint}`} g={g} />
          ))}
          <p className='text-[11.5px] text-[var(--tm-muted)]'>
            Field names and types only, never values. The newest calls are compared with the earlier
            ones from the last {d.bodies_hours} hours, per endpoint.
          </p>
        </div>
      )}
    </Section>
  )
}

register(inspectorPanels, {
  id: 'partner-payload-drift',
  order: 24,
  applies: isPartner,
  Component: PayloadDriftPanel
})

// ── #2201 inbound mapping outcomes ──────────────────────────────────────────────────────

function InboundOutcomesPanel({ sel }: { sel: Selection }) {
  const { win } = useTrafficMap()
  const e = entityOf(sel)
  const { data, loading } = useEntityDetail<InboundOutcomes>(
    e?.key ?? null,
    'inbound-outcomes',
    win
  )
  const total = data ? data.payloads.accepted + data.payloads.partial + data.payloads.rejected : 0
  return (
    <Section title='What the mapping did with payloads'>
      {loading ? (
        <Empty>Reading outcomes…</Empty>
      ) : !data || total === 0 ? (
        <Empty>No payload reached this mapping in this window.</Empty>
      ) : (
        <div className='grid gap-2.5 text-[12px]' data-tm-inbound-outcomes=''>
          <div className='flex flex-wrap gap-1.5'>
            {(
              [
                ['accepted', 'Accepted', data.payloads.accepted],
                ['partial', 'Partly accepted', data.payloads.partial],
                ['rejected', 'Rejected', data.payloads.rejected]
              ] as const
            ).map(([k, label, n]) => (
              <span key={k} className={CHIP} data-tm-inbound-outcome={k}>
                <span className='text-[var(--tm-fg-2)]'>{label}</span>
                <span
                  className={`font-semibold tabular-nums ${k !== 'accepted' && n ? 'text-[var(--tm-error-ink)]' : ''}`}
                >
                  {fmtCount(n)}
                </span>
              </span>
            ))}
          </div>
          <p className='text-[11.5px] text-[var(--tm-muted)]'>
            {fmtCount(data.entries_rejected)} of {fmtCount(data.entries)} entries refused across{' '}
            {fmtCount(total)} payload{total === 1 ? '' : 's'}.
          </p>
          {data.reasons.length ? (
            <div className='grid gap-1.5'>
              <span className='text-[11.5px] font-medium text-[var(--tm-fg-2)]'>
                Top rejection reasons
              </span>
              {data.reasons.map((r) => (
                <Bar
                  key={r.reason}
                  label={r.reason}
                  n={r.n}
                  max={data.reasons[0]?.n ?? 1}
                  color='var(--tm-error)'
                  mono={false}
                />
              ))}
            </div>
          ) : null}
        </div>
      )}
    </Section>
  )
}

register(inspectorPanels, {
  id: 'inbound-outcomes',
  order: 40,
  applies: (sel) => entityOf(sel)?.lane === 'inbound',
  Component: InboundOutcomesPanel
})

// ── #2205 GraphQL query cost ────────────────────────────────────────────────────────────

function CostPanel({ sel }: { sel: Selection }) {
  const { win, catalog, setSelection } = useTrafficMap()
  const e = entityOf(sel)
  const { data, loading } = useEntityDetail<GraphqlCost>(e?.key ?? null, 'graphql-cost', win)
  const ranking = useQuery({
    queryKey: ['traffic-map', 'graphql-cost', win],
    queryFn: async () =>
      (
        (await api.get('/traffic-map/graphql-cost', { params: { window: win } }))?.data as {
          data?: { operations?: GraphqlCostRow[] }
        }
      )?.data?.operations ?? [],
    staleTime: 10_000,
    refetchInterval: 20_000
  })
  return (
    <Section title='Query cost'>
      {loading ? (
        <Empty>Reading cost…</Empty>
      ) : !data ? (
        <Empty>No call to this operation in this window.</Empty>
      ) : (
        <div className='grid gap-2.5 text-[12px]' data-tm-graphql-cost=''>
          <div className='flex flex-wrap gap-1.5'>
            <span className={CHIP}>
              <span className='text-[var(--tm-fg-2)]'>Depth</span>
              <span className='font-semibold tabular-nums'>{data.max_depth}</span>
            </span>
            <span className={CHIP}>
              <span className='text-[var(--tm-fg-2)]'>Selections</span>
              <span className='font-semibold tabular-nums'>{fmtCount(data.avg_selections)}</span>
            </span>
            <span className={CHIP}>
              <span className='text-[var(--tm-fg-2)]'>Resolvers</span>
              <span className='font-semibold tabular-nums'>
                {data.avg_resolver_ms != null ? fmtMs(data.avg_resolver_ms) : 'not timed'}
              </span>
            </span>
            <span className={CHIP}>
              <span className='text-[var(--tm-fg-2)]'>Whole request</span>
              <span className='font-semibold tabular-nums'>{fmtMs(data.avg_wall_ms)}</span>
            </span>
          </div>
          <p className='text-[11.5px] text-[var(--tm-muted)]' data-tm-cost-rank={data.rank}>
            {data.rank > 0 ? `Number ${data.rank} of ${data.of} operations by cost. ` : ''}
            Cost ranks by average time in nested resolvers, then selections, then depth. Resolvers
            are timed only while the map is open.
          </p>
          {data.callers.length ? (
            <div className='grid gap-1'>
              <span className='text-[11.5px] font-medium text-[var(--tm-fg-2)]'>Sent by</span>
              {data.callers.map((c) => (
                <button
                  type='button'
                  key={c.key}
                  className={`${LINK} flex min-w-0 items-baseline justify-between gap-2 text-left`}
                  onClick={() => setSelection({ kind: 'caller', id: c.key })}
                >
                  <span className='min-w-0 truncate'>{callerLabel(catalog, c.key)}</span>
                  <span className='shrink-0 tabular-nums text-[var(--tm-muted)]'>
                    {fmtCount(c.n)}
                  </span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      )}
      {ranking.data && ranking.data.length > 1 ? (
        <div className='mt-3 grid gap-1' data-tm-cost-ranking=''>
          <span className='text-[11.5px] font-medium text-[var(--tm-fg-2)]'>Most expensive</span>
          {ranking.data.slice(0, 6).map((r, i) => (
            <button
              type='button'
              key={r.key}
              className={`${LINK} grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-2 text-left`}
              onClick={() => setSelection({ kind: 'entity', id: r.key })}
            >
              <span className='tabular-nums text-[var(--tm-muted)]'>{i + 1}</span>
              <span className='min-w-0 truncate font-mono text-[11px]'>{r.operation}</span>
              <span className='tabular-nums text-[var(--tm-fg-2)]'>
                {fmtMs(r.avg_resolver_ms ?? r.avg_wall_ms)}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </Section>
  )
}

register(inspectorPanels, {
  id: 'graphql-cost',
  order: 45,
  applies: (sel) => {
    const e = entityOf(sel)
    return !!e && e.lane === 'graphql' && !e.entity.startsWith('__')
  },
  Component: CostPanel
})

// ── #2206 REST field heat ───────────────────────────────────────────────────────────────

function RestFieldsPanel({ sel }: { sel: Selection }) {
  const { win, catalog } = useTrafficMap()
  const e = entityOf(sel)
  const { data, loading } = useEntityDetail<RestFields>(e?.key ?? null, 'rest-fields', win)
  const max = data?.fields[0]?.n ?? 0
  return (
    <Section title='Fields requested'>
      {loading ? (
        <Empty>Reading field requests…</Empty>
      ) : !data || data.fields.length === 0 ? (
        <Empty>No list read of this collection in this window.</Empty>
      ) : (
        <div className='grid gap-2' data-tm-rest-fields=''>
          <p className='text-[11.5px] text-[var(--tm-muted)]'>
            {fmtCount(data.reads)} list read{data.reads === 1 ? '' : 's'}; {starShare(data)}% asked
            for every column (<span className='font-mono'>*</span> or no{' '}
            <span className='font-mono'>fields</span>).
          </p>
          {data.fields.slice(0, 15).map((f) => (
            <div key={f.field} data-tm-rest-field={f.field}>
              <Bar label={f.field} n={f.n} max={max} />
              {f.callers.length ? (
                <span className='mt-0.5 block truncate text-[11.5px] text-[var(--tm-muted)]'>
                  {f.callers
                    .map((c) => `${callerLabel(catalog, c.key)} ${fmtCount(c.n)}`)
                    .join(' · ')}
                </span>
              ) : null}
            </div>
          ))}
          <p className='text-[11.5px] text-[var(--tm-muted)]'>
            Field names only, from the first list read of each request. Compare with the filters
            above when choosing an index.
          </p>
        </div>
      )}
    </Section>
  )
}

register(inspectorPanels, {
  id: 'rest-fields',
  order: 47,
  applies: (sel) => {
    const e = entityOf(sel)
    return !!e && (e.lane === 'items' || e.lane === 'system') && !e.entity.startsWith('__')
  },
  Component: RestFieldsPanel
})
