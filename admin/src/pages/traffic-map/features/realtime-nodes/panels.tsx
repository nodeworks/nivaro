// Traffic Map — inspector panels and badges for the long-lived connection, media, search and MCP
// nodes: the Sockets node (adapter lag, busiest rooms, connection problems, streams), each stream
// source, the Media and Search nodes and the MCP clients source.
import { useEffect, useState } from 'react'
import { useTrafficMap } from '../../context'
import { fmtCount, fmtMs } from '../../EventTicker'
import { Bar, Empty, Section } from '../../Inspector'
import { setDownLabel } from '../../nodeKinds'
import { sideBadges } from '../../registry/canvasLayers'
import { inspectorPanels } from '../../registry/inspectorPanels'
import { register } from '../../registry/registry'
import { toolbarItems } from '../../registry/toolbarItems'
import type { Selection } from '../../types'
import { fmtBytes } from '../b1-shared'
import { Figs, ReadEmpty, Segmented } from '../shared'
import {
  type AdapterLagData,
  badgeFigures,
  bandwidthText,
  isStreamSource,
  lagBadge,
  lagText,
  MCP_SOURCE,
  MEDIA_NODE,
  perSecond,
  type RoomRow,
  SEARCH_NODE,
  SOCKET_SOURCE,
  setBadgeFigures,
  useAdapterLag,
  useFailures,
  useMcp,
  useMedia,
  useRoomDetail,
  useRooms,
  useSearch,
  useStreams
} from './store'

setDownLabel(MEDIA_NODE, 'Media')
setDownLabel(SEARCH_NODE, 'Search')

const note = 'mt-2 text-[11.5px] text-[var(--tm-muted)]'
const rate = (n: number): string => (n < 10 ? n.toFixed(1) : Math.round(n).toLocaleString())
const spanText = (win: number): string => `${Math.max(1, Math.round(win / 60))} min`

// ── adapter lag (#2266) ──────────────────────────────────────────────────────
const LAG_TONE: Record<string, string> = {
  warn: 'var(--tm-warn-ink, var(--tm-fg-2))',
  error: 'var(--tm-error-ink)'
}

function LagBars({ lag }: { lag: AdapterLagData }) {
  const max = Math.max(1, ...lag.minutes.map((m) => m.avg_ms))
  return (
    <div
      className='mt-2 flex h-9 items-end gap-[2px]'
      role='img'
      aria-label='Average lag per minute, last 15 minutes'
    >
      {lag.minutes.map((m) => (
        <i
          key={m.min}
          className='block flex-1 rounded-[1px]'
          data-tip={
            m.n ? `${lagText(m.avg_ms)} average, ${lagText(m.max_ms)} worst (${m.n})` : 'no samples'
          }
          style={{
            height: `${m.n ? Math.max(8, (100 * m.avg_ms) / max) : 4}%`,
            background: m.n ? 'var(--tm-accent)' : 'var(--tm-line)'
          }}
        />
      ))}
    </div>
  )
}

function AdapterLagSection() {
  const q = useAdapterLag(true)
  const lag = q.data
  return (
    <Section title='Adapter lag'>
      {lag && lag.total > 0 ? (
        <div data-tm-adapter-lag={lag.level}>
          <Figs
            items={[
              ['Last 3 min', lagText(lag.recent_avg_ms), lag.level === 'error'],
              ['Worst', lagText(lag.recent_max_ms)],
              ['Relayed', fmtCount(lag.total)]
            ]}
          />
          <LagBars lag={lag} />
          {(lag.level === 'warn' || lag.level === 'error') && (
            <p
              className='mt-2 text-[12px] font-medium'
              style={{ color: LAG_TONE[lag.level] }}
              data-tm-lag-warning=''
            >
              {lag.growing && lag.level === 'warn'
                ? 'Events from other replicas are arriving later than they were.'
                : `Events from other replicas arrive ${lagText(lag.recent_avg_ms)} after they were written (the line is ${lagText(lag.warn_ms)}).`}
            </p>
          )}
          <p className={note}>
            Time from a record event being written on another replica to this one handing it to its
            sockets. Replica clocks that disagree show up here as lag.
          </p>
        </div>
      ) : (
        <ReadEmpty loading={q.isLoading} error={q.isError}>
          No events relayed from another replica yet: a single replica, or nothing written
          elsewhere.
        </ReadEmpty>
      )}
    </Section>
  )
}

// ── streams (#2155) ──────────────────────────────────────────────────────────
function StreamsSection() {
  const { win } = useTrafficMap()
  const q = useStreams(true)
  const rows = q.data?.streams ?? []
  const any = rows.some((r) => r.open > 0 || r.events > 0)
  return (
    <Section title={`Streams beside the sockets (${spanText(win)})`}>
      {any ? (
        <div className='grid gap-2' data-tm-streams=''>
          {rows.map((r) => (
            <div key={r.kind} className='min-w-0 text-[12px]' data-tip={r.hint}>
              <div className='flex items-baseline justify-between gap-2'>
                <span className='min-w-0 truncate'>{r.label}</span>
                <span className='tabular-nums text-[var(--tm-fg-2)]'>{fmtCount(r.open)} open</span>
              </div>
              <p className='text-[11.5px] tabular-nums text-[var(--tm-muted)]'>
                {fmtCount(r.events)} events · {fmtBytes(r.bytes)} · {fmtCount(r.opened)} opened
              </p>
            </div>
          ))}
        </div>
      ) : (
        <ReadEmpty loading={q.isLoading} error={q.isError}>
          No stream is open or sending on this server.
        </ReadEmpty>
      )}
    </Section>
  )
}

function StreamPanel({ sel }: { sel: Selection }) {
  const { win } = useTrafficMap()
  const q = useStreams(true)
  const row = q.data?.streams.find((r) => `stream:${r.kind}` === sel.id)
  return (
    <Section title={`Connections in the last ${spanText(win)}`}>
      {row ? (
        <>
          <Figs
            items={[
              ['Open now', fmtCount(row.open)],
              ['Peak open', fmtCount(row.peak)],
              ['Opened', fmtCount(row.opened)],
              ['Events sent', fmtCount(row.events)],
              ['Sent', fmtBytes(row.bytes)],
              ['Rate', `${rate(perSecond(row.events, win))}/s`]
            ]}
          />
          <p className={note}>
            {row.hint}. Heartbeats count toward bytes but not events. Peak open is since this server
            started.
          </p>
        </>
      ) : (
        <ReadEmpty loading={q.isLoading} error={q.isError}>
          Nothing on this stream kind yet.
        </ReadEmpty>
      )}
    </Section>
  )
}

// ── rooms (#2159) ────────────────────────────────────────────────────────────
type RoomSort = 'events' | 'members'

function RoomDetailView({ name }: { name: string }) {
  const q = useRoomDetail(name)
  const d = q.data
  if (q.isError) return <Empty>That room is gone, or it is a private one.</Empty>
  if (!d) return <Empty>Loading…</Empty>
  return (
    <div
      className='mt-1.5 grid gap-2 rounded-md bg-[var(--tm-accent-soft)] p-2'
      data-tm-room-detail=''
    >
      <div>
        <h4 className='text-[11.5px] text-[var(--tm-muted)]'>
          Members ({fmtCount(d.members_total)})
        </h4>
        {d.members.length ? (
          <p className='text-[12px]'>
            {d.members.map((m, i) => (
              <span key={m.id}>
                {i > 0 ? ', ' : ''}
                {m.name}
                {m.sockets > 1 ? ` ×${m.sockets}` : ''}
              </span>
            ))}
          </p>
        ) : (
          <p className='text-[12px] text-[var(--tm-muted)]'>No signed-in member on this server.</p>
        )}
      </div>
      <div>
        <h4 className='text-[11.5px] text-[var(--tm-muted)]'>Recent events</h4>
        {d.recent.length ? (
          <ul className='grid gap-0.5'>
            {d.recent.map((e) => (
              <li
                key={`${e.at}-${e.event}`}
                className='grid grid-cols-[auto_minmax(0,1fr)_auto] gap-2 text-[11.5px]'
              >
                <span className='font-mono tabular-nums text-[var(--tm-muted)]'>
                  {new Date(e.at).toTimeString().slice(0, 8)}
                </span>
                <span className='min-w-0 truncate font-mono'>{e.event}</span>
                <span className='tabular-nums text-[var(--tm-fg-2)]'>
                  {e.n > 1 ? `×${e.n} · ` : ''}
                  {fmtBytes(e.bytes)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className='text-[12px] text-[var(--tm-muted)]'>Nothing sent to it lately.</p>
        )}
      </div>
    </div>
  )
}

function RoomLine({
  row,
  open,
  onToggle,
  max,
  by
}: {
  row: RoomRow
  open: boolean
  onToggle: () => void
  max: number
  by: RoomSort
}) {
  const n = by === 'events' ? row.deliveries_pm : row.members
  const meta = `${fmtCount(row.members)} member${row.members === 1 ? '' : 's'} · ${rate(row.deliveries_pm)}/min`
  const label = row.hidden
    ? `${row.kind} (${fmtCount(row.rooms)} room${row.rooms === 1 ? '' : 's'})`
    : row.room
  return (
    <div>
      {row.hidden ? (
        <div data-tip='Rooms that name people or private conversations show a kind and counts only'>
          <Bar label={label} n={n} max={max} mono={false} />
          <p className='text-[11px] text-[var(--tm-muted)]'>{meta} · private, counts only</p>
        </div>
      ) : (
        <button
          type='button'
          aria-expanded={open}
          onClick={onToggle}
          className='block w-full rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
        >
          <Bar label={label} n={n} max={max} />
          <p className='text-[11px] text-[var(--tm-muted)]'>{meta}</p>
        </button>
      )}
      {open && !row.hidden && <RoomDetailView name={row.room} />}
    </div>
  )
}

function RoomsSection() {
  const { win } = useTrafficMap()
  const q = useRooms(true)
  const [by, setBy] = useState<RoomSort>('events')
  const [openRoom, setOpenRoom] = useState<string | null>(null)
  const rows = [...(q.data?.rows ?? [])]
    .sort((a, b) =>
      by === 'events'
        ? b.deliveries_pm - a.deliveries_pm || b.members - a.members
        : b.members - a.members || b.deliveries_pm - a.deliveries_pm
    )
    .slice(0, 12)
  const max = Math.max(1, ...rows.map((r) => (by === 'events' ? r.deliveries_pm : r.members)))
  return (
    <Section title={`Busiest rooms (${spanText(win)})`}>
      <div className='mb-2'>
        <Segmented
          label='Rank rooms by'
          value={by}
          options={[
            ['events', 'Events per minute'],
            ['members', 'Members']
          ]}
          onChange={setBy}
        />
      </div>
      {rows.length ? (
        <div className='grid gap-2' data-tm-rooms=''>
          {rows.map((r) => (
            <RoomLine
              key={r.room}
              row={r}
              by={by}
              max={max}
              open={openRoom === r.room}
              onToggle={() => setOpenRoom(openRoom === r.room ? null : r.room)}
            />
          ))}
          <p className={note}>
            This server only ({fmtCount(q.data?.total_rooms ?? 0)} rooms). Events are packets
            delivered to members, so a room with more members counts more.
          </p>
        </div>
      ) : (
        <ReadEmpty loading={q.isLoading} error={q.isError}>
          No room has members or traffic yet.
        </ReadEmpty>
      )}
    </Section>
  )
}

// ── connection problems (#2263) ──────────────────────────────────────────────
function Buckets({
  title,
  rows
}: {
  title: string
  rows: Array<{ key: string; n: number; people: number }>
}) {
  if (!rows.length) return null
  return (
    <div className='grid gap-1.5'>
      <h4 className='text-[11.5px] text-[var(--tm-muted)]'>{title}</h4>
      {rows.slice(0, 6).map((r) => (
        <Bar
          key={r.key}
          label={`${r.key} · ${fmtCount(r.people)} ${r.people === 1 ? 'person' : 'people'}`}
          n={r.n}
          max={rows[0].n}
          mono={false}
        />
      ))}
    </div>
  )
}

function FailuresSection() {
  const q = useFailures(true)
  const d = q.data
  const polling = d?.polling_now
  return (
    <Section title='Connection problems (last 24 h)'>
      {d && (d.total > 0 || (polling?.total ?? 0) > 0) ? (
        <div className='grid gap-3' data-tm-connection-failures=''>
          <Figs
            items={[
              ['Failed', fmtCount(d.failed), d.failed > 0],
              ['Fell back to polling', fmtCount(d.downgraded)],
              [
                'Polling now',
                `${fmtCount(polling?.total ?? 0)} / ${fmtCount(polling?.sockets ?? 0)}`
              ]
            ]}
          />
          <Buckets title='By network' rows={d.by_network} />
          <Buckets title='By browser' rows={d.by_browser} />
          <Buckets title='By app' rows={d.by_app} />
          {(polling?.total ?? 0) > 0 && (
            <Buckets title='On polling right now, by network' rows={polling?.by_network ?? []} />
          )}
          <p className={note}>
            Reported by the browsers themselves, kept in memory on this server. A network or browser
            with many reports points at a corporate proxy or an extension blocking WebSockets.
          </p>
        </div>
      ) : (
        <ReadEmpty loading={q.isLoading} error={q.isError}>
          No failed or downgraded connection reported.
        </ReadEmpty>
      )}
    </Section>
  )
}

function SocketsPanel() {
  return (
    <>
      <AdapterLagSection />
      <RoomsSection />
      <FailuresSection />
      <StreamsSection />
    </>
  )
}

register(inspectorPanels, {
  id: 'realtime-sockets',
  order: 6,
  applies: (sel) =>
    (sel.kind === 'lane' && sel.id === 'socket') ||
    (sel.kind === 'caller' && sel.id === SOCKET_SOURCE),
  Component: SocketsPanel
})

register(inspectorPanels, {
  id: 'realtime-stream',
  order: 5,
  applies: (sel) => sel.kind === 'caller' && isStreamSource(sel.id),
  Component: StreamPanel
})

// ── media (#2269) ────────────────────────────────────────────────────────────
function MediaPanel() {
  const { win } = useTrafficMap()
  const q = useMedia(true)
  const d = q.data
  const row = (title: string, who: string, r: NonNullable<typeof d>['video']) => (
    <Section title={`${title} (${spanText(win)})`}>
      {r.requests > 0 || r.active > 0 ? (
        <Figs
          items={[
            [who, fmtCount(r.active)],
            ['Requests', fmtCount(r.requests)],
            ['Failed', fmtCount(r.failed), r.failed > 0],
            ['Bandwidth', bandwidthText(r.bytes, win)],
            ['Moved', fmtBytes(r.bytes)],
            ['Avg time', r.avg_ms != null ? fmtMs(r.avg_ms) : '—']
          ]}
        />
      ) : (
        <Empty>Nothing in this window.</Empty>
      )}
    </Section>
  )
  if (!d)
    return (
      <Section title='Media'>
        <ReadEmpty loading={q.isLoading} error={q.isError}>
          No figures.
        </ReadEmpty>
      </Section>
    )
  return (
    <div data-tm-media=''>
      {row('Help-video streams', 'Viewers (last min)', d.video)}
      {row('Session-replay uploads', 'Uploaders (last min)', d.replay)}
      <Section title='How these are counted'>
        <p className='text-[12px] text-[var(--tm-fg-2)]'>
          Bandwidth is the size each response or upload declares, so a viewer who leaves part-way
          still counts the whole chunk. People are those who made a request in the last minute.
        </p>
      </Section>
    </div>
  )
}

register(inspectorPanels, {
  id: 'realtime-media',
  order: 5,
  applies: (sel) => sel.kind === 'down' && sel.id === MEDIA_NODE,
  Component: MediaPanel
})

// ── search (#2270) ───────────────────────────────────────────────────────────
function SearchPanel() {
  const { win } = useTrafficMap()
  const q = useSearch(true)
  const d = q.data
  return (
    <div data-tm-search=''>
      <Section title={`Searches (${spanText(win)})`}>
        {d && d.total.requests > 0 ? (
          <>
            <Figs
              items={[
                ['Searches', fmtCount(d.total.requests)],
                ['Database time', fmtMs(d.total.db_ms)],
                ['Avg per search', d.total.avg_db_ms != null ? fmtMs(d.total.avg_db_ms) : '—'],
                ['Failed', fmtCount(d.total.failed), d.total.failed > 0]
              ]}
            />
            <div className='mt-3 grid gap-1.5'>
              {d.by_kind.map((k) => (
                <div
                  key={k.kind}
                  data-tip={`${fmtCount(k.requests)} searches, ${k.avg_ms != null ? fmtMs(k.avg_ms) : '—'} each`}
                >
                  <Bar label={k.label} n={k.db_ms} max={d.by_kind[0].db_ms} mono={false} />
                </div>
              ))}
              <p className={note}>Bars are database time spent on each kind of search.</p>
            </div>
          </>
        ) : (
          <ReadEmpty loading={q.isLoading} error={q.isError}>
            No search ran in this window.
          </ReadEmpty>
        )}
      </Section>
      {d && d.slowest.length > 0 && (
        <Section title='Slowest queries'>
          <ul className='grid gap-2' data-tm-search-slowest=''>
            {d.slowest.slice(0, 6).map((s) => (
              <li key={`${s.at}-${s.route}-${s.db_ms}`} className='min-w-0 text-[12px]'>
                <div className='flex items-baseline justify-between gap-2'>
                  <span className='min-w-0 truncate'>{s.label}</span>
                  <span className='tabular-nums font-medium'>{fmtMs(s.db_ms)} in the database</span>
                </div>
                <p className='text-[11.5px] text-[var(--tm-muted)]'>
                  {new Date(s.at).toTimeString().slice(0, 8)} · {fmtMs(s.ms)} total
                  {s.stmt_ms != null ? ` · slowest statement ${fmtMs(s.stmt_ms)}` : ''}
                </p>
                {s.sql && (
                  <code className='mt-0.5 block max-h-14 overflow-hidden break-all font-mono text-[10.5px] text-[var(--tm-fg-2)]'>
                    {s.sql}
                  </code>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  )
}

register(inspectorPanels, {
  id: 'realtime-search',
  order: 5,
  applies: (sel) => sel.kind === 'down' && sel.id === SEARCH_NODE,
  Component: SearchPanel
})

// ── MCP clients (#2211) ──────────────────────────────────────────────────────
function McpPanel() {
  const { win } = useTrafficMap()
  const q = useMcp(true)
  const d = q.data
  return (
    <div data-tm-mcp=''>
      <Section title={`Calls from AI assistants (${spanText(win)})`}>
        {d && d.calls > 0 ? (
          <Figs
            items={[
              ['Calls', fmtCount(d.calls)],
              ['Errors', fmtCount(d.errors), d.errors > 0],
              ['Tools used', fmtCount(d.tools.length)]
            ]}
          />
        ) : (
          <ReadEmpty loading={q.isLoading} error={q.isError}>
            No MCP call in this window.
          </ReadEmpty>
        )}
      </Section>
      {d && d.tools.length > 0 && (
        <Section title='Tools'>
          <div className='grid gap-1.5'>
            {d.tools.slice(0, 10).map((t) => (
              <Bar
                key={t.tool}
                label={t.errors ? `${t.tool} · ${t.errors} failed` : t.tool}
                n={t.calls}
                max={d.tools[0].calls}
                color={t.errors ? 'var(--tm-error)' : undefined}
              />
            ))}
          </div>
        </Section>
      )}
      {d && d.keys.length > 0 && (
        <Section title='API keys'>
          <div className='grid gap-1.5'>
            {d.keys.slice(0, 8).map((k) => (
              <Bar
                key={k.caller}
                label={k.errors ? `${k.name} · ${k.errors} failed` : k.name}
                n={k.calls}
                max={d.keys[0].calls}
                mono={false}
              />
            ))}
          </div>
        </Section>
      )}
      {d && d.recent_errors.length > 0 && (
        <Section title='Recent errors'>
          <ul className='grid gap-1' data-tm-mcp-errors=''>
            {d.recent_errors.slice(0, 6).map((e) => (
              <li
                key={`${e.at}-${e.tool}`}
                className='grid grid-cols-[auto_minmax(0,1fr)_auto] gap-2 text-[11.5px]'
              >
                <span className='font-mono tabular-nums text-[var(--tm-muted)]'>
                  {new Date(e.at).toTimeString().slice(0, 8)}
                </span>
                <span className='min-w-0 truncate'>
                  {e.tool} · {e.name}
                </span>
                <span className='tabular-nums text-[var(--tm-error-ink)]'>
                  {e.code ?? e.status}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  )
}

register(inspectorPanels, {
  id: 'realtime-mcp',
  order: 5,
  applies: (sel) => sel.kind === 'caller' && sel.id === MCP_SOURCE,
  Component: McpPanel
})

// ── badges + the poller that feeds them ─────────────────────────────────────
function RealtimePoller() {
  const lag = useAdapterLag(true)
  const media = useMedia(true)
  const mcp = useMcp(true)
  useEffect(() => {
    setBadgeFigures({ lag: lag.data ?? null, media: media.data ?? null, mcp: mcp.data ?? null })
  }, [lag.data, media.data, mcp.data])
  useEffect(() => () => setBadgeFigures({ lag: null, media: null, mcp: null }), [])
  return null
}
register(toolbarItems, { id: 'realtime-nodes-poller', order: 998, Component: RealtimePoller })

register(sideBadges, {
  id: 'realtime-nodes',
  badge(kind, id) {
    const f = badgeFigures()
    if (kind === 'caller' && id === SOCKET_SOURCE) return lagBadge(f.lag)
    if (kind === 'down' && id === MEDIA_NODE && f.media) {
      const failed = f.media.video.failed + f.media.replay.failed
      return failed > 0 ? { text: `${failed} failed`, tone: 'error' } : null
    }
    if (kind === 'caller' && id === MCP_SOURCE && f.mcp && f.mcp.errors > 0)
      return { text: `${f.mcp.errors} error${f.mcp.errors === 1 ? '' : 's'}`, tone: 'warn' }
    return null
  }
})
