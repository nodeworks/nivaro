import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Clapperboard, Play, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'
import { formatFileSize, formatRelative } from '@/lib/utils'

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
      const scale = Math.min(host.clientWidth / w, 520 / h, 1)
      rep.wrapper.style.transform = `scale(${scale})`
      rep.wrapper.style.transformOrigin = 'top left'
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
        style={{ minHeight: 200 }}
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

export function SessionReplaysPage() {
  const queryClient = useQueryClient()
  const [playing, setPlaying] = useState<Recording | null>(null)

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
      queryClient.invalidateQueries({ queryKey: ['session-recordings'] })
    }
  })

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
              rrweb recordings of admin sessions — inputs masked, kept 7 days.
            </p>
          </div>
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

      <div className='flex-1 overflow-y-auto bg-slate-50 dark:bg-background'>
        <div className='mx-auto max-w-4xl p-6'>
          {!enabled && recordings.length === 0 && (
            <div className='rounded-lg border border-amber-200 bg-amber-50 p-4 text-[12.5px] text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200'>
              Recording is off. Flip the switch above and every admin session starts recording (all
              inputs masked). Consider whether your team should be informed first.
            </div>
          )}

          {isLoading ? (
            <p className='pt-16 text-center text-[13px] text-slate-400'>Loading…</p>
          ) : recordings.length === 0 ? (
            enabled && (
              <div className='pt-16 text-center text-slate-400'>
                <Clapperboard className='mx-auto h-8 w-8 opacity-40' />
                <p className='mt-3 text-[13px]'>
                  No recordings yet — they appear as people use the admin.
                </p>
              </div>
            )
          ) : (
            <div className='space-y-1'>
              {recordings.map((rec) => (
                <div
                  key={rec.id}
                  className='flex items-center gap-3 rounded-lg border border-slate-200 bg-white px-4 py-2.5 dark:border-border dark:bg-card'
                >
                  <div className='min-w-0 flex-1'>
                    <div className='text-[13px] font-medium text-slate-800 dark:text-foreground'>
                      {rec.user_name || rec.user.slice(0, 8)}
                      {rec.app && (
                        <Badge variant='outline' className='ml-2 h-4 px-1.5 text-[10px]'>
                          {rec.app}
                        </Badge>
                      )}
                      {rec.truncated && (
                        <Badge
                          variant='outline'
                          className='ml-2 h-4 px-1.5 text-[10px] text-amber-600'
                        >
                          truncated
                        </Badge>
                      )}
                      {!rec.ended_at && <Badge className='ml-2 h-4 px-1.5 text-[10px]'>live</Badge>}
                    </div>
                    <p className='text-[11px] text-slate-400'>
                      {formatRelative(rec.started_at)} · {duration(rec)} · {rec.event_count} events
                      · {formatFileSize(rec.byte_size)}
                    </p>
                  </div>
                  <Button
                    size='sm'
                    variant='outline'
                    className='gap-1.5 text-[12px]'
                    onClick={() => setPlaying(rec)}
                  >
                    <Play className='h-3.5 w-3.5' /> Watch
                  </Button>
                  <Button
                    size='sm'
                    variant='ghost'
                    className='text-slate-400 hover:text-red-500'
                    onClick={() => remove.mutate(rec.id)}
                  >
                    <Trash2 className='h-3.5 w-3.5' />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <Sheet open={!!playing} onOpenChange={(o) => !o && setPlaying(null)}>
        <SheetContent className='w-[1000px] overflow-y-auto sm:max-w-[1000px]'>
          <SheetHeader>
            <SheetTitle className='flex items-center gap-2 text-[15px]'>
              <Clapperboard className='h-4 w-4 text-nvr-cyan' />
              {playing?.user_name || 'Session'} · {playing && formatRelative(playing.started_at)}
            </SheetTitle>
          </SheetHeader>
          {playing && <ReplayPlayer recordingId={playing.id} />}
        </SheetContent>
      </Sheet>
    </div>
  )
}
