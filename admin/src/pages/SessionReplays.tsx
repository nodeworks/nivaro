import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Clapperboard, Play, Trash2, Users } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
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
  user_name: string | null
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

function fmtClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const SPEEDS = [1, 2, 4, 8]

/**
 * Minimal player on rrweb's own Replayer engine. (rrweb-player 2.x ships a
 * broken build — its bundle never constructs a Replayer — so the controls
 * live here: play/pause, scrubber, speed, auto-scaled viewport.)
 */
function ReplayPlayer({ recordingId }: { recordingId: string }) {
  const frameRef = useRef<HTMLDivElement>(null)
  const replayerRef = useRef<{
    play: (t?: number) => void
    pause: (t?: number) => void
    getCurrentTime: () => number
    getMetaData: () => { totalTime: number }
    setConfig: (c: { speed?: number }) => void
    on: (ev: string, cb: () => void) => void
    destroy?: () => void
    wrapper: HTMLElement
    iframe: HTMLIFrameElement
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [time, setTime] = useState(0)
  const [total, setTotal] = useState(0)
  const playingRef = useRef(false)
  playingRef.current = playing

  useEffect(() => {
    let cancelled = false
    let raf = 0

    function rescale() {
      const rep = replayerRef.current
      const host = frameRef.current
      if (!rep || !host) return
      const w = rep.iframe.offsetWidth || 1280
      const h = rep.iframe.offsetHeight || 720
      // Width budget from the sheet itself — the host div can be mid-animation
      // (or grown by the giant iframe), so never trust host.clientWidth alone.
      const sheetW = window.innerWidth * 0.85 - 56
      const budget = Math.min(host.parentElement?.clientWidth || sheetW, sheetW)
      // Fill the sheet: scale up as well as down, bounded by width and viewport height
      const scale = Math.min(budget / w, (window.innerHeight - 170) / h)
      rep.wrapper.style.transform = `scale(${scale})`
      rep.wrapper.style.transformOrigin = 'top left'
      host.style.width = `${Math.ceil(w * scale)}px`
      host.style.height = `${Math.ceil(h * scale)}px`
    }

    async function load() {
      try {
        const r = await api.get<{ data: { events: unknown[] } }>(
          `/session-recordings/${recordingId}/events`
        )
        if (cancelled || !frameRef.current) return
        const events = r.data.data.events
        if (events.length < 2) {
          setError('Not enough events to replay this session.')
          return
        }
        const rrweb = await import('rrweb')
        await import('rrweb/dist/style.css')
        if (cancelled || !frameRef.current) return
        frameRef.current.replaceChildren()
        const replayer = new rrweb.Replayer(events as never[], {
          root: frameRef.current,
          skipInactive: true,
          speed: 1,
          mouseTail: { strokeStyle: '#00ceff' }
        }) as unknown as NonNullable<typeof replayerRef.current>
        replayerRef.current = replayer
        setTotal(replayer.getMetaData().totalTime)
        replayer.on('fullsnapshot-rebuilded', rescale)
        replayer.on('resize', rescale)
        // Sheet slide-in animation settles ~300ms after mount — re-measure after
        for (const delay of [100, 400, 800]) setTimeout(rescale, delay)
        replayer.on('finish', () => {
          playingRef.current = false
          setPlaying(false)
        })
        setReady(true)
        replayer.play()
        setPlaying(true)
        const tick = () => {
          if (replayerRef.current && playingRef.current) {
            setTime(
              Math.min(replayerRef.current.getCurrentTime(), total || Number.MAX_SAFE_INTEGER)
            )
          }
          raf = requestAnimationFrame(tick)
        }
        raf = requestAnimationFrame(tick)
        window.addEventListener('resize', rescale)
      } catch (err) {
        console.warn('replay load failed', err)
        setError('Could not load this recording.')
      }
    }
    void load()
    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', rescale)
      replayerRef.current?.pause()
      replayerRef.current?.destroy?.()
      replayerRef.current = null
    }
  }, [recordingId])

  function togglePlay() {
    const rep = replayerRef.current
    if (!rep) return
    if (playing) {
      rep.pause()
      setPlaying(false)
    } else {
      rep.play(time >= total ? 0 : time)
      setPlaying(true)
    }
  }

  function seek(ms: number) {
    const rep = replayerRef.current
    if (!rep) return
    setTime(ms)
    if (playing) rep.play(ms)
    else rep.pause(ms)
  }

  function changeSpeed(v: number) {
    setSpeed(v)
    replayerRef.current?.setConfig({ speed: v })
  }

  if (error) return <p className='py-10 text-center text-[13px] text-slate-400'>{error}</p>

  return (
    <div className='nvr-no-record mt-3'>
      <div
        ref={frameRef}
        className='w-full overflow-hidden rounded-lg border border-slate-200 bg-slate-100 dark:border-border dark:bg-muted [&_iframe]:border-0 [&_iframe]:bg-white'
        style={{ minHeight: 400 }}
      />
      {ready && (
        <div className='mt-2 flex items-center gap-3'>
          <Button size='sm' variant='outline' className='h-7 w-16 text-[12px]' onClick={togglePlay}>
            {playing ? 'Pause' : time >= total && total > 0 ? 'Replay' : 'Play'}
          </Button>
          <span className='w-10 text-right font-mono text-[11px] tabular-nums text-slate-500'>
            {fmtClock(time)}
          </span>
          <input
            type='range'
            min={0}
            max={Math.max(1, total)}
            value={Math.min(time, total)}
            onChange={(e) => seek(Number(e.target.value))}
            className='flex-1 accent-[#00ceff]'
            aria-label='Replay position'
          />
          <span className='w-10 font-mono text-[11px] tabular-nums text-slate-500'>
            {fmtClock(total)}
          </span>
          <span className='flex rounded-md border border-slate-200 p-0.5 dark:border-border'>
            {SPEEDS.map((v) => (
              <button
                key={v}
                type='button'
                onClick={() => changeSpeed(v)}
                className={
                  speed === v
                    ? 'rounded bg-accent px-1.5 py-0.5 text-[10.5px] font-medium text-nvr-navy dark:text-nvr-cyan'
                    : 'rounded px-1.5 py-0.5 text-[10.5px] text-slate-400'
                }
              >
                {v}x
              </button>
            ))}
          </span>
        </div>
      )}
    </div>
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
  lastActive: string
  live: boolean
}

export function SessionReplaysPage() {
  const queryClient = useQueryClient()
  const [playing, setPlaying] = useState<Recording | null>(null)
  const [selectedUser, setSelectedUser] = useState<string | null>(null)
  // ?recording=<id> deep link — the chat online list links straight to
  // someone's live session, which is worthless if it only opens the list.
  const [searchParams] = useSearchParams()
  const deepLinkId = searchParams.get('recording')
  const deepLinkApplied = useRef(false)
  const [appFilter, setAppFilter] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const { data: enabled } = useQuery({
    queryKey: ['session-recording-enabled'],
    queryFn: () =>
      api
        .get<{ data: { enabled: boolean } }>('/session-recordings/enabled')
        .then((r) => r.data.data.enabled)
  })

  const { data: recordings = [], isLoading } = useQuery({
    queryKey: ['session-recordings'],
    queryFn: () => api.get<{ data: Recording[] }>('/session-recordings/').then((r) => r.data.data),
    refetchInterval: 60_000
  })

  // One-shot: open the linked recording as soon as the list resolves. Guarded
  // so a later refetch can't yank someone out of what they switched to.
  useEffect(() => {
    if (deepLinkApplied.current || !deepLinkId || recordings.length === 0) return
    const match = recordings.find((r) => String(r.id) === deepLinkId)
    if (!match) return
    deepLinkApplied.current = true
    setPlaying(match)
  }, [deepLinkId, recordings])

  const toggle = useMutation({
    mutationFn: (value: boolean) => api.patch('/settings/', { session_recording_enabled: value }),
    onSuccess: (_r, value) => {
      toast.success(value ? 'Session recording enabled' : 'Session recording disabled')
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

  // People rail — grouped, most recently active first
  const people = useMemo((): PersonGroup[] => {
    const byUser = new Map<string, PersonGroup>()
    for (const rec of filtered) {
      const key = rec.user
      const g = byUser.get(key) ?? {
        user: key,
        name: rec.user_name || rec.user.slice(0, 8),
        recordings: [],
        totalBytes: 0,
        lastActive: rec.last_event_at ?? rec.started_at,
        live: false
      }
      g.recordings.push(rec)
      g.totalBytes += rec.byte_size
      const activity = rec.last_event_at ?? rec.started_at
      if (new Date(activity) > new Date(g.lastActive)) g.lastActive = activity
      g.live = g.live || isLive(rec)
      byUser.set(key, g)
    }
    return [...byUser.values()].sort(
      (a, b) => new Date(b.lastActive).getTime() - new Date(a.lastActive).getTime()
    )
  }, [filtered])

  const selected = people.find((p) => p.user === selectedUser) ?? people[0] ?? null

  // Selected person's sessions grouped by day, newest first
  const days = useMemo(() => {
    if (!selected) return []
    const byDay = new Map<string, Recording[]>()
    for (const rec of selected.recordings) {
      const label = dayLabel(rec.started_at)
      const list = byDay.get(label) ?? []
      list.push(rec)
      byDay.set(label, list)
    }
    return [...byDay.entries()]
  }, [selected])

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
              Watch what people saw — inputs masked, kept 7 days.
            </p>
          </div>
          {apps.length > 1 && (
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
            </div>
          )}
          <label className='ml-auto flex items-center gap-2 text-[12.5px] text-slate-600 dark:text-slate-300'>
            Recording {enabled ? 'on' : 'off'}
            <Switch
              checked={!!enabled}
              onCheckedChange={(v) => toggle.mutate(v)}
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
                  <Avatar className='h-7 w-7'>
                    <AvatarFallback className='bg-nvr-navy text-[10px] text-white'>
                      {initials(p.name)}
                    </AvatarFallback>
                  </Avatar>
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
                    {p.recordings.length} session{p.recordings.length === 1 ? '' : 's'} ·{' '}
                    {formatRelative(p.lastActive)}
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
                  {selected.recordings.length} session
                  {selected.recordings.length === 1 ? '' : 's'} ·{' '}
                  {formatFileSize(selected.totalBytes)} recorded
                </span>
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
              <span className='text-[12px] font-normal text-slate-400'>
                {playing && formatRelative(playing.started_at)}
              </span>
            </SheetTitle>
          </SheetHeader>
          {playing && <ReplayPlayer recordingId={playing.id} />}
        </SheetContent>
      </Sheet>
    </div>
  )
}
