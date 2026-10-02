/**
 * #1203 — a screen of a front end (`/collections/workflows/:id`, as the screens tap records it):
 * calls per load, who is on it, client builds, and its recent page loads (each opens the load).
 * And a down node (`db`, `redis`, `ext:<id>`, `x:<ext>.<id>`…): its history, and for a partner
 * its configuration summary and recent submissions (each opens the submission).
 */
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { api } from '@/lib/api'
import { fmtCount, fmtMs, fmtTime } from '../../EventTicker'
import { inspectErrorOf, useInspectDetail } from '../../inspect/api'
import { InspectLink } from '../../inspect/InspectLink'
import type { InspectPanelProps } from '../../registry/inspectables'
import { SafeLink } from '../shared'
import { loadStats, parseLoadList, partnerIdOf, seriesOf } from './logic'
import {
  Block,
  callerName,
  Facts,
  Figure,
  Figures,
  Muted,
  PanelError,
  PanelLoading,
  Spark,
  useCatalog,
  useMapLive
} from './parts'

interface PageDetail {
  id: string
  app: string | null
  path: string
  window_s: number
  fanout_limit: number
  screens: Array<{
    screen: string
    app: string | null
    calls: number
    loads: number
    avg: number
    max: number
    over_limit: boolean
    worst: {
      n: number
      at: number
      span_s: number
      caller: string
      routes: Array<{ route: string; n: number }>
      open?: boolean
    } | null
    callers: Array<{ key: string; n: number }>
  }>
  present: Array<{ id: string; name: string; since: number }>
  present_note: string | null
  builds: Array<{
    app: string
    tabs: number
    stale: number
    builds: Array<{
      build: string | null
      tabs: number
      people: number
      current: boolean
      older: string | null
    }>
  }> | null
}

/** Recent loads of the page — Task 7's route; "not available" when it is not there. */
function PageLoads({ pageId }: { pageId: string }) {
  const cat = useCatalog()
  const q = useQuery({
    queryKey: ['tm-inspect', 'load-list', pageId],
    queryFn: async () =>
      (await api.get('/traffic-map/inspect/load-list', { params: { page: pageId } })).data?.data,
    staleTime: 20_000,
    retry: false
  })
  if (q.isLoading) return <PanelLoading />
  if (q.isError) {
    const e = inspectErrorOf(q.error)
    return (
      <Muted hook='loads-unavailable'>
        {e.status === 404
          ? 'Page loads not available on this server yet.'
          : `Page loads could not be read: ${e.message}`}
      </Muted>
    )
  }
  const rows = parseLoadList(q.data)
  if (!rows.length)
    return (
      <Muted hook='loads-none'>
        No load of this page has been seen on this API process recently.
      </Muted>
    )
  const st = loadStats(rows)
  return (
    <div className='grid gap-1.5' data-tm-inspect-page-loads={rows.length}>
      <Figures>
        <Figure label={`Calls per load · p95 of ${st.n}`} value={fmtCount(st.calls_p95)} />
        <Figure label='Calls per load · avg' value={String(st.calls_avg)} />
        <Figure label='Load time · p95' value={fmtMs(st.ms_p95)} />
      </Figures>
      <ul className='grid gap-0.5 text-[12px]'>
        {rows.slice(0, 30).map((r) => {
          // `user` is the person's display name (text); `caller` is the key that links.
          const who = r.user ?? (r.caller ? callerName(cat, r.caller) : null)
          return (
            <li
              key={r.load}
              className='grid grid-cols-[auto_minmax(0,1fr)_auto_auto] gap-x-2'
              data-tm-inspect-page-load={r.load}
            >
              <span className='tabular-nums text-[11px] text-[var(--tm-muted)]'>
                {fmtTime(r.at ?? '')}
              </span>
              <span className='min-w-0 truncate'>
                <InspectLink
                  inspectRef={{ kind: 'load', id: r.load, label: `Load ${r.load.slice(0, 8)}` }}
                >
                  Load {r.load.slice(0, 8)}
                </InspectLink>
                {who && r.caller ? (
                  <>
                    {' · '}
                    <InspectLink inspectRef={{ kind: 'caller', id: r.caller, label: who }}>
                      {who}
                    </InspectLink>
                  </>
                ) : who ? (
                  <span className='text-[var(--tm-fg-2)]'> · {who}</span>
                ) : null}
              </span>
              <span className='tabular-nums text-[var(--tm-fg-2)]'>{fmtCount(r.calls)} calls</span>
              <span className='tabular-nums text-[11px] text-[var(--tm-muted)]'>{fmtMs(r.ms)}</span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

export function PagePanel({ inspectRef, anchor, windowSec }: InspectPanelProps) {
  const cat = useCatalog()
  const q = useInspectDetail<PageDetail>(inspectRef, anchor, windowSec)
  if (q.isLoading) return <PanelLoading />
  if (q.isError || !q.data) return <PanelError error={q.error} what='page' />
  const d = q.data
  const calls = d.screens.reduce((s, r) => s + r.calls, 0)
  const loads = d.screens.reduce((s, r) => s + r.loads, 0)
  const max = d.screens.reduce((m, r) => Math.max(m, r.max), 0)
  const callers = new Map<string, number>()
  for (const r of d.screens)
    for (const c of r.callers) callers.set(c.key, (callers.get(c.key) ?? 0) + c.n)
  return (
    <div className='grid min-w-0 gap-3.5' data-tm-inspect-page={d.id}>
      <div className='grid gap-1'>
        <p className='break-all font-mono text-[13px] font-semibold text-[var(--tm-fg)]'>
          {d.path}
        </p>
        <p className='text-[12px] text-[var(--tm-fg-2)]'>
          {d.app ? `${d.app} app` : 'Every app'} · now, last {d.window_s / 60} min on this API
          process
        </p>
      </div>

      {d.screens.length ? (
        <Figures>
          <Figure label='Calls' value={fmtCount(calls)} />
          <Figure label='Page loads' value={fmtCount(loads)} />
          <Figure
            label='Largest load'
            value={`${fmtCount(max)} calls`}
            tone={max > d.fanout_limit ? 'error' : undefined}
          />
        </Figures>
      ) : (
        <Muted hook='no-calls'>
          No request carried this screen in the window — nobody used it, or the front end does not
          send the page header.
        </Muted>
      )}

      {d.screens.some((r) => r.worst) && (
        <Block title='Busiest load' hook='worst'>
          {d.screens
            .filter((r) => r.worst)
            .map((r) => (
              <div key={r.screen} className='grid gap-1 text-[12px]'>
                <span>
                  {fmtCount(r.worst?.n ?? 0)} calls over {r.worst?.span_s ?? 0}s
                  {r.worst?.open ? ' (still loading)' : ''}
                  {r.worst?.caller && (
                    <>
                      {' · '}
                      <InspectLink
                        inspectRef={{
                          kind: 'caller',
                          id: r.worst.caller,
                          label: callerName(cat, r.worst.caller)
                        }}
                      >
                        {callerName(cat, r.worst.caller)}
                      </InspectLink>
                    </>
                  )}
                </span>
                <Facts
                  rows={(r.worst?.routes ?? []).map(
                    (x) => [x.route, `${x.n}×`] as [string, string]
                  )}
                />
              </div>
            ))}
        </Block>
      )}

      <Block title='Who is on it' hook='present'>
        {d.present.length > 0 && (
          <ul className='grid gap-0.5 text-[12px]'>
            {d.present.map((p) => (
              <li key={p.id} data-tm-inspect-page-present={p.id}>
                <InspectLink
                  inspectRef={{ kind: 'caller', id: `u${p.id.toUpperCase()}`, label: p.name }}
                >
                  {p.name}
                </InspectLink>{' '}
                <span className='text-[var(--tm-muted)]'>since {fmtTime(p.since)}</span>
              </li>
            ))}
          </ul>
        )}
        {d.present_note && <Muted>{d.present_note}</Muted>}
        {callers.size > 0 ? (
          <ul className='grid gap-0.5 text-[12px]'>
            {[...callers]
              .sort((a, b) => b[1] - a[1])
              .slice(0, 8)
              .map(([k, n]) => (
                <li key={k} className='grid grid-cols-[minmax(0,1fr)_auto] gap-x-2'>
                  <InspectLink inspectRef={{ kind: 'caller', id: k, label: callerName(cat, k) }}>
                    {callerName(cat, k)}
                  </InspectLink>
                  <span className='tabular-nums text-[var(--tm-fg-2)]'>{fmtCount(n)} calls</span>
                </li>
              ))}
          </ul>
        ) : (
          !d.present.length && <Muted>Nobody seen on it in the window.</Muted>
        )}
      </Block>

      <Block title='Recent page loads' hook='loads'>
        <PageLoads pageId={d.id} />
      </Block>

      {d.builds && d.builds.length > 0 && (
        <Block title='Client builds' aside='open tabs, by app' hook='builds'>
          {d.builds.map((a) => (
            <div key={a.app} className='grid gap-0.5 text-[12px]'>
              <span className='font-medium'>
                {a.app} · {fmtCount(a.tabs)} tabs
                {a.stale ? ` · ${fmtCount(a.stale)} on an older build` : ''}
              </span>
              <Facts
                rows={a.builds.map(
                  (b) =>
                    [
                      b.build ?? 'not reported',
                      `${fmtCount(b.tabs)} tabs · ${fmtCount(b.people)} people${
                        b.current ? ' · current' : b.older ? ` · older ${b.older}` : ''
                      }`
                    ] as [string, string]
                )}
              />
            </div>
          ))}
        </Block>
      )}
    </div>
  )
}

interface DownDetail {
  id: string
  label: string | null
  history_hours: number
  history: {
    series?: Array<{ req: number; error: number }>
    totals?: { req: number; error: number }
    status_codes?: Record<string, number>
    top_paths?: Array<{ path: string; n: number }>
    note?: string
    truncated?: boolean
  } | null
  history_error: string | null
  history_note: string | null
  /** Why the history (read back from now) does not reach the anchored time, when it cannot. */
  history_anchor_note: string | null
  partner: {
    id: number
    name: string
    base_url: string | null
    description: string | null
    auth_type: string | null
    enabled: boolean
    integration_type: string | null
    owner_name: string | null
    health: { ok: boolean; at: string; detail: string | null } | null
    mocked_instances: string[]
  } | null
  partner_missing: boolean
  submissions: Array<{
    id: number
    status: string
    collection: string | null
    item: string | null
    attempts: number
    error_class: string | null
    last_error: string | null
    at: string | null
  }> | null
}

function DownLive({ id }: { id: string }) {
  const live = useMapLive()
  const tick = live?.tick
  const f = useMemo(() => {
    void tick
    if (!live) return null
    const [req, err, p95v] = live.model.downSum(id, live.win)
    return { req, err, p95: p95v, win: live.win, label: live.model.downLabels.get(id) ?? null }
  }, [live, id, tick])
  if (!f) return null
  return (
    <Figures>
      <Figure label={`Calls · now, last ${f.win / 60} min`} value={fmtCount(f.req)} />
      <Figure label='Errors' value={fmtCount(f.err)} tone={f.err ? 'error' : undefined} />
      <Figure label='p95' value={fmtMs(f.p95)} />
    </Figures>
  )
}

export function DownPanel({ inspectRef, anchor, windowSec }: InspectPanelProps) {
  const live = useMapLive()
  const q = useInspectDetail<DownDetail>(inspectRef, anchor, windowSec)
  if (q.isLoading) return <PanelLoading />
  if (q.isError || !q.data) return <PanelError error={q.error} what='downstream node' />
  const d = q.data
  const h = d.history
  const p = d.partner
  const label = d.label ?? live?.model.downLabels.get(d.id) ?? d.id
  const apiId = partnerIdOf(d.id)
  return (
    <div className='grid min-w-0 gap-3.5' data-tm-inspect-down={d.id}>
      <div className='grid gap-1'>
        <p className='text-[14px] font-semibold text-[var(--tm-fg)]'>{label}</p>
        <p className='text-[12px] text-[var(--tm-fg-2)]'>
          Downstream · <span className='font-mono text-[11px]'>{d.id}</span>
        </p>
      </div>

      <DownLive id={d.id} />

      {p && (
        <Block
          title='Partner'
          hook='partner'
          aside={
            <SafeLink to={`/external-apis/${p.id}`} className='hover:underline'>
              Open full page
            </SafeLink>
          }
        >
          <Facts
            rows={[
              ['State', p.enabled ? 'Enabled' : 'Disabled'],
              p.base_url
                ? [
                    'Base URL',
                    <span key='u' className='font-mono text-[11px]'>
                      {p.base_url}
                    </span>
                  ]
                : null,
              p.auth_type ? ['Auth', p.auth_type] : null,
              p.integration_type ? ['Kind', p.integration_type] : null,
              p.owner_name ? ['Owner', p.owner_name] : null,
              p.health
                ? [
                    'Health check',
                    `${p.health.ok ? 'passing' : 'failing'} · ${new Date(p.health.at).toLocaleString()}${
                      p.health.detail ? ` — ${p.health.detail}` : ''
                    }`
                  ]
                : null,
              p.mocked_instances.length
                ? ['Mock mode', `on for ${p.mocked_instances.join(', ')}`]
                : null
            ]}
          />
          {p.description && <Muted>{p.description}</Muted>}
        </Block>
      )}
      {d.partner_missing && apiId != null && (
        <Muted hook='partner-missing'>Partner #{apiId} is no longer configured.</Muted>
      )}

      <Block title={`History · last ${d.history_hours} h`} hook='history'>
        {d.history_anchor_note && <Muted hook='history-anchor'>{d.history_anchor_note}</Muted>}
        {h ? (
          <div className='grid gap-1.5'>
            <Spark data={seriesOf(h)} caption={`Calls per bucket (${d.history_hours} h)`} />
            {h.note && <Muted>{h.note}</Muted>}
            <Facts
              rows={[
                h.totals ? ['Calls', fmtCount(h.totals.req)] : null,
                h.totals ? ['Failed', fmtCount(h.totals.error)] : null,
                h.status_codes && Object.keys(h.status_codes).length
                  ? [
                      'Outcomes',
                      Object.entries(h.status_codes)
                        .sort((a, b) => b[1] - a[1])
                        .map(([c, n]) => `${c} × ${fmtCount(n)}`)
                        .join(' · ')
                    ]
                  : null
              ]}
            />
            {!!h.top_paths?.length && (
              <Facts
                rows={h.top_paths.map((x) => [x.path, `${fmtCount(x.n)}×`] as [string, string])}
              />
            )}
            {h.truncated && <Muted>Only the newest 20,000 log rows were read.</Muted>}
          </div>
        ) : (
          <Muted hook='history-missing'>
            {d.history_error ?? d.history_note ?? 'No history kept.'}
          </Muted>
        )}
      </Block>

      {d.submissions && (
        <Block title='Recent submissions' hook='submissions'>
          {d.submissions.length ? (
            <ul className='grid gap-0.5 text-[12px]'>
              {d.submissions.map((s) => (
                <li
                  key={s.id}
                  className='grid grid-cols-[auto_minmax(0,1fr)] gap-x-2'
                  data-tm-inspect-down-submission={s.id}
                >
                  <span className='tabular-nums text-[11px] text-[var(--tm-muted)]'>
                    {fmtTime(s.at ?? '')}
                  </span>
                  <span className='min-w-0 truncate'>
                    <InspectLink
                      inspectRef={{
                        kind: 'submission',
                        id: String(s.id),
                        label: `Submission ${s.id}`
                      }}
                    >
                      #{s.id} · {s.status}
                    </InspectLink>
                    <span className='text-[var(--tm-muted)]'>
                      {s.collection ? ` · ${s.collection} ${s.item ?? ''}` : ''}
                      {s.attempts > 1 ? ` · ${s.attempts} attempts` : ''}
                      {s.last_error ? ` — ${s.last_error}` : ''}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <Muted>No submission to this partner has been recorded.</Muted>
          )}
        </Block>
      )}
    </div>
  )
}
