import { UserAvatar } from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Clapperboard, Code2, Play, Trash2, Users } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { ReplayPlayer } from '@/components/replay-player'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { SimpleSelect } from '@/components/ui/simple-select'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'
import { cn, formatFileSize, formatRelative } from '@/lib/utils'

/**
 * Session replays — list recorded admin sessions (rrweb), watch them in the
 * embedded player, toggle recording on/off. Admin-only; recordings purge
 * after 7 days.
 */

interface Recording {
  id: string
  user: string
  app: string | null
  origin: string | null
  meta?: string | null
  user_name: string | null
  scopes?: string[]
  masquerade_admin?: string | null
  masquerade_admin_name?: string | null
  started_at: string
  ended_at: string | null
  last_event_at: string | null
  event_count: number
  byte_size: number
  truncated: boolean
}

function duration(rec: Recording): string {
  const end = rec.ended_at ?? rec.last_event_at
  if (!end) return '—'
  const s = Math.max(
    0,
    Math.round((new Date(end).getTime() - new Date(rec.started_at).getTime()) / 1000)
  )
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

/**
 * Hands back a Playwright script that re-drives this session in a real browser
 * — the point being to WATCH a reported problem happen rather than read a
 * description of it. Downloaded rather than run here: the replay belongs on the
 * operator's machine, pointed at whichever environment they choose.
 */
async function downloadReplayScript(recordingId: string) {
  try {
    const res = await api.get(`/session-recordings/${recordingId}/playwright`, {
      responseType: 'text'
    })
    const blob = new Blob([res.data as string], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `replay-${recordingId.slice(0, 8)}.spec.ts`
    a.click()
    URL.revokeObjectURL(url)
    toast.success('Replay script downloaded — run it with: npx playwright test --headed')
  } catch {
    toast.error('Could not build a replay script for this recording')
  }
}

/**
 * Which environment a session happened on. The list is otherwise a wall of
 * near-identical rows, and this is the fact that decides whether a recording
 * explains a production report or someone poking about locally — it also picks
 * the target for the replay script.
 *
 * The host is shown on hover: "production" is an inference from the name, and
 * the reader should be able to check it.
 */
interface RecMeta {
  user_agent?: string
  platform?: string
  screen?: string
  viewport?: string
  dpr?: string | number
  language?: string
  timezone?: string
}

function parseRecMeta(raw: string | null | undefined): RecMeta | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? (v as RecMeta) : null
  } catch {
    return null
  }
}

/** Human OS + browser from a user agent — display only, so a rough match is fine. */
function uaSummary(meta: RecMeta | null): { os: string | null; browser: string | null } {
  const ua = meta?.user_agent ?? ''
  const platform = (meta?.platform ?? '').toLowerCase()
  let os: string | null = null
  if (/windows/i.test(ua) || platform.includes('win')) os = 'Windows'
  else if (/iphone|ipad|ios/i.test(ua)) os = 'iOS'
  else if (/android/i.test(ua)) os = 'Android'
  else if (/mac os x|macintosh/i.test(ua) || platform.includes('mac')) os = 'macOS'
  else if (/cros/i.test(ua)) os = 'ChromeOS'
  else if (/linux/i.test(ua) || platform.includes('linux')) os = 'Linux'
  let browser: string | null = null
  const pick = (re: RegExp, name: string) => {
    const m = ua.match(re)
    if (m) browser = m[1] ? `${name} ${m[1].split('.')[0]}` : name
  }
  if (/edg\//i.test(ua)) pick(/Edg\/([\d.]+)/i, 'Edge')
  else if (/firefox\//i.test(ua)) pick(/Firefox\/([\d.]+)/i, 'Firefox')
  else if (/chrome\//i.test(ua)) pick(/Chrome\/([\d.]+)/i, 'Chrome')
  else if (/safari\//i.test(ua) && /version\//i.test(ua)) pick(/Version\/([\d.]+)/i, 'Safari')
  return { os, browser }
}

/** OS · browser · screen chips for a recording row / the player header. */
function ClientMetaChips({ meta: raw, compact }: { meta?: string | null; compact?: boolean }) {
  const meta = parseRecMeta(raw)
  if (!meta) return null
  const { os, browser } = uaSummary(meta)
  const bits: string[] = []
  if (os) bits.push(os)
  if (browser) bits.push(browser)
  if (meta.screen && meta.screen !== '0x0') {
    const dpr = Number(meta.dpr ?? 1)
    bits.push(`${meta.screen}${dpr > 1 ? ` @${dpr}x` : ''}`)
  }
  if (bits.length === 0) return null
  const tip = [
    meta.viewport ? `Viewport ${meta.viewport}` : null,
    meta.language || null,
    meta.timezone || null,
    meta.user_agent ? meta.user_agent.slice(0, 160) : null
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <span
      className={`shrink-0 rounded border border-slate-200 px-1.5 py-px text-[10.5px] text-slate-500 dark:border-border ${compact ? '' : 'font-normal'}`}
      data-tip={tip || undefined}
    >
      {bits.join(' · ')}
    </span>
  )
}

function EnvironmentBadge({ origin }: { origin: string | null }) {
  if (!origin) {
    return (
      <span
        title='Recorded before the environment was captured'
        className='shrink-0 rounded border border-dashed border-slate-200 px-1.5 py-px text-[10.5px] text-slate-400 dark:border-border'
      >
        unknown
      </span>
    )
  }
  let host = origin
  try {
    host = new URL(origin).host
  } catch {
    /* keep the raw value — it is still more use than nothing */
  }
  const lower = host.toLowerCase()
  const env = /localhost|127\.0\.0\.1|\[::1\]/.test(lower)
    ? 'local'
    : /(^|[.-])(staging|stage|uat|test|dev)([.-]|$)/.test(lower)
      ? 'staging'
      : 'production'
  const tone =
    env === 'production'
      ? 'border-red-200 text-red-600 dark:border-red-900/40 dark:text-red-400'
      : env === 'staging'
        ? 'border-amber-200 text-amber-700 dark:border-amber-900/40 dark:text-amber-400'
        : 'border-slate-200 text-slate-500 dark:border-border'
  return (
    <span title={host} className={`shrink-0 rounded border px-1.5 py-px text-[10.5px] ${tone}`}>
      {env}
    </span>
  )
}

// A recording is genuinely live only if events arrived in the last 2 minutes —
// ended_at is best-effort (tab closes rarely deliver a clean end).
function isLive(rec: Recording): boolean {
  return (
    !rec.ended_at &&
    !!rec.last_event_at &&
    Date.now() - new Date(rec.last_event_at).getTime() < 2 * 60_000
  )
}

function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .map((w) => w[0])
      .join('')
      .slice(0, 2)
      .toUpperCase() || '?'
  )
}

function dayLabel(iso: string): string {
  const d = new Date(iso)
  const today = new Date()
  const yesterday = new Date(Date.now() - 86_400_000)
  const same = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  if (same(d, today)) return 'Today'
  if (same(d, yesterday)) return 'Yesterday'
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })
}

function startClock(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

interface PersonGroup {
  user: string
  name: string
  recordings: Recording[]
  totalBytes: number
  count: number
  lastActive: string
  live: boolean
}

export function SessionReplaysPage() {
  const queryClient = useQueryClient()
  const [playing, setPlaying] = useState<Recording | null>(null)
  const [startAt, setStartAt] = useState<number | null>(null)
  const [selectedUser, setSelectedUser] = useState<string | null>(null)
  // ?recording=<id> deep link — the chat online list links straight to
  // someone's live session, which is worthless if it only opens the list.
  const [searchParams] = useSearchParams()
  const deepLinkId = searchParams.get('recording')
  const deepLinkT = searchParams.get('t')
  const deepLinkApplied = useRef(false)
  const [appFilter, setAppFilter] = useState<string | null>(null)
  // Environment filter — buckets by recording origin host, defaulting to the
  // environment this admin is running in. null = all environments.
  const [envFilter, setEnvFilter] = useState<string | null | undefined>(undefined)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const { data: modes } = useQuery({
    queryKey: ['session-recording-enabled'],
    queryFn: () =>
      api
        .get<{ data: { enabled: boolean; error_replay?: boolean } }>('/session-recordings/enabled')
        .then((r) => r.data.data)
  })
  const enabled = modes?.enabled
  const errorReplay = modes?.error_replay

  const { data: originRows = [] } = useQuery<Array<{ origin: string | null; c: number }>>({
    queryKey: ['session-recording-origins'],
    queryFn: () =>
      api
        .get<{ data: Array<{ origin: string | null; c: number }> }>('/session-recordings/origins')
        .then((r) => r.data.data),
    staleTime: 5 * 60_000
  })

  // Origin hosts → environment buckets: any localhost variant is 'Local',
  // everything else groups by host with '-api' folded into its base host
  // (app-staging and app-staging-api are one environment).
  const envBuckets = useMemo(() => {
    const buckets = new Map<string, string[]>()
    for (const row of originRows) {
      let label = 'Unknown'
      if (row.origin) {
        try {
          const host = new URL(row.origin).hostname
          label = /^(localhost|127\.)/.test(host)
            ? 'Local'
            : host.replace(/^([^.]+?)-api(\.|$)/, '$1$2')
        } catch {
          label = row.origin
        }
      }
      const list = buckets.get(label) ?? []
      list.push(row.origin ?? '__none__')
      buckets.set(label, list)
    }
    return buckets
  }, [originRows])

  // Default to the environment we're on, once buckets exist.
  useEffect(() => {
    if (envFilter !== undefined || envBuckets.size === 0) return
    const here = /^(localhost|127\.)/.test(window.location.hostname)
      ? 'Local'
      : window.location.hostname.replace(/^([^.]+?)-api(\.|$)/, '$1$2')
    setEnvFilter(envBuckets.has(here) ? here : null)
  }, [envBuckets, envFilter])

  const originsParam = useMemo(() => {
    if (!envFilter) return ''
    const list = envBuckets.get(envFilter) ?? []
    return list.length > 0 ? `origins=${encodeURIComponent(list.join(','))}` : ''
  }, [envFilter, envBuckets])

  // The rail comes from a server-side aggregate over EVERY recording — one
  // heavy recorder used to own the newest page and everyone else vanished.
  const { data: peopleAgg = [], isLoading } = useQuery<
    Array<{
      user: string
      user_name: string | null
      recording_count: number
      total_bytes: number
      last_active: string
      live: number
    }>
  >({
    queryKey: ['session-recording-people', originsParam],
    queryFn: () =>
      api
        .get<{ data: never }>(`/session-recordings/people${originsParam ? `?${originsParam}` : ''}`)
        .then((r) => r.data.data),
    enabled: envFilter !== undefined,
    refetchInterval: 60_000
  })

  // Recent rows still load for app filters + deep links; the SELECTED
  // person's sessions come from their own filtered fetch below.
  const { data: recordings = [] } = useQuery({
    queryKey: ['session-recordings'],
    queryFn: () => api.get<{ data: Recording[] }>('/session-recordings/').then((r) => r.data.data),
    refetchInterval: 60_000
  })

  // One-shot: open the linked recording as soon as the list resolves. Guarded
  // so a later refetch can't yank someone out of what they switched to.
  useEffect(() => {
    if (deepLinkApplied.current || !deepLinkId) return
    deepLinkApplied.current = true
    const match = recordings.find((r) => String(r.id) === deepLinkId)
    const openIt = (rec: Recording) => {
      setPlaying(rec)
      if (deepLinkT && Number.isFinite(Number(deepLinkT))) setStartAt(Number(deepLinkT))
    }
    if (match) {
      openIt(match)
      return
    }
    // Not in the loaded page (older recording, error clip hidden by the list
    // filters) — fetch the header directly and play it anyway.
    void api
      .get<{ data: Recording }>(`/session-recordings/${deepLinkId}`)
      .then((r) => openIt(r.data.data))
      .catch(() =>
        toast.error('That recording no longer exists (recordings expire with retention)')
      )
  }, [deepLinkId, deepLinkT, recordings])

  const { data: settings } = useQuery({
    queryKey: ['session-recording-retention'],
    queryFn: () =>
      api
        .get<{ data: { session_recording_retention_days?: number | null } }>('/settings/')
        .then((r) => r.data.data)
  })
  const retention = settings?.session_recording_retention_days ?? 7
  const setRetention = useMutation({
    mutationFn: (days: number) =>
      api.patch('/settings/', { session_recording_retention_days: days }),
    onSuccess: (_d, days) => {
      toast.success(`Recordings kept for ${days} day${days === 1 ? '' : 's'}`)
      queryClient.invalidateQueries({ queryKey: ['session-recording-retention'] })
    },
    onError: () => toast.error('Failed to save retention')
  })

  const toggle = useMutation({
    mutationFn: (patch: Record<string, boolean>) => api.patch('/settings/', patch),
    onSuccess: () => {
      toast.success('Setting saved')
      queryClient.invalidateQueries({ queryKey: ['session-recording-enabled'] })
    },
    onError: () => toast.error('Could not update the setting')
  })

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/session-recordings/${id}`),
    onSuccess: () => {
      toast.success('Recording deleted')
      setConfirmDelete(null)
      queryClient.invalidateQueries({ queryKey: ['session-recordings'] })
    }
  })

  // Apps present in the data (admin recordings have no label)
  const apps = useMemo(
    () => [...new Set(recordings.map((r) => r.app ?? 'admin'))].sort(),
    [recordings]
  )

  const filtered = useMemo(
    () => (appFilter ? recordings.filter((r) => (r.app ?? 'admin') === appFilter) : recordings),
    [recordings, appFilter]
  )

  // People rail from the aggregate — complete, most recently active first.
  const people = useMemo((): PersonGroup[] => {
    return peopleAgg.map((p) => ({
      user: p.user,
      name: p.user_name || p.user.slice(0, 8),
      recordings: [],
      totalBytes: Number(p.total_bytes ?? 0),
      count: Number(p.recording_count ?? 0),
      lastActive: p.last_active,
      live: p.live === 1
    }))
  }, [peopleAgg])

  const selected = people.find((p) => p.user === selectedUser) ?? people[0] ?? null

  // The selected person's sessions come from THEIR filtered fetch — the
  // newest 50 of that user, not whatever survived the global page.
  const { data: selectedRecordings = [] } = useQuery({
    queryKey: ['session-recordings-user', selected?.user ?? null, originsParam],
    queryFn: () =>
      api
        .get<{ data: Recording[] }>(
          `/session-recordings/?user=${selected?.user}${originsParam ? `&${originsParam}` : ''}`
        )
        .then((r) => r.data.data),
    enabled: !!selected,
    refetchInterval: 60_000
  })
  const selectedFiltered = useMemo(
    () =>
      appFilter
        ? selectedRecordings.filter((r) => (r.app ?? 'admin') === appFilter)
        : selectedRecordings,
    [selectedRecordings, appFilter]
  )

  // Selected person's sessions grouped by day, newest first
  const days = useMemo(() => {
    const byDay = new Map<string, Recording[]>()
    for (const rec of selectedFiltered) {
      const label = dayLabel(rec.started_at)
      const list = byDay.get(label) ?? []
      list.push(rec)
      byDay.set(label, list)
    }
    return [...byDay.entries()]
  }, [selectedFiltered])

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='shrink-0 border-b border-slate-200 bg-white px-8 py-4 dark:border-border dark:bg-card'>
        <div className='flex items-center gap-3'>
          <Clapperboard className='h-4 w-4 text-nvr-cyan' />
          <div>
            <h1 className='text-[16px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-foreground'>
              Session Replays
            </h1>
            <p className='text-[12px] text-muted-foreground'>
              {/* Reads the setting rather than restating a number that is now
                  configurable — copy that contradicts the control beside it is
                  worse than no copy. */}
              Watch what people saw — inputs masked, kept {retention} day
              {retention === 1 ? '' : 's'}.
            </p>
          </div>
          {(apps.length > 1 || envBuckets.size > 1) && (
            <div className='ml-6 flex items-center gap-1.5'>
              <button
                type='button'
                onClick={() => setAppFilter(null)}
                className={cn(
                  'rounded-full border px-2.5 py-0.5 text-[11.5px]',
                  appFilter === null
                    ? 'border-nvr-cyan bg-accent text-nvr-navy dark:text-nvr-cyan'
                    : 'border-slate-200 text-slate-400 hover:text-slate-600 dark:border-border'
                )}
              >
                All apps
              </button>
              {apps.map((a) => (
                <button
                  key={a}
                  type='button'
                  onClick={() => setAppFilter(a)}
                  className={cn(
                    'rounded-full border px-2.5 py-0.5 text-[11.5px]',
                    appFilter === a
                      ? 'border-nvr-cyan bg-accent text-nvr-navy dark:text-nvr-cyan'
                      : 'border-slate-200 text-slate-400 hover:text-slate-600 dark:border-border'
                  )}
                >
                  {a}
                </button>
              ))}
              {envBuckets.size > 1 && (
                <>
                  <span className='mx-1 h-4 w-px bg-slate-200 dark:bg-border' />
                  <button
                    type='button'
                    onClick={() => setEnvFilter(null)}
                    className={cn(
                      'rounded-full border px-2.5 py-0.5 text-[11.5px]',
                      envFilter === null
                        ? 'border-nvr-cyan bg-accent text-nvr-navy dark:text-nvr-cyan'
                        : 'border-slate-200 text-slate-400 hover:text-slate-600 dark:border-border'
                    )}
                  >
                    All environments
                  </button>
                  {[...envBuckets.keys()].sort().map((env) => (
                    <button
                      key={env}
                      type='button'
                      onClick={() => setEnvFilter(env)}
                      className={cn(
                        'rounded-full border px-2.5 py-0.5 text-[11.5px]',
                        envFilter === env
                          ? 'border-nvr-cyan bg-accent text-nvr-navy dark:text-nvr-cyan'
                          : 'border-slate-200 text-slate-400 hover:text-slate-600 dark:border-border'
                      )}
                    >
                      {env}
                    </button>
                  ))}
                </>
              )}
            </div>
          )}
          {/* Beside the on/off switch: how long recordings live is the other
              half of the same decision, and it was previously a code constant. */}
          <label className='ml-auto flex items-center gap-1.5 text-[12.5px] text-slate-600 dark:text-slate-300'>
            Keep for
            <SimpleSelect
              value={String(retention)}
              onChange={(v) => setRetention.mutate(Number(v))}
              disabled={setRetention.isPending}
              className='h-7 w-auto rounded-md border-slate-200 bg-white px-1.5 text-[12px] dark:border-border dark:bg-card'
              options={[1, 3, 7, 14, 30, 60, 90, 180, 365].map((d) => ({
                value: String(d),
                label: `${d} day${d === 1 ? '' : 's'}`
              }))}
            />
          </label>
          <label className='flex items-center gap-2 text-[12.5px] text-slate-600 dark:text-slate-300'>
            Recording {enabled ? 'on' : 'off'}
            <Switch
              checked={!!enabled}
              onCheckedChange={(v) => toggle.mutate({ session_recording_enabled: v })}
              disabled={toggle.isPending}
            />
          </label>
          <label
            className='flex items-center gap-2 text-[12.5px] text-slate-600 dark:text-slate-300'
            title='Keeps a rolling in-memory buffer (last ~60s, inputs masked, nothing uploaded) and attaches it to the issue log when a client error is reported — support sees what happened without continuous recording.'
          >
            Error clips {errorReplay ? 'on' : 'off'}
            <Switch
              checked={!!errorReplay}
              onCheckedChange={(v) => toggle.mutate({ error_replay_enabled: v })}
              disabled={toggle.isPending}
            />
          </label>
        </div>
      </header>

      <div className='flex flex-1 min-h-0 overflow-hidden'>
        {/* People rail */}
        <aside className='w-[272px] shrink-0 overflow-y-auto border-r border-slate-200 bg-white dark:border-border dark:bg-card'>
          {isLoading ? (
            <p className='p-4 text-[12px] text-slate-400'>Loading…</p>
          ) : people.length === 0 ? (
            <div className='p-6 text-center text-slate-400'>
              <Users className='mx-auto h-6 w-6 opacity-40' />
              <p className='mt-2 text-[12px]'>No recordings yet.</p>
            </div>
          ) : (
            people.map((p) => (
              <button
                key={p.user}
                type='button'
                onClick={() => setSelectedUser(p.user)}
                className={cn(
                  'flex w-full items-center gap-2.5 border-b border-slate-100 px-4 py-2.5 text-left dark:border-border/50',
                  selected?.user === p.user
                    ? 'bg-accent'
                    : 'hover:bg-slate-50 dark:hover:bg-muted/40'
                )}
              >
                <span className='relative'>
                  <UserAvatar
                    userId={p.user}
                    alt={p.name}
                    className='h-7 w-7'
                    fallback={
                      <Avatar className='h-7 w-7'>
                        <AvatarFallback className='bg-nvr-navy text-[10px] text-white'>
                          {initials(p.name)}
                        </AvatarFallback>
                      </Avatar>
                    }
                  />
                  {p.live && (
                    <span className='absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-emerald-500 dark:border-card' />
                  )}
                </span>
                <span className='min-w-0 flex-1'>
                  <span
                    className={cn(
                      'block truncate text-[13px]',
                      selected?.user === p.user
                        ? 'font-semibold text-nvr-navy dark:text-nvr-cyan'
                        : 'font-medium text-slate-800 dark:text-foreground'
                    )}
                  >
                    {p.name}
                  </span>
                  <span className='block text-[11px] text-slate-400'>
                    {p.count} session{p.count === 1 ? '' : 's'} · {formatRelative(p.lastActive)}
                  </span>
                </span>
              </button>
            ))
          )}
        </aside>

        {/* Sessions for the selected person */}
        <div className='flex-1 overflow-y-auto bg-slate-50 dark:bg-background'>
          {!enabled && recordings.length === 0 ? (
            <div className='max-w-md px-6 py-10'>
              <Clapperboard className='h-8 w-8 text-slate-300' />
              <h2 className='mt-4 text-[15px] font-semibold text-slate-800 dark:text-foreground'>
                Recording is off
              </h2>
              <p className='mt-1.5 text-[12.5px] leading-relaxed text-slate-500'>
                Flip the switch above and every admin session — plus any frontend using the recorder
                hook — starts recording with all inputs masked. Consider telling your team first.
              </p>
            </div>
          ) : !selected ? (
            enabled && (
              <div className='px-6 py-10'>
                <Clapperboard className='h-8 w-8 text-slate-300' />
                <p className='mt-4 text-[13px] text-slate-400'>
                  Recording is on — sessions appear here as people work.
                </p>
              </div>
            )
          ) : (
            <div className='px-6 py-5'>
              <div className='mb-4 flex items-baseline gap-3'>
                <h2 className='text-[15px] font-semibold text-slate-900 dark:text-foreground'>
                  {selected.name}
                </h2>
                <span className='text-[12px] text-slate-400'>
                  {selected.count} session{selected.count === 1 ? '' : 's'} ·{' '}
                  {formatFileSize(selected.totalBytes)} recorded
                </span>
                {(selectedRecordings[0]?.scopes ?? []).map((sc) => (
                  <span
                    key={sc}
                    className='rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-medium text-slate-500 dark:border-border dark:bg-muted dark:text-slate-400'
                  >
                    {sc}
                  </span>
                ))}
              </div>

              {days.map(([label, recs]) => (
                <section key={label} className='mb-5'>
                  <h3 className='mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400'>
                    {label}
                  </h3>
                  <div className='overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
                    {recs.map((rec, i) => (
                      <div
                        key={rec.id}
                        className={cn(
                          'group flex items-center gap-3 px-4 py-2 hover:bg-slate-50 dark:hover:bg-muted/40',
                          i > 0 && 'border-t border-slate-100 dark:border-border/50'
                        )}
                      >
                        <span className='w-14 shrink-0 font-mono text-[11.5px] tabular-nums text-slate-500'>
                          {startClock(rec.started_at)}
                        </span>
                        {isLive(rec) ? (
                          <span className='flex shrink-0 items-center gap-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400'>
                            <span className='h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500' />
                            live
                          </span>
                        ) : (
                          <span className='shrink-0 text-[11.5px] tabular-nums text-slate-600 dark:text-slate-300'>
                            {duration(rec)}
                          </span>
                        )}
                        <span className='shrink-0 rounded border border-slate-200 px-1.5 py-px text-[10.5px] text-slate-500 dark:border-border'>
                          {rec.app ?? 'admin'}
                        </span>
                        <EnvironmentBadge origin={rec.origin} />
                        <ClientMetaChips meta={rec.meta} />
                        {rec.masquerade_admin && (
                          <span
                            className='shrink-0 rounded bg-amber-500/15 px-1.5 py-px text-[10.5px] font-medium text-amber-700 dark:text-amber-400'
                            title={`Recorded while ${rec.masquerade_admin_name || 'an admin'} was masquerading as this user — the admin was driving`}
                          >
                            Masquerade
                            {rec.masquerade_admin_name ? ` · ${rec.masquerade_admin_name}` : ''}
                          </span>
                        )}
                        {rec.truncated && (
                          <span className='shrink-0 text-[10.5px] text-amber-600'>truncated</span>
                        )}
                        <span className='min-w-0 flex-1 truncate text-right text-[11px] text-slate-400'>
                          {rec.event_count} events · {formatFileSize(rec.byte_size)}
                        </span>
                        <Button
                          size='sm'
                          variant='outline'
                          className='h-7 gap-1.5 text-[12px]'
                          onClick={() => setPlaying(rec)}
                        >
                          <Play className='h-3 w-3' /> Watch
                        </Button>
                        {confirmDelete === rec.id ? (
                          <Button
                            size='sm'
                            variant='outline'
                            className='h-7 text-[11.5px] text-red-500 hover:border-red-200 hover:bg-red-50'
                            disabled={remove.isPending}
                            onClick={() => remove.mutate(rec.id)}
                          >
                            Confirm
                          </Button>
                        ) : (
                          <button
                            type='button'
                            title='Delete recording'
                            className='p-1 text-slate-300 opacity-0 transition-opacity hover:text-red-500 group-hover:opacity-100'
                            onClick={() => setConfirmDelete(rec.id)}
                          >
                            <Trash2 className='h-3.5 w-3.5' />
                          </button>
                        )}
                        <button
                          type='button'
                          title='Download a Playwright script that replays this session'
                          className='p-1 text-slate-300 opacity-0 transition-opacity hover:text-nvr-cyan group-hover:opacity-100'
                          onClick={(e) => {
                            e.stopPropagation()
                            void downloadReplayScript(rec.id)
                          }}
                        >
                          <Code2 className='h-3.5 w-3.5' />
                        </button>
                      </div>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>
      </div>

      <Sheet open={!!playing} onOpenChange={(o) => !o && setPlaying(null)}>
        <SheetContent className='w-[85%] overflow-y-auto sm:max-w-[85%]'>
          <SheetHeader>
            <SheetTitle className='flex items-center gap-2 text-[15px]'>
              <Clapperboard className='h-4 w-4 text-nvr-cyan' />
              {playing?.user_name || 'Session'}
              {playing?.app && (
                <span className='rounded border border-slate-200 px-1.5 py-px text-[10.5px] font-normal text-slate-500 dark:border-border'>
                  {playing.app}
                </span>
              )}
              <ClientMetaChips meta={playing?.meta} compact />
              {playing?.masquerade_admin && (
                <span
                  className='rounded bg-amber-500/15 px-1.5 py-px text-[10.5px] font-medium text-amber-700 dark:text-amber-400'
                  title={`Recorded while ${playing.masquerade_admin_name || 'an admin'} was masquerading as this user`}
                >
                  Masquerade
                  {playing.masquerade_admin_name ? ` · ${playing.masquerade_admin_name}` : ''}
                </span>
              )}
              {(playing?.scopes ?? []).map((sc) => (
                <span
                  key={sc}
                  className='rounded bg-[#00ceff1a] px-1.5 py-px text-[10.5px] font-medium text-[#009abe]'
                >
                  {sc}
                </span>
              ))}
              <span className='text-[12px] font-normal text-slate-400'>
                {playing && formatRelative(playing.started_at)}
              </span>
            </SheetTitle>
          </SheetHeader>
          {playing && (
            <ReplayPlayer recordingId={playing.id} startAt={startAt} live={isLive(playing)} />
          )}
        </SheetContent>
      </Sheet>
    </div>
  )
}
