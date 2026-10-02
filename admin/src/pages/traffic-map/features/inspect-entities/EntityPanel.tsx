/**
 * #1200 — one node of the map (`<lane>/<entity>`): live figures from the map's own rings, its
 * callers, error groups, history from the API log, recent failed requests (each opens its
 * request) and recent writes (each opens the write and its record). A query or widget entity
 * links on to its definition.
 */
import { useMemo } from 'react'
import { fmtCount, fmtMs, fmtTime } from '../../EventTicker'
import { useInspectDetail } from '../../inspect/api'
import { InspectLink } from '../../inspect/InspectLink'
import type { InspectPanelProps } from '../../registry/inspectables'
import { recordRef, seriesOf } from './logic'
import {
  Block,
  callerName,
  Facts,
  Figure,
  Figures,
  Muted,
  PanelError,
  PanelLoading,
  type RequestLine,
  RequestList,
  Spark,
  Status,
  useCatalog,
  useMapLive
} from './parts'

interface EntityDetail {
  key: string
  lane: string
  entity: string
  label: string
  related: { kind: string; id: string } | null
  range: { from: number; to: number }
  map_window: number
  history: {
    hours: number
    series?: Array<{ req: number; error: number }>
    totals?: { req: number; error: number; p95: number; write_requests: number }
    status_codes?: Record<string, number>
    top_routes?: Array<{ route: string; n: number }>
    issues?: Array<{
      id: number
      title: string
      severity: string
      status: string
      occurrence_count: number
    }>
    slow_traces?: Array<{ id: string; route: string; total_ms: number }>
    truncated?: boolean
  } | null
  history_hours: number
  history_error: string | null
  history_note: string | null
  callers: Array<{ key: string; sums: number[]; p95: number }>
  error_groups: Array<{
    key: string
    route: string
    status: number
    code: string | null
    message: string
    n: number
    issue: { id: number; status: string } | null
  }>
  other_lenses: string[]
  recent_errors: RequestLine[]
  recent_writes: Array<{
    id: number
    action: string
    item: string | null
    user: string | null
    user_name: string | null
    at: string
    origin: string | null
  }> | null
  request_ids_logged: boolean
}

const VERB: Record<string, string> = { create: 'created', update: 'updated', delete: 'deleted' }

/** Live figures for the entity from the map's rings (window = the map's current window). */
function LiveFigures({ entityKey }: { entityKey: string }) {
  const live = useMapLive()
  const tick = live?.tick
  const figs = useMemo(() => {
    void tick
    if (!live) return null
    const sum = live.model.entitySum(entityKey, live.win)
    return {
      sum,
      series: live.model.entitySeries(entityKey, live.win, 40),
      p95: live.model.entityP95(entityKey),
      win: live.win
    }
  }, [live, entityKey, tick])
  if (!figs) return null
  const [req, , , , , err] = figs.sum
  return (
    <div className='grid gap-1.5' data-tm-inspect-entity-live=''>
      <Figures>
        <Figure label={`Requests · last ${figs.win / 60} min`} value={fmtCount(req)} />
        <Figure label='Errors' value={fmtCount(err)} tone={err ? 'error' : undefined} />
        <Figure label='p95' value={fmtMs(figs.p95)} />
      </Figures>
      <Spark data={figs.series} caption='Live, from the map (this API process)' />
    </div>
  )
}

export function EntityPanel({ inspectRef, anchor, windowSec }: InspectPanelProps) {
  const cat = useCatalog()
  const q = useInspectDetail<EntityDetail>(inspectRef, anchor, windowSec)
  if (q.isLoading) return <PanelLoading />
  if (q.isError || !q.data) return <PanelError error={q.error} what='entity' />
  const d = q.data
  const h = d.history
  const collection = d.lane === 'items' || d.lane === 'system' ? d.entity : null
  return (
    <div className='grid min-w-0 gap-3.5' data-tm-inspect-entity={d.key}>
      <div className='grid gap-1'>
        <p className='text-[14px] font-semibold text-[var(--tm-fg)]'>{d.label}</p>
        <p className='text-[12px] text-[var(--tm-fg-2)]'>
          {d.lane} lane · <span className='font-mono text-[11px]'>{d.entity}</span>
        </p>
        {d.related && (
          <InspectLink
            inspectRef={{ kind: d.related.kind, id: d.related.id, label: d.label }}
            className='text-[12px]'
          >
            <span data-tm-inspect-entity-related={d.related.kind}>
              {d.related.kind === 'query' ? 'Open the custom query' : 'Open the widget definition'}
            </span>
          </InspectLink>
        )}
      </div>

      <LiveFigures entityKey={d.key} />

      <Block title='Callers' aside={`last ${d.map_window / 60} min`} hook='callers'>
        {d.callers.length ? (
          <ul className='grid gap-0.5 text-[12px]'>
            {d.callers.map((c) => (
              <li
                key={c.key}
                className='grid grid-cols-[minmax(0,1fr)_auto_auto] gap-x-2'
                data-tm-inspect-entity-caller={c.key}
              >
                <InspectLink
                  inspectRef={{ kind: 'caller', id: c.key, label: callerName(cat, c.key) }}
                >
                  {callerName(cat, c.key)}
                </InspectLink>
                <span className='tabular-nums text-[var(--tm-fg-2)]'>
                  {fmtCount(c.sums[0] ?? 0)}
                </span>
                <span className='tabular-nums text-[11px] text-[var(--tm-muted)]'>
                  {fmtMs(c.p95)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <Muted>
            No caller hit this entity on this API process in the last {d.map_window / 60} minutes.
          </Muted>
        )}
      </Block>

      {d.error_groups.length > 0 && (
        <Block title='Error groups' hook='error-groups'>
          <ul className='grid gap-1 text-[12px]'>
            {d.error_groups.map((g) => (
              <li key={g.key} className='grid gap-0.5' data-tm-inspect-entity-error-group={g.key}>
                <span className='min-w-0 truncate'>
                  <Status status={g.status} />{' '}
                  <span className='font-mono text-[11px]'>{g.route}</span> · {fmtCount(g.n)}×
                </span>
                <span className='text-[11.5px] text-[var(--tm-fg-2)]'>
                  {g.code ? `${g.code} — ` : ''}
                  {g.message}
                  {g.issue && (
                    <>
                      {' · '}
                      <InspectLink inspectRef={{ kind: 'issue', id: String(g.issue.id) }}>
                        Issue #{g.issue.id}
                      </InspectLink>
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </Block>
      )}

      <Block title='Recent failed requests' hook='recent-errors'>
        <RequestList
          rows={d.recent_errors}
          showCaller
          cat={cat}
          idsLogged={d.request_ids_logged}
          empty={
            d.history_note ??
            'No failed request on this entity in the window (or older than the API log keeps — 14 days).'
          }
        />
      </Block>

      {collection && d.recent_writes && (
        <Block title='Recent writes' hook='recent-writes'>
          {d.recent_writes.length ? (
            <ul className='grid gap-0.5 text-[12px]'>
              {d.recent_writes.map((w) => (
                <li
                  key={w.id}
                  className='grid grid-cols-[auto_minmax(0,1fr)] gap-x-2'
                  data-tm-inspect-entity-write={w.id}
                >
                  <span className='tabular-nums text-[11px] text-[var(--tm-muted)]'>
                    {fmtTime(w.at)}
                  </span>
                  <span className='min-w-0 truncate'>
                    {w.item ? (
                      <InspectLink inspectRef={recordRef(collection, w.item)}>
                        {collection} {w.item}
                      </InspectLink>
                    ) : (
                      collection
                    )}{' '}
                    <InspectLink
                      inspectRef={{ kind: 'write', id: String(w.id), label: `Write ${w.id}` }}
                    >
                      {VERB[w.action] ?? w.action}
                    </InspectLink>
                    <span className='text-[var(--tm-muted)]'>
                      {w.user_name ? ` by ${w.user_name}` : w.origin ? ` · ${w.origin}` : ''}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <Muted>
              No writes recorded on {collection} in the window (or its audit level keeps none).
            </Muted>
          )}
        </Block>
      )}

      <Block title={`History · last ${d.history_hours} h`} hook='history'>
        {h ? (
          <div className='grid gap-1.5'>
            <Spark
              data={seriesOf(h)}
              caption={`Requests per bucket, API log (${d.history_hours} h)`}
            />
            <Facts
              rows={[
                h.totals ? ['Requests', fmtCount(h.totals.req)] : null,
                h.totals ? ['Errors', fmtCount(h.totals.error)] : null,
                h.totals ? ['p95', fmtMs(h.totals.p95)] : null,
                h.status_codes && Object.keys(h.status_codes).length
                  ? [
                      'Status codes',
                      Object.entries(h.status_codes)
                        .sort((a, b) => b[1] - a[1])
                        .map(([c, n]) => `${c} × ${fmtCount(n)}`)
                        .join(' · ')
                    ]
                  : null
              ]}
            />
            {!!h.issues?.length && (
              <ul className='grid gap-0.5 text-[12px]'>
                {h.issues.map((i) => (
                  <li key={i.id}>
                    <InspectLink inspectRef={{ kind: 'issue', id: String(i.id), label: i.title }}>
                      {i.title}
                    </InspectLink>{' '}
                    <span className='text-[var(--tm-muted)]'>
                      {i.severity} · {fmtCount(i.occurrence_count)}×
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {!!h.slow_traces?.length && (
              <ul className='grid gap-0.5 text-[12px]'>
                {h.slow_traces.map((t) => (
                  <li key={t.id}>
                    <InspectLink inspectRef={{ kind: 'request', id: t.id, label: t.route }}>
                      Slow trace · {t.route}
                    </InspectLink>{' '}
                    <span className='text-[var(--tm-muted)]'>{fmtMs(t.total_ms)}</span>
                  </li>
                ))}
              </ul>
            )}
            {h.truncated && <Muted>Only the newest 20,000 log rows were read.</Muted>}
          </div>
        ) : (
          <Muted hook='history-missing'>
            {d.history_error ?? d.history_note ?? 'No history for this entity.'}
          </Muted>
        )}
      </Block>

      {d.other_lenses.length > 0 && (
        <Muted hook='other-lenses'>
          More lenses for this entity in the map inspector: {d.other_lenses.join(', ')}.
        </Muted>
      )}
    </div>
  )
}
