import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { useNavigation, useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { titleCase } from '../../lib/utils'
import { BaseMap, type BaseMapBubble, type BaseMapPin } from '../BaseMap'

/**
 * Command Center — one live board answering "what is happening right now":
 * where the work physically is (map), what's moving (flow board + ticker),
 * what's stuck (risk strip), who's on (people layer), and whether the system
 * itself is healthy (admin rail). Composes the /command-center routes; every
 * number clicks through to its real surface via NavigationContext.
 *
 * Deliberately DARK-FIRST as a designed ops surface — always-dark surfaces
 * use arbitrary-hex classes (never bare bg-slate-900, which efp-new re-points
 * light; documented gotcha).
 *
 * Hosts: NivaroProvider + NavigationContext required. Polling cadence:
 * snapshot 20s, map pins 60s, centroids 10min — a socket host can additionally
 * nudge via the query cache, but the board is fully alive on polls alone.
 */

interface Snapshot {
  flow: Array<{
    collection: string
    template_name: string
    states: Array<{ key: string; label: string; color: string | null; count: number }>
  }>
  risk: { at_risk: number; tracked: number; open_issues: number }
  people: {
    online_count: number
    idle_count: number
    names: string[]
    by_region: Array<{ region_id: number; count: number }>
    /** Online people grouped at their geocoded office — precise map pins;
     *  by_region only covers people WITHOUT an office (no double counting). */
    offices?: Array<{ lat: number; lng: number; label: string; count: number; names: string[] }>
    regions: Array<{
      region_id: number | null
      label: string
      count: number
      names: string[]
      /** Present on office groups — the pane flies the map here directly. */
      lat?: number
      lng?: number
    }>
  }
  throughput: { transitions_today: number; transitions_yesterday_same_time: number }
  health: {
    db_ok: boolean
    redis_ok: boolean
    errors_1h: number
    requests_1h: number
    jobs_running: number
    jobs_failed_1h: number
    runtime: { rss_mb: number; event_loop_lag_ms: { max_1m: number } }
    instances: number
  } | null
  activity: Array<{
    id: number
    action: string
    collection: string | null
    item: string | null
    comment: string | null
    timestamp: string
    user_name: string | null
  }>
}

interface GeoPin {
  id: string
  lat: number
  lng: number
  label: string
  state: string | null
  state_color: string | null
  sla: 'ok' | 'warning' | 'breached' | null
}

const PANEL = 'rounded-lg border border-white/10 bg-[#101828]'
const PANEL_HEAD = 'flex items-center justify-between border-b border-white/10 px-3 py-2'
const TITLE = 'text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-400'

function rel(ts: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(ts).getTime()) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return `${Math.floor(s / 3600)}h`
}

export function CommandCenterView({
  /** Geo collections offered in the map layer picker; first is the default. */
  geoCollections = ['locations'],
  recordUrl
}: {
  geoCollections?: string[]
  /** Host route for a clicked pin's record — defaults to the admin shape. */
  recordUrl?: (collection: string, id: string) => string
}) {
  const client = useNivaroClient()
  const { navigate } = useNavigation()
  const qc = useQueryClient()
  const [geoCollection, setGeoCollection] = useState(geoCollections[0] ?? 'locations')
  const [showPeople, setShowPeople] = useState(true)
  // Record pins are a toggleable layer like People: click the active
  // collection chip to hide/show it, click another chip to switch to it.
  const [showRecords, setShowRecords] = useState(true)
  const [clock, setClock] = useState(() => new Date())
  const [mapFocus, setMapFocus] = useState<{ lat: number; lng: number; zoom?: number; nonce: number } | null>(null)
  useEffect(() => {
    const t = setInterval(() => setClock(new Date()), 1000)
    return () => clearInterval(t)
  }, [])

  const { data: snap } = useQuery<Snapshot | null>({
    queryKey: ['command-center', 'snapshot'],
    queryFn: () =>
      client
        .request<{ data: Snapshot }>(get('/command-center/snapshot'))
        .then((r) => r.data)
        .catch(() => null),
    refetchInterval: 20_000
  })
  const { data: geo } = useQuery<{ pins: GeoPin[]; truncated: boolean }>({
    queryKey: ['command-center', 'geo', geoCollection],
    queryFn: () =>
      client
        .request<{ data: GeoPin[]; truncated?: boolean }>(
          get('/command-center/geo', { collection: geoCollection })
        )
        .then((r) => ({ pins: r.data ?? [], truncated: !!r.truncated }))
        .catch(() => ({ pins: [], truncated: false })),
    refetchInterval: 60_000,
    enabled: showRecords
  })
  const { data: centroids = [] } = useQuery<Array<{ id: number; label: string; lat: number; lng: number }>>({
    queryKey: ['command-center', 'people-geo'],
    queryFn: () =>
      client
        .request<{ data: never }>(get('/command-center/people-geo'))
        .then((r) => r.data)
        .catch(() => [] as never),
    staleTime: 10 * 60_000
  })

  const pins: BaseMapPin[] = useMemo(
    () =>
      (showRecords ? (geo?.pins ?? []) : []).map((p) => ({
        id: p.id,
        lat: p.lat,
        lng: p.lng,
        label: `${p.label}${p.state ? ` — ${p.state}` : ''}${p.sla === 'breached' ? ' · SLA BREACHED' : p.sla === 'warning' ? ' · SLA warning' : ''}`,
        color: p.sla === 'breached' ? '#ef4444' : p.sla === 'warning' ? '#f59e0b' : (p.state_color ?? '#00a5cc'),
        pulse: p.sla === 'breached'
      })),
    [geo, showRecords]
  )
  const bubbles: BaseMapBubble[] = useMemo(() => {
    if (!showPeople) return []
    // Precise office pins first (people with a geocoded Graph office address —
    // names ride the label), then region centroids for everyone else. The
    // server already keeps the two sets disjoint.
    const offices: BaseMapBubble[] = (snap?.people.offices ?? []).map((o, i) => ({
      id: `office-${i}`,
      lat: o.lat,
      lng: o.lng,
      count: o.count,
      label: `${o.label}${o.names.length ? ` — ${o.names.slice(0, 5).join(', ')}${o.names.length > 5 ? ` +${o.names.length - 5}` : ''}` : ''}`,
      color: '#34d399'
    }))
    const counts = new Map((snap?.people.by_region ?? []).map((r) => [r.region_id, r.count]))
    const regionBubbles = centroids
      .filter((c) => (counts.get(c.id) ?? 0) > 0)
      .map((c) => ({
        id: String(c.id),
        lat: c.lat,
        lng: c.lng,
        count: counts.get(c.id) ?? 0,
        label: c.label,
        color: '#34d399'
      }))
    return [...offices, ...regionBubbles]
  }, [centroids, snap, showPeople])

  const t = snap?.throughput
  const delta = t ? t.transitions_today - t.transitions_yesterday_same_time : 0

  return (
    <div className='flex h-full min-h-0 flex-1 flex-col gap-3 bg-[#0b1220] p-4 text-slate-200'>
      {/* Header strip */}
      <div className='flex shrink-0 flex-wrap items-center gap-x-6 gap-y-2'>
        <h1 className='text-[16px] font-semibold tracking-[-0.01em] text-white'>Command Center</h1>
        <span className='font-mono text-[13px] tabular-nums text-slate-400'>
          {clock.toLocaleTimeString()}
        </span>
        <span className='flex items-center gap-1.5 text-[12.5px] text-slate-300'>
          <span className='h-2 w-2 rounded-full bg-emerald-400' />
          {snap?.people.online_count ?? '–'} online
          {snap && snap.people.idle_count > 0 && (
            <span className='text-slate-500'>· {snap.people.idle_count} idle</span>
          )}
        </span>
        {t && (
          <span className='text-[12.5px] text-slate-300'>
            <b className='tabular-nums'>{t.transitions_today}</b> transitions today{' '}
            <span className={delta >= 0 ? 'text-emerald-400' : 'text-amber-400'}>
              ({delta >= 0 ? '+' : ''}
              {delta} vs yesterday)
            </span>
          </span>
        )}
        {snap && snap.risk.open_issues > 0 && (
          <button
            type='button'
            onClick={() => navigate('/issues')}
            className='rounded-full bg-red-500/15 px-2.5 py-0.5 text-[12px] font-medium text-red-400 hover:bg-red-500/25'
          >
            {snap.risk.open_issues} open issues
          </button>
        )}
        <button
          type='button'
          onClick={() => void qc.invalidateQueries({ queryKey: ['command-center'] })}
          className='ml-auto rounded-md border border-white/15 px-2.5 py-1 text-[11.5px] text-slate-300 hover:bg-white/5'
        >
          Refresh
        </button>
      </div>

      <div className='grid min-h-0 flex-1 gap-3 xl:grid-cols-[1fr_340px]'>
        {/* Map */}
        <div className={`${PANEL} flex min-h-[420px] flex-col overflow-hidden`}>
          <div className={PANEL_HEAD}>
            <span className={TITLE}>Live map</span>
            <div className='flex items-center gap-2'>
              {geoCollections.map((c) => {
                const active = showRecords && geoCollection === c
                return (
                  <button
                    key={c}
                    type='button'
                    onClick={() => {
                      // Click the lit chip to hide the layer; click any chip
                      // while hidden (or another chip) to show that layer.
                      if (geoCollection === c) setShowRecords((v) => !v)
                      else {
                        setGeoCollection(c)
                        setShowRecords(true)
                      }
                    }}
                    className={`rounded px-2 py-0.5 text-[11px] ${active ? 'bg-[#00ceff] font-medium text-[#172940]' : 'text-slate-400 hover:bg-white/5'}`}
                    title={active ? 'Hide this layer' : 'Show this layer'}
                  >
                    {titleCase(c.replace(/_/g, ' '))}
                  </button>
                )
              })}
              <button
                type='button'
                onClick={() => setShowPeople((v) => !v)}
                className={`rounded px-2 py-0.5 text-[11px] ${showPeople ? 'bg-emerald-400/20 font-medium text-emerald-300' : 'text-slate-400 hover:bg-white/5'}`}
                title='Online users by region (from scope placements)'
              >
                People
              </button>
            </div>
          </div>
          <div className='min-h-0 flex-1'>
            <BaseMap
              pins={pins}
              bubbles={bubbles}
              focus={mapFocus}
              onPinClick={(id) =>
                navigate(recordUrl ? recordUrl(geoCollection, id) : `/collections/${geoCollection}/${id}`)
              }
              statusLine={`${showRecords ? `${pins.length} ${geoCollection.replace(/_/g, ' ')}${geo?.truncated ? ' (first 500)' : ''}` : `${geoCollection.replace(/_/g, ' ')} hidden`}${bubbles.length > 0 ? ` · ${bubbles.length} groups with people on` : ''} · © OpenStreetMap`}
              minHeight={380}
            />
          </div>
        </div>

        {/* Right rail */}
        <div className='flex min-h-0 flex-col gap-3 overflow-y-auto'>
          {/* Flow board */}
          <div className={PANEL}>
            <div className={PANEL_HEAD}>
              <span className={TITLE}>Pipeline flow</span>
            </div>
            <div className='space-y-3 p-3'>
              {(snap?.flow ?? []).map((f) => {
                const total = f.states.reduce((a, s) => a + s.count, 0)
                return (
                  <div key={f.collection}>
                    <div className='mb-1 flex items-baseline justify-between'>
                      <span className='text-[12px] font-medium text-slate-200'>{f.template_name}</span>
                      <span className='text-[11px] tabular-nums text-slate-500'>{total} open</span>
                    </div>
                    <div className='flex h-2.5 overflow-hidden rounded-full bg-white/5'>
                      {f.states.map((s) => (
                        <button
                          key={s.key}
                          type='button'
                          onClick={() => navigate(`/collections/${f.collection}`)}
                          className='h-full transition-opacity hover:opacity-75'
                          style={{
                            width: `${Math.max(2, (s.count / Math.max(1, total)) * 100)}%`,
                            background: s.color ?? '#00a5cc'
                          }}
                          data-tip={`${s.label}: ${s.count}`}
                        />
                      ))}
                    </div>
                    <div className='mt-1 flex flex-wrap gap-x-3 gap-y-0.5'>
                      {f.states.map((s) => (
                        <span key={s.key} className='flex items-center gap-1 text-[10.5px] text-slate-400'>
                          <span className='h-1.5 w-1.5 rounded-full' style={{ background: s.color ?? '#00a5cc' }} />
                          {s.label} <b className='tabular-nums text-slate-300'>{s.count}</b>
                        </span>
                      ))}
                    </div>
                  </div>
                )
              })}
              {(snap?.flow ?? []).length === 0 && (
                <p className='text-[12px] text-slate-500'>No workflow-bound collections visible to you.</p>
              )}
            </div>
          </div>

          {/* People — grouped by region so the pane mirrors the map bubbles;
              clicking a region flies the map to its centroid. */}
          <div className={PANEL}>
            <div className={PANEL_HEAD}>
              <span className={TITLE}>People on now</span>
              <span className='text-[11px] tabular-nums text-slate-500'>{snap?.people.online_count ?? 0}</span>
            </div>
            <div className='space-y-2.5 p-3'>
              {(snap?.people.regions ?? []).map((g) => {
                const centroid = g.region_id != null ? centroids.find((c) => c.id === g.region_id) : null
                // Office groups carry their own coords (street-level); region
                // groups fall back to the region centroid.
                const focus =
                  g.lat != null && g.lng != null
                    ? { lat: g.lat, lng: g.lng, zoom: 12 }
                    : centroid
                      ? { lat: centroid.lat, lng: centroid.lng, zoom: 8 }
                      : null
                return (
                  <div key={`${g.region_id ?? 'x'}:${g.label}`}>
                    <button
                      type='button'
                      disabled={!focus}
                      onClick={() => focus && setMapFocus({ ...focus, nonce: Date.now() })}
                      className={`flex w-full items-center gap-1.5 text-left ${focus ? 'group cursor-pointer' : 'cursor-default'}`}
                      title={focus ? 'Show this group on the map' : 'No map placement for this group'}
                    >
                      <span className='flex h-3.5 w-3.5 items-center justify-center rounded-full border-2 border-dashed border-emerald-400/80 bg-emerald-400/25' />
                      <span className='text-[11.5px] font-semibold uppercase tracking-wide text-emerald-300 group-hover:underline'>
                        {g.label}
                      </span>
                      <span className='text-[11px] tabular-nums text-slate-500'>{g.count}</span>
                      {focus && (
                        <span className='ml-auto text-[10.5px] text-slate-500 opacity-0 transition-opacity group-hover:opacity-100'>
                          show on map →
                        </span>
                      )}
                    </button>
                    <div className='mt-1 flex flex-wrap gap-1.5 pl-5'>
                      {g.names.map((n, i) => (
                        <span key={i} className='rounded-full bg-white/5 px-2 py-0.5 text-[11.5px] text-slate-300'>
                          {n}
                        </span>
                      ))}
                    </div>
                  </div>
                )
              })}
              {(snap?.people.regions ?? []).length === 0 && (
                <p className='text-[12px] text-slate-500'>Nobody online right now.</p>
              )}
            </div>
          </div>

          {/* System rail — admins only (server withholds it otherwise) */}
          {snap?.health && (
            <div className={PANEL}>
              <div className={PANEL_HEAD}>
                <span className={TITLE}>System</span>
                <span className='text-[11px] text-slate-500'>{snap.health.instances} instance(s)</span>
              </div>
              <div className='grid grid-cols-2 gap-x-4 gap-y-1.5 p-3 text-[12px]'>
                <span className='flex items-center gap-1.5'>
                  <span className={`h-2 w-2 rounded-full ${snap.health.db_ok ? 'bg-emerald-400' : 'bg-red-500'}`} />
                  Database
                </span>
                <span className='flex items-center gap-1.5'>
                  <span className={`h-2 w-2 rounded-full ${snap.health.redis_ok ? 'bg-emerald-400' : 'bg-red-500'}`} />
                  Redis
                </span>
                <span>
                  Errors 1h:{' '}
                  <b className={`tabular-nums ${snap.health.errors_1h > 20 ? 'text-red-400' : 'text-slate-200'}`}>
                    {snap.health.errors_1h}
                  </b>
                  <span className='text-slate-500'> / {snap.health.requests_1h.toLocaleString()} req</span>
                </span>
                <span>
                  Jobs: <b className='tabular-nums'>{snap.health.jobs_running}</b> running
                  {snap.health.jobs_failed_1h > 0 && (
                    <b className='tabular-nums text-amber-400'> · {snap.health.jobs_failed_1h} failed</b>
                  )}
                </span>
                <span>
                  RSS: <b className='tabular-nums'>{snap.health.runtime.rss_mb} MB</b>
                </span>
                <span>
                  Loop lag:{' '}
                  <b className={`tabular-nums ${snap.health.runtime.event_loop_lag_ms.max_1m > 300 ? 'text-red-400' : ''}`}>
                    {snap.health.runtime.event_loop_lag_ms.max_1m} ms
                  </b>
                </span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Ticker */}
      <div className={`${PANEL} shrink-0`}>
        <div className='flex items-center gap-3 overflow-x-auto px-3 py-2'>
          <span className={`${TITLE} shrink-0`}>Live</span>
          {(snap?.activity ?? []).map((a) => (
            <button
              key={a.id}
              type='button'
              onClick={() =>
                a.collection && a.item
                  ? navigate(recordUrl ? recordUrl(a.collection, a.item) : `/collections/${a.collection}/${a.item}`)
                  : undefined
              }
              className='flex shrink-0 items-center gap-1.5 rounded-full bg-white/5 px-2.5 py-1 text-[11.5px] text-slate-300 hover:bg-white/10'
            >
              <span className='tabular-nums text-slate-500'>{rel(a.timestamp)}</span>
              <span className='font-medium text-slate-200'>{a.user_name || 'System'}</span>
              <span className='text-slate-400'>{a.action.replace(/-/g, ' ')}</span>
              {a.collection && (
                <span className='text-slate-400'>
                  {a.collection.replace(/_/g, ' ')}
                  {a.item ? ` #${a.item}` : ''}
                </span>
              )}
            </button>
          ))}
          {(snap?.activity ?? []).length === 0 && (
            <span className='text-[12px] text-slate-500'>Quiet — no recent activity you can see.</span>
          )}
        </div>
      </div>
    </div>
  )
}
