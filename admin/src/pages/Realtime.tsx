import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Pencil, Radio, RefreshCw } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { adminRealtime, joinWatchRoom } from '@/lib/socket'
import { cn } from '@/lib/utils'
import { SocketHealthTab } from './realtime/SocketHealthTab'
import { VerifyTab } from './realtime/VerifyTab'

/**
 * Realtime console (#270 diagnostics, #273 now-editing, #275 concurrency
 * history, #276 live traffic, #285 force refresh, #1682 event pipeline +
 * delivery probe). Everything here is per-API-node observability — the stats
 * route says so in its payload.
 */

type Tab =
  | 'sockets'
  | 'health'
  | 'payload'
  | 'traffic'
  | 'editing'
  | 'concurrency'
  | 'firehose'
  | 'pipeline'
  | 'verify'

const REALTIME_TABS: Array<[Tab, string]> = [
  ['sockets', 'Sockets & rooms'],
  ['health', 'Socket health'],
  ['payload', 'Payload size'],
  ['traffic', 'Live traffic'],
  ['editing', 'Now editing'],
  ['concurrency', 'Concurrency'],
  ['firehose', 'Firehose'],
  ['pipeline', 'Event pipeline'],
  ['verify', 'Verification']
]

interface SocketRow {
  id: string
  user: string | null
  app: string | null
  connected_seconds: number
  rtt_ms: number | null
  reconnects: number
  room_count: number
  rooms: string[]
  build?: string | null
  api_version?: string | null
  /** #1672 — 'websocket', or 'polling' when the upgrade was blocked. */
  transport?: string | null
  /** #1681 — the client takes coalesced collection:update bursts. */
  coalesce?: boolean
  /** #2475 — a browser's shared worker: one connection carrying every tab of that app. */
  shared_worker?: boolean
}

/** #1730 — bytes written to sockets, by event type and by room kind (this node). */
interface TransportTraffic {
  since: string
  events: number
  bytes: number
  coalesced: { bursts: number; messages_saved: number }
  by_event: Array<{ event: string; count: number; bytes: number }>
  by_room: Array<{ room: string; count: number; bytes: number }>
}

interface RealtimeStats {
  node_scope: string
  journal_seq: number
  socket_count: number
  sockets: SocketRow[]
  rooms: Array<{ room: string; size: number }>
  api_version?: string
  versions?: VersionGroup[]
  versions_scope?: VersionsScope
  transports?: Record<string, number>
  /** #2475 — connections that are shared workers, and distinct signed-in people (this node). */
  shared_worker_count?: number
  people_count?: number
  sse_streams?: number
  polling_allowed?: boolean
  compression?: boolean
  traffic?: TransportTraffic
}

/** #1048 — how much of the cluster the versions list covers. */
interface VersionsScope {
  /** API processes with signed-in sockets. */
  nodes: number
  /** Another replica did not answer: only this node's tabs are counted. */
  partial: boolean
  /** API versions the replicas serve right now (two = a deploy is rolling). */
  roster?: string[]
  /** app → why it is not judged yet (its deploy is still rolling). */
  settling?: Record<string, string>
}

/** #1048 — open tabs grouped by the build they run (every API replica). */
interface VersionGroup {
  app: string | null
  build: string | null
  api: string | null
  sockets: number
  users: number
  current: boolean
  older: 'build' | 'api' | null
  newest_load: string | null
  /** Who is on it (first 25 by name). */
  people?: Array<{ id: string; name: string }>
  /** Set while this app's deploy is still rolling: not judged, never reloaded as old. */
  settling?: string | null
}

export default function Realtime() {
  // ?tab=<key> opens that tab (the SLO panel links to ?tab=verify).
  const [tab, setTab] = useState<Tab>(() => {
    const asked =
      typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('tab') : null
    return REALTIME_TABS.some(([k]) => k === asked) ? (asked as Tab) : 'sockets'
  })
  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='shrink-0 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'>
        <div className='flex items-center justify-between gap-4'>
          <div className='flex items-center gap-2.5'>
            <Radio className='h-5 w-5 text-muted-foreground' />
            <div>
              <h1 className='text-[17px] font-semibold text-slate-900 dark:text-foreground'>
                Realtime
              </h1>
              <p className='mt-0.5 text-[12.5px] text-slate-500 dark:text-muted-foreground'>
                Who's connected, what's flowing, who's editing what — live from this API node.
              </p>
            </div>
          </div>
          <ForceRefreshControl />
        </div>
        <div
          role='tablist'
          aria-label='Realtime views'
          className='-mx-1 mt-3 flex gap-1 overflow-x-auto px-1'
        >
          {REALTIME_TABS.map(([key, label]) => (
            <button
              key={key}
              type='button'
              role='tab'
              aria-selected={tab === key}
              onClick={() => setTab(key)}
              className={cn(
                'shrink-0 whitespace-nowrap rounded-md px-3 py-1.5 text-[12.5px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan',
                tab === key
                  ? 'bg-[#00ceff]/10 text-[#0e7490] dark:text-[#67e8f9]'
                  : 'text-slate-500 hover:bg-muted dark:text-muted-foreground'
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </header>
      <div className='flex-1 overflow-y-auto p-6'>
        {tab === 'sockets' && <SocketsTab />}
        {tab === 'health' && <SocketHealthTab />}
        {tab === 'payload' && <PayloadTab />}
        {tab === 'traffic' && <TrafficTab />}
        {tab === 'editing' && <EditingTab />}
        {tab === 'concurrency' && <ConcurrencyTab />}
        {tab === 'firehose' && <FirehoseTab />}
        {tab === 'pipeline' && <PipelineTab />}
        {tab === 'verify' && <VerifyTab />}
      </div>
    </div>
  )
}

// ─── Force refresh (#285) ────────────────────────────────────────────────────

type RefreshWho = 'everyone' | 'app' | 'people' | 'older'

function ForceRefreshControl() {
  const [open, setOpen] = useState(false)
  const [seconds, setSeconds] = useState('30')
  const [message, setMessage] = useState('')
  const [who, setWho] = useState<RefreshWho>('everyone')
  const [app, setApp] = useState('admin')
  const [people, setPeople] = useState<Array<{ id: string; name: string }>>([])
  const [search, setSearch] = useState('')
  const [sending, setSending] = useState(false)
  const { data: stats } = useQuery<{
    sockets: SocketRow[]
    versions?: VersionGroup[]
    versions_scope?: VersionsScope
  }>({
    queryKey: ['realtime-stats'],
    queryFn: () => api.get('/realtime/stats').then((r) => r.data.data),
    enabled: open,
    staleTime: 10_000
  })
  const apps = useMemo(() => {
    const seen = new Set<string>(['admin'])
    for (const s of stats?.sockets ?? []) if (s.app) seen.add(s.app)
    // Apps open on other replicas too (the versions list reads the whole cluster).
    for (const g of stats?.versions ?? []) if (g.app) seen.add(g.app)
    return [...seen]
  }, [stats])
  const { data: found = [] } = useQuery<Array<{ id: string; name: string }>>({
    queryKey: ['force-refresh-people', search],
    queryFn: () =>
      api
        .get<{
          data: Array<{ id: string; first_name?: string; last_name?: string; email: string }>
        }>('/users', { params: { search, limit: 8 } })
        .then((r) =>
          r.data.data.map((u) => ({
            id: u.id,
            name: `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || u.email
          }))
        ),
    enabled: open && who === 'people' && search.trim().length >= 2,
    staleTime: 30_000
  })
  const canSend = who !== 'people' || people.length > 0
  return (
    <div className='relative'>
      <button
        type='button'
        onClick={() => setOpen((o) => !o)}
        className='inline-flex items-center gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-[12.5px] font-medium text-amber-800 hover:bg-amber-100 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300'
      >
        <RefreshCw className='h-3.5 w-3.5' />
        Force client refresh…
      </button>
      {open && (
        <div className='absolute right-0 top-full z-20 mt-1 w-[340px] rounded-lg border border-slate-200 bg-white p-3 shadow-lg dark:border-border dark:bg-card'>
          <p className='text-[12px] text-slate-600 dark:text-muted-foreground'>
            The targeted clients show a countdown, then reload. Use for a deploy that must land now.
          </p>
          <div className='mt-2 flex flex-wrap gap-1' data-force-refresh-who={who}>
            {(
              [
                ['everyone', 'Everyone'],
                ['app', 'One app'],
                ['people', 'Specific people'],
                ['older', 'Old versions']
              ] as Array<[RefreshWho, string]>
            ).map(([key, label]) => (
              <button
                key={key}
                type='button'
                onClick={() => setWho(key)}
                className={cn(
                  'whitespace-nowrap rounded-md px-2 py-1 text-[11.5px] font-medium',
                  who === key
                    ? 'bg-amber-100 text-amber-900 dark:bg-amber-500/20 dark:text-amber-200'
                    : 'text-slate-500 hover:bg-muted dark:text-muted-foreground'
                )}
              >
                {label}
              </button>
            ))}
          </div>
          {who === 'app' && (
            <div className='mt-2 flex flex-wrap gap-1'>
              {apps.map((a) => (
                <button
                  key={a}
                  type='button'
                  onClick={() => setApp(a)}
                  className={cn(
                    'rounded-full border px-2 py-0.5 text-[11.5px]',
                    app === a
                      ? 'border-amber-400 bg-amber-50 text-amber-900 dark:bg-amber-500/15 dark:text-amber-200'
                      : 'border-slate-200 text-slate-500 hover:bg-muted dark:border-border'
                  )}
                >
                  {a}
                </button>
              ))}
              <span className='w-full text-[11px] text-slate-400'>
                Reaches that app's tabs on every API replica — apps appear once one of their tabs is
                open.
              </span>
            </div>
          )}
          {who === 'older' && (
            <OlderTabsNote groups={stats?.versions ?? []} scope={stats?.versions_scope} />
          )}
          {who === 'people' && (
            <div className='mt-2'>
              {people.length > 0 && (
                <div className='mb-1.5 flex flex-wrap gap-1'>
                  {people.map((p) => (
                    <span
                      key={p.id}
                      className='inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11.5px] text-amber-900 dark:bg-amber-500/15 dark:text-amber-200'
                    >
                      {p.name}
                      <button
                        type='button'
                        aria-label={`Remove ${p.name}`}
                        onClick={() => setPeople((cur) => cur.filter((c) => c.id !== p.id))}
                        className='text-amber-700 hover:text-amber-900 dark:text-amber-300'
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder='Search people by name or email…'
                className='h-7 w-full rounded-md border border-slate-200 bg-background px-2 text-[12px] dark:border-border'
              />
              {search.trim().length >= 2 && (
                <div className='mt-1 max-h-40 overflow-y-auto rounded-md border border-slate-200 dark:border-border'>
                  {found.filter((f) => !people.some((p) => p.id === f.id)).length === 0 ? (
                    <p className='px-2 py-1.5 text-[11.5px] text-slate-400'>No matches</p>
                  ) : (
                    found
                      .filter((f) => !people.some((p) => p.id === f.id))
                      .map((f) => (
                        <button
                          key={f.id}
                          type='button'
                          onClick={() => {
                            setPeople((cur) => [...cur, f])
                            setSearch('')
                          }}
                          className='block w-full px-2 py-1.5 text-left text-[12px] hover:bg-muted'
                        >
                          {f.name}
                        </button>
                      ))
                  )}
                </div>
              )}
            </div>
          )}
          <label className='mt-2 flex items-center gap-2 text-[12px]'>
            Countdown
            <input
              value={seconds}
              onChange={(e) => setSeconds(e.target.value)}
              inputMode='numeric'
              className='h-7 w-16 rounded-md border border-slate-200 bg-background px-2 text-right text-[12px] dark:border-border'
            />
            seconds
          </label>
          <input
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder='Optional message shown in the banner'
            className='mt-2 h-7 w-full rounded-md border border-slate-200 bg-background px-2 text-[12px] dark:border-border'
          />
          <div className='mt-2 flex justify-end gap-2'>
            <button
              type='button'
              onClick={() => setOpen(false)}
              className='rounded-md px-2.5 py-1 text-[12px] text-slate-500 hover:bg-muted'
            >
              Cancel
            </button>
            <button
              type='button'
              disabled={sending || !canSend}
              onClick={async () => {
                setSending(true)
                try {
                  const body: Record<string, unknown> = {
                    seconds: Number(seconds) || 30,
                    message
                  }
                  if (who === 'app') body.app = app
                  if (who === 'people') body.user_ids = people.map((p) => p.id)
                  if (who === 'older') body.older = true
                  const r = await api.post<{
                    data: {
                      sockets: number
                      users: number
                      partial?: boolean
                      settling?: Record<string, string>
                    }
                  }>('/realtime/force-refresh', body)
                  const { sockets, users, partial, settling } = r.data.data
                  const skipped = Object.keys(settling ?? {})
                  const tail =
                    (partial
                      ? ' — another API replica did not answer, so only this one was reached'
                      : '') +
                    (skipped.length
                      ? ` — tabs on the builds ${skipped.join(', ')} is rolling out were left alone`
                      : '')
                  toast.success(
                    who === 'everyone'
                      ? 'Refresh pushed to every connected client'
                      : sockets > 0
                        ? `Refresh pushed to ${sockets} open tab${sockets === 1 ? '' : 's'} (${users} ${users === 1 ? 'person' : 'people'})${tail}`
                        : `Refresh sent — nobody matching is connected right now${tail}`
                  )
                  setOpen(false)
                } catch {
                  toast.error('Failed to send the refresh')
                } finally {
                  setSending(false)
                }
              }}
              className='rounded-md bg-amber-500 px-2.5 py-1 text-[12px] font-semibold text-white hover:bg-amber-600 disabled:opacity-50'
            >
              {sending ? 'Sending…' : 'Push refresh'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Open tabs by version (#1048) ────────────────────────────────────────────

function olderCount(groups: VersionGroup[]): { tabs: number; people: number } {
  let tabs = 0
  let people = 0
  for (const g of groups) {
    if (!g.older) continue
    tabs += g.sockets
    people += g.users
  }
  return { tabs, people }
}

function scopeText(scope: VersionsScope | undefined): string {
  if (!scope) return ''
  const parts: string[] = []
  if (scope.partial)
    parts.push('Another API replica did not answer — only tabs connected to this one are counted.')
  else if (scope.nodes > 1) parts.push(`Counts tabs on all ${scope.nodes} API replicas.`)
  const settling = Object.entries(scope.settling ?? {})
  if (settling.length)
    parts.push(
      `Still deploying — tabs on the builds being rolled out are not judged or reloaded; older builds are: ${settling.map(([app, why]) => `${app} (${why})`).join('; ')}.`
    )
  return parts.join(' ')
}

function OlderTabsNote({ groups, scope }: { groups: VersionGroup[]; scope?: VersionsScope }) {
  const { tabs, people } = olderCount(groups)
  return (
    <p
      className='mt-2 text-[11.5px] text-slate-500 dark:text-muted-foreground'
      data-older-tabs={tabs}
    >
      {tabs > 0
        ? `Reaches ${tabs} tab${tabs === 1 ? '' : 's'} (${people} ${people === 1 ? 'person' : 'people'}) still running an older build or loaded against an older API. Tabs on the current version are left alone.`
        : 'No open tab runs an older version right now — nothing would reload.'}{' '}
      {scopeText(scope)}
    </p>
  )
}

function versionStatus(g: VersionGroup): { label: string; tone: string } {
  if (g.settling)
    return {
      label: 'Deploy in progress',
      tone: 'bg-sky-50 text-sky-800 dark:bg-sky-500/15 dark:text-sky-200'
    }
  if (g.older === 'build')
    return {
      label: 'Older build',
      tone: 'bg-amber-100 text-amber-900 dark:bg-amber-500/20 dark:text-amber-200'
    }
  if (g.older === 'api')
    return {
      label: 'Loaded before the API update',
      tone: 'bg-amber-100 text-amber-900 dark:bg-amber-500/20 dark:text-amber-200'
    }
  if (g.current)
    return {
      label: 'Current',
      tone: 'bg-emerald-50 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-200'
    }
  return {
    label: 'Not reported',
    tone: 'bg-slate-100 text-slate-600 dark:bg-muted dark:text-muted-foreground'
  }
}

function VersionsTable({
  groups,
  apiVersion,
  scope
}: {
  groups: VersionGroup[]
  apiVersion: string
  scope?: VersionsScope
}) {
  if (groups.length === 0) return null
  return (
    <div data-realtime-versions>
      <h2 className='mb-1 text-[13px] font-medium'>Open tabs by version</h2>
      <p className='mb-2 text-[12px] text-slate-500 dark:text-muted-foreground'>
        This API runs {apiVersion}. Admin's current build is the version every API replica serves;
        another app's is the one its newest page load reported, once only one build of it has loaded
        for 10 minutes. A tab is older when it runs another build, or first talked to an older API.
        Use Force client refresh → Old versions to reload just those. {scopeText(scope)}
      </p>
      <div className='overflow-x-auto rounded-lg border border-slate-200 dark:border-border'>
        <table className='w-full text-[12px] tabular-nums'>
          <thead>
            <tr className='border-b border-slate-200 bg-slate-50 text-left text-[11px] text-slate-500 dark:border-border dark:bg-muted/40 dark:text-muted-foreground'>
              <th className='px-3 py-2 font-medium'>App</th>
              <th className='px-3 py-2 font-medium'>Build</th>
              <th className='px-3 py-2 font-medium'>API it loaded against</th>
              <th className='px-3 py-2 text-right font-medium'>Tabs</th>
              <th className='px-3 py-2 text-right font-medium'>People</th>
              <th className='px-3 py-2 font-medium'>Who</th>
              <th className='px-3 py-2 font-medium'>Status</th>
            </tr>
          </thead>
          <tbody className='divide-y divide-slate-100 dark:divide-border/60'>
            {groups.map((g) => {
              const st = versionStatus(g)
              return (
                <tr
                  key={`${g.app}|${g.build}|${g.api}`}
                  data-version-group={`${g.app ?? ''}:${g.build ?? ''}`}
                  data-version-older={g.older ?? ''}
                  data-version-settling={g.settling ? '1' : undefined}
                >
                  <td className='px-3 py-1.5'>{g.app ?? '—'}</td>
                  <td className='px-3 py-1.5 font-mono text-[11px]'>{g.build ?? '—'}</td>
                  <td className='px-3 py-1.5 font-mono text-[11px]'>{g.api ?? '—'}</td>
                  <td className='px-3 py-1.5 text-right'>{g.sockets}</td>
                  <td className='px-3 py-1.5 text-right'>{g.users}</td>
                  <td className='max-w-[280px] px-3 py-1.5'>
                    <PeopleCell group={g} />
                  </td>
                  <td className='px-3 py-1.5'>
                    <span className={cn('rounded-full px-2 py-0.5 text-[11px]', st.tone)}>
                      {st.label}
                    </span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** Names on a build; the full list (first 25 the API sends) in the tip. */
function PeopleCell({ group }: { group: VersionGroup }) {
  const names = (group.people ?? []).map((p) => p.name)
  if (names.length === 0) return <span className='text-slate-400'>—</span>
  const more = group.users - names.length
  const text = names.join(', ') + (more > 0 ? ` +${more} more` : '')
  return (
    <span
      className='block truncate text-slate-600 dark:text-slate-300'
      data-tip={text}
      data-version-people={names.length}
    >
      {text}
    </span>
  )
}

// ─── Sockets & rooms (#270) ──────────────────────────────────────────────────

function SocketsTab() {
  const [inspecting, setInspecting] = useState<string | null>(null)
  const { data, isLoading } = useQuery<RealtimeStats>({
    queryKey: ['realtime-stats'],
    queryFn: () => api.get('/realtime/stats').then((r) => r.data.data),
    refetchInterval: 10_000
  })
  if (isLoading) return <p className='text-[13px] text-slate-400'>Loading…</p>
  if (!data) return null
  return (
    <div className='space-y-4'>
      <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
        {data.socket_count} socket(s) on this node · journal seq {data.journal_seq} ·{' '}
        {data.node_scope}
      </p>
      <TransportStrip data={data} />
      <VersionsTable
        groups={data.versions ?? []}
        apiVersion={data.api_version ?? '—'}
        scope={data.versions_scope}
      />
      <div className='overflow-x-auto rounded-lg border border-slate-200 dark:border-border'>
        <table className='w-full text-[12px] tabular-nums'>
          <thead>
            <tr className='border-b border-slate-200 bg-slate-50 text-left text-[10.5px] uppercase tracking-wide text-slate-400 dark:border-border dark:bg-muted/40'>
              <th className='px-3 py-2'>User</th>
              <th className='px-3 py-2'>App</th>
              <th className='px-3 py-2'>Transport</th>
              <th className='px-3 py-2'>Build</th>
              <th className='px-3 py-2 text-right'>Connected</th>
              <th className='px-3 py-2 text-right'>RTT</th>
              <th className='px-3 py-2 text-right'>Reconnects</th>
              <th className='px-3 py-2'>Rooms</th>
              <th className='px-3 py-2' />
            </tr>
          </thead>
          <tbody className='divide-y divide-slate-100 dark:divide-border/60'>
            {data.sockets.map((s) => (
              <tr key={s.id}>
                <td className='px-3 py-1.5 font-mono text-[11px]'>{s.user ?? '(unauth)'}</td>
                <td className='px-3 py-1.5'>
                  {s.app ?? '—'}
                  {s.shared_worker && (
                    <span
                      className='ml-1 rounded bg-slate-100 px-1 text-[10px] text-slate-500 dark:bg-muted dark:text-muted-foreground'
                      data-tip='A shared worker: one connection for every tab of this app in that browser'
                    >
                      shared
                    </span>
                  )}
                </td>
                <td className='px-3 py-1.5'>
                  <span
                    className={cn(
                      'font-mono text-[11px]',
                      s.transport === 'polling' && 'text-amber-700 dark:text-amber-300'
                    )}
                  >
                    {s.transport ?? '—'}
                  </span>
                </td>
                <td className='px-3 py-1.5 font-mono text-[11px]'>{s.build ?? '—'}</td>
                <td className='px-3 py-1.5 text-right'>{formatDuration(s.connected_seconds)}</td>
                <td className='px-3 py-1.5 text-right'>
                  {s.rtt_ms != null ? `${s.rtt_ms}ms` : '—'}
                </td>
                <td className='px-3 py-1.5 text-right'>{s.reconnects}</td>
                <td className='max-w-[420px] truncate px-3 py-1.5 text-[11px] text-slate-500'>
                  {s.room_count} · {s.rooms.join(', ')}
                </td>
                <td className='px-3 py-1.5 text-right'>
                  <button
                    type='button'
                    onClick={() => setInspecting(inspecting === s.id ? null : s.id)}
                    data-inspect-socket={s.id}
                    className='rounded-md border border-slate-200 px-2 py-0.5 text-[11px] font-medium text-slate-600 hover:bg-slate-50 dark:border-border dark:text-slate-300 dark:hover:bg-muted'
                  >
                    {inspecting === s.id ? 'Close' : 'Inspect'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {inspecting && <SocketInspector id={inspecting} onClose={() => setInspecting(null)} />}
      <div>
        <h2 className='mb-2 text-[13px] font-medium'>Busiest rooms</h2>
        <div className='flex flex-wrap gap-1.5'>
          {data.rooms.slice(0, 40).map((r) => (
            <span
              key={r.room}
              className='rounded-full border border-slate-200 bg-white px-2.5 py-0.5 font-mono text-[11px] text-slate-600 dark:border-border dark:bg-card dark:text-slate-300'
            >
              {r.room} · {r.size}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}

/**
 * #1731 — Socket inspector: one client's rooms and the last 100 events sent to it. Recording is
 * off on the server until you open this panel; it stops when you close it (or after 10 minutes
 * unread). Names, sizes and times only — never what the events said.
 */
interface InspectView {
  id: string
  user: string | null
  app: string | null
  transport: string | null
  rooms: string[]
  recording: boolean
  ring: number
  events: Array<{
    at: string
    event: string
    room: string | null
    bytes: number
    /** #2779 — 'in' = an event the client sent, with its handler time. */
    dir?: 'in' | 'out'
    ms?: number
  }>
  /** #2460 / #2488 — what is waiting to be sent to this client. */
  buffer?: {
    waiting: number
    peak: number
    mode: 'ok' | 'soft'
    soft_since: string | null
    soft_count: number
    held_rooms: number
    suppressed: number
    limits: { soft: number; hard: number }
  } | null
}

function SocketInspector({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient()
  const key = ['realtime-inspect', id]
  const start = useMutation({
    mutationFn: () => api.post(`/realtime/sockets/${id}/inspect`).then((r) => r.data.data),
    onSuccess: (view: InspectView) => qc.setQueryData(key, view),
    onError: (err: any) => toast.error(err?.response?.data?.error ?? 'Could not start inspecting')
  })
  // biome-ignore lint/correctness/useExhaustiveDependencies: start/stop on the socket id only
  useEffect(() => {
    start.mutate()
    return () => {
      void api.delete(`/realtime/sockets/${id}/inspect`).catch(() => undefined)
    }
  }, [id])
  const { data } = useQuery<InspectView>({
    queryKey: key,
    queryFn: () => api.get(`/realtime/sockets/${id}/inspect`).then((r) => r.data.data),
    enabled: start.isSuccess,
    refetchInterval: 2_000,
    retry: false
  })
  return (
    <div
      data-socket-inspector={id}
      className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'
    >
      <div className='flex items-center justify-between border-b border-slate-200 px-3 py-2 dark:border-border'>
        <h2 className='text-[13px] font-medium'>
          Inspecting {data?.user ?? 'client'} · {data?.app ?? 'app'} · {data?.transport ?? '—'}
        </h2>
        <button
          type='button'
          onClick={onClose}
          className='text-[11px] text-slate-500 hover:underline'
        >
          Close
        </button>
      </div>
      {!data ? (
        <p className='px-3 py-3 text-[12px] text-slate-400'>
          {start.isError ? 'This client is no longer connected to this node.' : 'Starting…'}
        </p>
      ) : (
        <div className='space-y-3 p-3'>
          {data.buffer && (
            <p className='text-[12px] text-slate-600 dark:text-slate-300' data-inspect-buffer>
              {formatBytes(data.buffer.waiting)} waiting to send (peak{' '}
              {formatBytes(data.buffer.peak)}).{' '}
              {data.buffer.mode === 'soft' ? (
                <span className='font-medium text-amber-700 dark:text-amber-300'>
                  Held back since{' '}
                  {data.buffer.soft_since
                    ? new Date(data.buffer.soft_since).toLocaleTimeString()
                    : 'just now'}
                  : {data.buffer.held_rooms} room(s) to refetch once it catches up.
                </span>
              ) : data.buffer.soft_count > 0 ? (
                `Held back ${data.buffer.soft_count} time(s); ${data.buffer.suppressed} event(s) replaced by refetch notices.`
              ) : (
                'Keeping up.'
              )}
            </p>
          )}
          <div>
            <div className='mb-1 text-[10.5px] uppercase tracking-wide text-slate-400'>
              Rooms ({data.rooms.length})
            </div>
            <div className='flex flex-wrap gap-1.5'>
              {data.rooms.map((r) => (
                <span
                  key={r}
                  className='rounded-full border border-slate-200 px-2 py-0.5 font-mono text-[11px] text-slate-600 dark:border-border dark:text-slate-300'
                >
                  {r}
                </span>
              ))}
            </div>
          </div>
          <div>
            <div className='mb-1 text-[10.5px] uppercase tracking-wide text-slate-400'>
              Events since you opened this ({data.events.length} of last {data.ring})
            </div>
            {data.events.length === 0 ? (
              <p className='text-[12px] text-slate-400'>Nothing sent yet — waiting for traffic.</p>
            ) : (
              <div className='max-h-[320px] overflow-y-auto'>
                <table className='w-full text-[12px] tabular-nums'>
                  <tbody className='divide-y divide-slate-100 dark:divide-border/60'>
                    {data.events.map((e, i) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: ring has no ids
                      <tr key={`${e.at}-${i}`}>
                        <td className='px-2 py-1 text-slate-500'>
                          {new Date(e.at).toLocaleTimeString()}
                        </td>
                        <td className='px-2 py-1 font-mono text-[11px]'>
                          <span
                            className='mr-1.5 text-slate-400'
                            data-tip={e.dir === 'in' ? 'Sent by the client' : 'Sent to the client'}
                          >
                            {e.dir === 'in' ? '←' : '→'}
                          </span>
                          {e.event}
                        </td>
                        <td className='px-2 py-1 font-mono text-[11px] text-slate-500'>
                          {e.dir === 'in' ? 'handled' : (e.room ?? 'direct')}
                        </td>
                        <td className='px-2 py-1 text-right'>
                          {e.dir === 'in' && e.ms != null ? (
                            <span
                              className={cn(
                                e.ms >= 1000
                                  ? 'text-red-600 dark:text-red-400'
                                  : e.ms >= 100
                                    ? 'text-amber-700 dark:text-amber-300'
                                    : undefined
                              )}
                            >
                              {e.ms < 10 ? e.ms.toFixed(1) : Math.round(e.ms)} ms
                            </span>
                          ) : (
                            `${e.bytes} B`
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * #1672 — how clients reach this node: sockets per transport, plus the read-only SSE streams
 * tabs fall back to when neither websocket nor polling gets through.
 */
function TransportStrip({ data }: { data: RealtimeStats }) {
  const t = data.transports ?? {}
  const cells: Array<[string, string, string]> = [
    ['Websocket', String(t.websocket ?? 0), 'Sockets on the websocket transport'],
    [
      'Long-polling',
      String(t.polling ?? 0),
      'Sockets whose websocket upgrade was blocked (a proxy stripped it) and fell back to HTTP long-polling — needs sticky sessions behind a load balancer'
    ],
    [
      'SSE fallback',
      String(data.sse_streams ?? 0),
      'Read-only event streams: the tab could reach neither transport and reads collection changes over GET /api/events/stream'
    ],
    [
      'Polling allowed',
      data.polling_allowed === false ? 'No' : 'Yes',
      'SOCKET_POLLING=off refuses polling where the balancer is not sticky; blocked clients then use the SSE stream'
    ],
    [
      'Compression',
      data.compression === false ? 'Off' : 'On',
      'Per-message deflate for frames over 1 KB (SOCKET_COMPRESSION=off disables it)'
    ],
    [
      'Shared workers',
      String(data.shared_worker_count ?? 0),
      "Connections that are a browser's shared worker — one carrying every tab of that app (REALTIME_SHARED_WORKER=off turns the worker off)"
    ],
    [
      'Per person',
      data.people_count ? (data.socket_count / data.people_count).toFixed(1) : '–',
      `Sockets per signed-in person on this node (${data.people_count ?? 0} people): tabs or browsers each person holds open`
    ]
  ]
  return (
    <div className='grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 sm:grid-cols-7 dark:border-border dark:bg-border'>
      {cells.map(([label, value, tip]) => (
        <div key={label} data-tip={tip} className='bg-white px-3 py-2 dark:bg-card'>
          <div className='text-[10.5px] uppercase tracking-wide text-slate-400'>{label}</div>
          <div className='text-[15px] font-semibold tabular-nums'>{value}</div>
        </div>
      ))}
    </div>
  )
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

// ─── Payload size (#1730, #1681) ─────────────────────────────────────────────

function PayloadTab() {
  const { data, isLoading, refetch } = useQuery<RealtimeStats>({
    queryKey: ['realtime-stats'],
    queryFn: () => api.get('/realtime/stats').then((r) => r.data.data),
    refetchInterval: 10_000
  })
  const [resetting, setResetting] = useState(false)
  if (isLoading) return <p className='text-[13px] text-slate-400'>Loading…</p>
  const traffic = data?.traffic
  if (!traffic) return null
  const reset = async () => {
    setResetting(true)
    try {
      await api.post('/realtime/traffic/reset')
      await refetch()
      toast.success('Counters reset')
    } catch {
      toast.error('Could not reset the counters')
    } finally {
      setResetting(false)
    }
  }
  return (
    <div className='space-y-4'>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
          {traffic.events.toLocaleString()} messages · {formatBytes(traffic.bytes)} written to
          sockets on this node since {new Date(traffic.since).toLocaleString()} (before
          compression).{' '}
          {traffic.coalesced.bursts > 0 &&
            `Bursts merged: ${traffic.coalesced.bursts.toLocaleString()}, saving ${traffic.coalesced.messages_saved.toLocaleString()} messages.`}
        </p>
        <button
          type='button'
          disabled={resetting}
          onClick={() => void reset()}
          className='inline-flex items-center gap-1.5 rounded-md border border-slate-200 px-2.5 py-1 text-[12px] hover:bg-muted disabled:opacity-50 dark:border-border'
        >
          <RefreshCw className='h-3 w-3' />
          Reset counters
        </button>
      </div>
      <div className='grid gap-4 lg:grid-cols-2'>
        <ByteTable
          title='Heaviest event types'
          keyLabel='Event'
          rows={traffic.by_event.map((r) => ({ key: r.event, count: r.count, bytes: r.bytes }))}
          total={traffic.bytes}
        />
        <ByteTable
          title='Heaviest rooms'
          keyLabel='Room'
          rows={traffic.by_room.map((r) => ({ key: r.room, count: r.count, bytes: r.bytes }))}
          total={traffic.bytes}
        />
      </div>
      <p className='text-[11.5px] text-slate-400'>
        Rooms are grouped by kind (one row for every record room of a collection). A message sent to
        many sockets counts once per socket — the cost of a broadcast is its size times its
        audience.
      </p>
    </div>
  )
}

function ByteTable({
  title,
  keyLabel,
  rows,
  total
}: {
  title: string
  keyLabel: string
  rows: Array<{ key: string; count: number; bytes: number }>
  total: number
}) {
  return (
    <div>
      <h2 className='mb-2 text-[13px] font-medium'>{title}</h2>
      <div className='overflow-x-auto rounded-lg border border-slate-200 dark:border-border'>
        <table className='w-full text-[12px] tabular-nums'>
          <thead>
            <tr className='border-b border-slate-200 bg-slate-50 text-left text-[10.5px] uppercase tracking-wide text-slate-400 dark:border-border dark:bg-muted/40'>
              <th className='px-3 py-2'>{keyLabel}</th>
              <th className='px-3 py-2 text-right'>Messages</th>
              <th className='px-3 py-2 text-right'>Bytes</th>
              <th className='px-3 py-2 text-right'>Avg</th>
              <th className='px-3 py-2 text-right'>Share</th>
            </tr>
          </thead>
          <tbody className='divide-y divide-slate-100 dark:divide-border/60'>
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className='px-3 py-3 text-slate-400'>
                  Nothing sent yet.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.key}>
                <td className='max-w-[280px] truncate px-3 py-1.5 font-mono text-[11px]'>
                  {r.key}
                </td>
                <td className='px-3 py-1.5 text-right'>{r.count.toLocaleString()}</td>
                <td className='px-3 py-1.5 text-right'>{formatBytes(r.bytes)}</td>
                <td className='px-3 py-1.5 text-right'>
                  {formatBytes(Math.round(r.bytes / Math.max(1, r.count)))}
                </td>
                <td className='px-3 py-1.5 text-right'>
                  {total > 0 ? `${Math.round((r.bytes / total) * 100)}%` : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Live traffic (#276) ─────────────────────────────────────────────────────

interface TrafficRow {
  method: string
  path: string
  status: number
  latency_ms: number
  user: string | null
  at: string
}

function TrafficTab() {
  const [rows, setRows] = useState<TrafficRow[]>([])
  const [paused, setPaused] = useState(false)
  const pausedRef = useRef(false)
  pausedRef.current = paused
  useEffect(() => {
    const leave = joinWatchRoom('traffic')
    const off = adminRealtime.on('traffic:request', (p: TrafficRow) => {
      if (pausedRef.current) return
      setRows((prev) => [p, ...prev].slice(0, 200))
    })
    return () => {
      off()
      leave()
    }
  }, [])
  return (
    <div className='space-y-3'>
      <div className='flex items-center justify-between'>
        <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
          API requests as they happen (only streamed while someone watches — zero cost otherwise).
        </p>
        <button
          type='button'
          onClick={() => setPaused((p) => !p)}
          className='rounded-md border border-slate-200 px-2.5 py-1 text-[12px] hover:bg-muted dark:border-border'
        >
          {paused ? 'Resume' : 'Pause'}
        </button>
      </div>
      {rows.length === 0 ? (
        <p className='text-[13px] text-slate-400'>Waiting for requests…</p>
      ) : (
        <div className='overflow-x-auto rounded-lg border border-slate-200 dark:border-border'>
          <table className='w-full text-[12px] tabular-nums'>
            <tbody className='divide-y divide-slate-100 dark:divide-border/60'>
              {rows.map((r, i) => (
                <tr key={`${r.at}-${i}`}>
                  <td className='px-3 py-1 font-mono text-[11px] text-slate-400'>
                    {new Date(r.at).toLocaleTimeString()}
                  </td>
                  <td className='px-3 py-1 font-mono text-[11px] font-semibold'>{r.method}</td>
                  <td className='max-w-[440px] truncate px-3 py-1 font-mono text-[11px]'>
                    {r.path}
                  </td>
                  <td
                    className={cn(
                      'px-3 py-1 text-right font-semibold',
                      r.status >= 500
                        ? 'text-red-600 dark:text-red-400'
                        : r.status >= 400
                          ? 'text-amber-600 dark:text-amber-400'
                          : 'text-emerald-600 dark:text-emerald-400'
                    )}
                  >
                    {r.status}
                  </td>
                  <td className='px-3 py-1 text-right text-slate-500'>{r.latency_ms}ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ─── Now editing (#273) ──────────────────────────────────────────────────────

function EditingTab() {
  const { data, isLoading } = useQuery<{
    editing: Array<{ collection: string; item: string; editor: string; since: string }>
    viewing: Array<{ collection: string; item: string; viewers: string[] }>
  }>({
    queryKey: ['realtime-editing'],
    queryFn: () => api.get('/realtime/now-editing').then((r) => r.data.data),
    refetchInterval: 15_000
  })
  if (isLoading) return <p className='text-[13px] text-slate-400'>Loading…</p>
  const editing = data?.editing ?? []
  const viewing = data?.viewing ?? []
  return (
    <div className='space-y-6'>
      <section>
        <h2 className='mb-2 flex items-center gap-1.5 text-[13px] font-medium'>
          <Pencil className='h-3.5 w-3.5 text-slate-400' /> Holding edit locks
        </h2>
        {editing.length === 0 ? (
          <p className='text-[13px] text-slate-400'>Nobody holds an edit lock right now.</p>
        ) : (
          <ul className='space-y-1'>
            {editing.map((e) => (
              <li key={`${e.collection}:${e.item}`} className='text-[13px]'>
                <span className='font-medium'>{e.editor}</span>{' '}
                <span className='text-slate-500 dark:text-muted-foreground'>is editing</span>{' '}
                <a
                  href={`/collections/${e.collection}/${e.item}`}
                  className='font-mono text-[12px] text-nvr-navy underline decoration-dotted dark:text-[#67e8f9]'
                >
                  {e.collection}/{e.item}
                </a>{' '}
                <span className='text-[11px] text-slate-400'>
                  since {new Date(e.since).toLocaleTimeString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <h2 className='mb-2 text-[13px] font-medium'>Viewing records (this node)</h2>
        {viewing.length === 0 ? (
          <p className='text-[13px] text-slate-400'>No record pages open right now.</p>
        ) : (
          <ul className='space-y-1'>
            {viewing.map((v) => (
              <li key={`${v.collection}:${v.item}`} className='text-[13px]'>
                <span className='font-mono text-[12px]'>
                  {v.collection}/{v.item}
                </span>{' '}
                <span className='text-slate-500 dark:text-muted-foreground'>
                  — {v.viewers.join(', ')}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

// ─── Concurrency history (#275) ──────────────────────────────────────────────

function ConcurrencyTab() {
  const [days, setDays] = useState(14)
  const { data = [] } = useQuery<
    Array<{ sampled_at: string; instance: string | null; sockets: number; users: number }>
  >({
    queryKey: ['realtime-concurrency', days],
    queryFn: () => api.get('/realtime/concurrency', { params: { days } }).then((r) => r.data.data),
    refetchInterval: 60_000
  })
  const series = useMemo(() => {
    // Sum instances per 5-min bucket so multi-replica deployments chart truth.
    const byTs = new Map<string, { sockets: number; users: number }>()
    for (const row of data) {
      const key = row.sampled_at
      const cur = byTs.get(key) ?? { sockets: 0, users: 0 }
      cur.sockets += row.sockets
      cur.users += row.users
      byTs.set(key, cur)
    }
    return [...byTs.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([ts, v]) => ({ ts, ...v }))
  }, [data])
  const max = Math.max(1, ...series.map((s) => s.sockets))
  const W = 800
  const H = 160
  const pts = (key: 'sockets' | 'users') =>
    series
      .map(
        (s, i) =>
          `${((i / Math.max(1, series.length - 1)) * W).toFixed(1)},${(
            H - (s[key] / max) * (H - 10)
          ).toFixed(1)}`
      )
      .join(' ')
  return (
    <div className='space-y-3'>
      <div className='flex items-center gap-2'>
        {[7, 14, 30, 90].map((d) => (
          <button
            key={d}
            type='button'
            onClick={() => setDays(d)}
            className={cn(
              'rounded-md px-2.5 py-1 text-[12px]',
              days === d
                ? 'bg-[#00ceff]/10 font-medium text-[#0e7490] dark:text-[#67e8f9]'
                : 'text-slate-500 hover:bg-muted'
            )}
          >
            {d}d
          </button>
        ))}
        <span className='ml-2 text-[11px] text-slate-400'>
          Sampled every 5 minutes · sockets (cyan) and distinct users (navy)
        </span>
      </div>
      {series.length < 2 ? (
        <p className='text-[13px] text-slate-400'>
          Not enough samples yet — the collector runs every 5 minutes.
        </p>
      ) : (
        <div className='overflow-x-auto rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
          <svg
            viewBox={`0 0 ${W} ${H}`}
            className='h-[180px] w-full min-w-[600px]'
            role='img'
            aria-label='Concurrent sockets and users over time'
          >
            <title>Concurrent sockets and users over time</title>
            <polyline points={pts('sockets')} fill='none' stroke='#00ceff' strokeWidth='1.5' />
            <polyline
              points={pts('users')}
              fill='none'
              stroke='#172940'
              strokeWidth='1.5'
              className='dark:[stroke:#94a3b8]'
            />
          </svg>
          <p className='mt-1 text-[11px] text-slate-400'>
            Peak {max} socket(s) in this window · {series.length} samples
          </p>
        </div>
      )}
    </div>
  )
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  return `${(seconds / 3600).toFixed(1)}h`
}

// ─── Hook firehose (#283): hooks/flows/transition actions as they fire ───────
function FirehoseTab() {
  const [rows, setRows] = useState<Array<Record<string, unknown>>>([])
  const [paused, setPaused] = useState(false)
  const pausedRef = useRef(false)
  pausedRef.current = paused
  useEffect(() => {
    const leave = joinWatchRoom('firehose')
    const off = adminRealtime.on('firehose:event', (p: Record<string, unknown>) => {
      if (pausedRef.current) return
      setRows((prev) => [p, ...prev].slice(0, 300))
    })
    return () => {
      off()
      leave()
    }
  }, [])
  return (
    <div className='space-y-3'>
      <div className='flex items-center justify-between'>
        <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
          Hooks, flow operations and transition actions as they fire — payload KEY names only, never
          values. Streamed only while this tab is open.
        </p>
        <button
          type='button'
          onClick={() => setPaused((p) => !p)}
          className='rounded-md border border-slate-200 px-2.5 py-1 text-[12px] hover:bg-muted dark:border-border'
        >
          {paused ? 'Resume' : 'Pause'}
        </button>
      </div>
      {rows.length === 0 ? (
        <p className='text-[13px] text-slate-400'>
          Waiting for activity — save a record or run a flow to see events.
        </p>
      ) : (
        <div className='space-y-0.5 font-mono text-[11px]'>
          {rows.map((r, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: streaming log
            <p key={i} className='break-words'>
              <span className='text-slate-400'>{String(r.at ?? '').slice(11, 19)}</span>{' '}
              <span
                className={
                  r.kind === 'hook'
                    ? 'text-nvr-cyan'
                    : r.kind === 'flow-op'
                      ? 'text-violet-500'
                      : 'text-amber-500'
                }
              >
                {String(r.kind)}
              </span>{' '}
              <span className='text-slate-700 dark:text-slate-200'>
                {r.kind === 'hook'
                  ? `${r.timing}:${r.action} ${r.collection} [${(r.payload_keys as string[])?.join(', ') ?? ''}]`
                  : r.kind === 'flow-op'
                    ? `${r.flow} → ${r.op} (${r.type})`
                    : `${r.collection}/${r.item} "${r.transition}" ${r.action_type}${r.endpoint ? ` → ${r.endpoint}` : ''}`}
              </span>
            </p>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Event pipeline (#1673 journal, #1737 stream, #1875 raw writes, #1682 probe) ─

interface ProbeResult {
  at: string
  ok: boolean
  arrived: boolean
  delivery_ms: number | null
  threshold_ms: number
  path: 'stream' | 'adapter' | 'none'
  journaled: boolean
  durable: boolean | null
  node: string | null
  detail: string
  skipped?: boolean
}

interface PipelineData {
  journal_seq: number | null
  stream: {
    enabled: boolean
    active: boolean
    published: number
    publishFailed: number
    delivered: number
    readErrors: number
    resumes: number
    lastResumeBacklog: number
    lastDeliveryLagMs: number | null
    lastError: string | null
    lastErrorAt: string | null
  }
  durable: {
    written: number
    buffered: number
    failed: number
    dropped: number
    lastError: string | null
  }
  raw_writes: {
    announced: number
    broadcasts: number
    drained: number
    persisted: number
    queued: number
    lastDrainAt: string | null
  }
  probes: ProbeResult[]
}

function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: string }) {
  return (
    <div className='bg-white px-3 py-2 dark:bg-card'>
      <div className='text-[10.5px] uppercase tracking-wide text-slate-400'>{label}</div>
      <div className={cn('mt-0.5 text-[13px] font-medium tabular-nums', tone)}>{value}</div>
    </div>
  )
}

function StatGrid({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className='mb-2 text-[13px] font-medium'>{title}</h2>
      <div className='grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 sm:grid-cols-4 dark:border-border dark:bg-border'>
        {children}
      </div>
    </section>
  )
}

const BAD = 'text-red-600 dark:text-red-400'

function PipelineTab() {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery<PipelineData>({
    queryKey: ['realtime-pipeline'],
    queryFn: () => api.get('/realtime/pipeline').then((r) => r.data.data),
    refetchInterval: 10_000
  })
  const probe = useMutation({
    mutationFn: () => api.post('/realtime/probe', {}).then((r) => r.data.data as ProbeResult),
    onSuccess: (r) => {
      if (r.ok) toast.success(r.detail)
      else toast.error(r.detail)
      void qc.invalidateQueries({ queryKey: ['realtime-pipeline'] })
    },
    onError: () => toast.error('The probe could not run')
  })
  if (isLoading) return <p className='text-[13px] text-slate-400'>Loading…</p>
  if (!data) return null
  const { stream, durable, raw_writes: raw } = data
  return (
    <div className='space-y-6'>
      <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
        Record-change events: journal sequence {data.journal_seq ?? '—'}. Counters are this API
        process since it started; probe results come from every server.
      </p>
      <StatGrid title='Cross-server stream'>
        <Stat
          label='State'
          value={!stream.enabled ? 'Off (pub/sub)' : stream.active ? 'Active' : 'Not connected'}
          tone={stream.enabled && !stream.active ? BAD : undefined}
        />
        <Stat label='Published' value={stream.published} />
        <Stat label='Delivered from others' value={stream.delivered} />
        <Stat
          label='Last delivery lag'
          value={stream.lastDeliveryLagMs != null ? `${stream.lastDeliveryLagMs}ms` : '—'}
        />
        <Stat
          label='Publish failures'
          value={stream.publishFailed}
          tone={stream.publishFailed ? BAD : undefined}
        />
        <Stat
          label='Read errors'
          value={stream.readErrors}
          tone={stream.readErrors ? BAD : undefined}
        />
        <Stat label='Resumes' value={stream.resumes} />
        <Stat label='Caught up after last resume' value={stream.lastResumeBacklog} />
      </StatGrid>
      <StatGrid title='Durable journal (24 hours)'>
        <Stat label='Written' value={durable.written} />
        <Stat label='Waiting to write' value={durable.buffered} />
        <Stat label='Failed' value={durable.failed} tone={durable.failed ? BAD : undefined} />
        <Stat label='Dropped' value={durable.dropped} tone={durable.dropped ? BAD : undefined} />
      </StatGrid>
      <StatGrid title='Changes from procedures, imports and scripts'>
        <Stat label='Announced' value={raw.announced} />
        <Stat label='Broadcasts' value={raw.broadcasts} />
        <Stat label='Read from the inbox' value={raw.drained} />
        <Stat
          label='Last inbox read'
          value={raw.lastDrainAt ? new Date(raw.lastDrainAt).toLocaleTimeString() : '—'}
        />
      </StatGrid>
      {(stream.lastError || durable.lastError) && (
        <p className='text-[12px] text-red-600 dark:text-red-400'>
          Last error: {stream.lastError ?? durable.lastError}
        </p>
      )}
      <section>
        <div className='mb-2 flex items-center justify-between'>
          <h2 className='text-[13px] font-medium'>Delivery probe</h2>
          <button
            type='button'
            disabled={probe.isPending}
            onClick={() => probe.mutate()}
            className='inline-flex items-center gap-1.5 rounded-md border border-slate-200 px-2.5 py-1 text-[12px] hover:bg-muted disabled:opacity-50 dark:border-border'
          >
            <RefreshCw className={cn('h-3.5 w-3.5', probe.isPending && 'animate-spin')} />
            Run probe now
          </button>
        </div>
        <p className='mb-2 text-[12px] text-slate-500 dark:text-muted-foreground'>
          A test connection inside the server receives a probe event sent through the normal path.
          Add a Realtime delivery monitor (Monitors) to run it every 5 minutes and raise an issue
          when delivery is slow or missing.
        </p>
        {data.probes.length === 0 ? (
          <p className='text-[13px] text-slate-400'>No probe has run yet.</p>
        ) : (
          <div className='overflow-x-auto rounded-lg border border-slate-200 dark:border-border'>
            <table className='w-full text-[12px] tabular-nums'>
              <thead>
                <tr className='border-b border-slate-200 bg-slate-50 text-left text-[10.5px] uppercase tracking-wide text-slate-400 dark:border-border dark:bg-muted/40'>
                  <th className='px-3 py-2'>When</th>
                  <th className='px-3 py-2'>Result</th>
                  <th className='px-3 py-2 text-right'>Delivery</th>
                  <th className='px-3 py-2'>Path</th>
                  <th className='px-3 py-2'>Journal</th>
                  <th className='px-3 py-2'>Server</th>
                  <th className='px-3 py-2'>Detail</th>
                </tr>
              </thead>
              <tbody className='divide-y divide-slate-100 dark:divide-border/60'>
                {data.probes.map((p) => (
                  <tr key={`${p.at}-${p.node}`}>
                    <td className='px-3 py-1.5 font-mono text-[11px] text-slate-400'>
                      {new Date(p.at).toLocaleString()}
                    </td>
                    <td
                      className={cn(
                        'px-3 py-1.5 font-semibold',
                        p.ok
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : p.skipped
                            ? 'text-slate-400'
                            : BAD
                      )}
                    >
                      {p.ok ? 'Delivered' : p.skipped ? 'Skipped' : p.arrived ? 'Slow' : 'Missed'}
                    </td>
                    <td className='px-3 py-1.5 text-right'>
                      {p.delivery_ms != null ? `${p.delivery_ms}ms` : '—'}
                    </td>
                    <td className='px-3 py-1.5'>
                      {p.path === 'stream' ? 'Stream' : p.path === 'adapter' ? 'Pub/sub' : '—'}
                    </td>
                    <td className='px-3 py-1.5'>
                      {p.journaled ? 'Yes' : 'No'}
                      {p.durable === false ? ' · no table row' : ''}
                    </td>
                    <td className='px-3 py-1.5 font-mono text-[11px]'>{p.node ?? '—'}</td>
                    <td className='max-w-[360px] truncate px-3 py-1.5 text-slate-500'>
                      {p.detail}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
