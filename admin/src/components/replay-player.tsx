/**
 * Session replay player on rrweb's own Replayer engine — the /session-replays page and the
 * Traffic Map's recording panel both use it. (rrweb-player 2.x ships a broken build — its bundle
 * never constructs a Replayer — so the controls live here: play/pause, scrubber, speed,
 * auto-scaled viewport, live follow, route + console markers.)
 */
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'

function fmtClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const SPEEDS = [1, 2, 4, 8]

export function ReplayPlayer({
  recordingId,
  startAt,
  live,
  minHeight = 400
}: {
  recordingId: string
  /** Offset into the recording (ms); playback opens 5 s before it. */
  startAt?: number | null
  live?: boolean
  /** Frame height before the first snapshot scales it (a narrow panel wants less). */
  minHeight?: number
}) {
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
  const lastSeqRef = useRef<number>(-1)
  const [following, setFollowing] = useState(!!live)
  // Replay context: route changes + the user's console
  // lines ride the recording as rrweb custom events (type 5) — markers on
  // the scrubber, console panel underneath, both seekable.
  const [markers, setMarkers] = useState<
    Array<{ offset: number; tag: 'route' | 'console'; level?: string; text: string }>
  >([])
  const [consoleFilter, setConsoleFilter] = useState<'all' | 'info' | 'warn' | 'error'>('all')

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
        const r = await api.get<{ data: { events: unknown[]; last_seq?: number } }>(
          `/session-recordings/${recordingId}/events`
        )
        if (cancelled || !frameRef.current) return
        const events = r.data.data.events
        lastSeqRef.current = r.data.data.last_seq ?? -1
        {
          const evs = events as Array<{
            type?: number
            timestamp?: number
            data?: { tag?: string; payload?: Record<string, unknown> }
          }>
          const first = evs.find((e) => typeof e.timestamp === 'number')?.timestamp ?? 0
          const found: Array<{
            offset: number
            tag: 'route' | 'console'
            level?: string
            text: string
          }> = []
          for (const e of evs) {
            if (e.type !== 5 || !e.data?.tag || typeof e.timestamp !== 'number') continue
            if (e.data.tag === 'route') {
              found.push({
                offset: e.timestamp - first,
                tag: 'route',
                text: String(e.data.payload?.path ?? '')
              })
            } else if (e.data.tag === 'console') {
              found.push({
                offset: e.timestamp - first,
                tag: 'console',
                level: String(e.data.payload?.level ?? 'info'),
                text: String(e.data.payload?.msg ?? '')
              })
            }
          }
          setMarkers(found)
        }
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
          skipInactive: !following,
          // Live-follow: rrweb's liveMode plays events as they are appended,
          // pinned to the tail of the stream.
          liveMode: following,
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
        if (following) {
          // Start at the live edge: a small lag budget absorbs poll jitter so
          // playback never overruns the buffered stream and stalls.
          const liveRep = replayer as unknown as { startLive: (t?: number) => void }
          const lastTs = (events[events.length - 1] as { timestamp?: number })?.timestamp
          liveRep.startLive(lastTs ? lastTs - 4_000 : undefined)
          setPlaying(true)
        } else {
          // ?t= deep link (issue log's Watch-replay): open AT the error moment,
          // a few seconds early so the action that caused it is on screen.
          const meta = replayer.getMetaData()
          const seekTo =
            startAt != null && Number.isFinite(startAt)
              ? Math.max(0, Math.min(startAt - 5000, Math.max(0, meta.totalTime - 1000)))
              : 0
          replayer.play(seekTo)
          setPlaying(true)
        }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordingId, following])

  // Live-follow poll: fetch only chunks newer than what the player holds and
  // feed them straight into the live Replayer. 3s matches the recorder's
  // flush cadence closely enough to feel continuous.
  useEffect(() => {
    if (!following || !ready) return
    let stopped = false
    const timer = setInterval(async () => {
      if (stopped) return
      try {
        const r = await api.get<{ data: { events: unknown[]; last_seq?: number } }>(
          `/session-recordings/${recordingId}/events?after_seq=${lastSeqRef.current}`
        )
        if (stopped) return
        const fresh = r.data.data.events
        if (r.data.data.last_seq != null) lastSeqRef.current = r.data.data.last_seq
        const rep = replayerRef.current as unknown as {
          addEvent?: (e: unknown) => void
        } | null
        if (rep?.addEvent) for (const e of fresh) rep.addEvent(e)
      } catch {
        /* transient poll failure — next tick retries */
      }
    }, 3_000)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [following, ready, recordingId])

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
        style={{ minHeight }}
      />
      {ready && following && (
        <div className='mt-2 flex items-center gap-3'>
          <span className='flex items-center gap-1.5 rounded-full bg-red-500/10 px-2.5 py-1 text-[11.5px] font-medium text-red-600 dark:text-red-400'>
            <span className='h-2 w-2 animate-pulse rounded-full bg-red-500' />
            LIVE — following in real time
          </span>
          <span className='text-[11.5px] text-slate-400'>
            New activity streams in as it happens.
          </span>
          <span className='flex-1' />
          <Button
            size='sm'
            variant='outline'
            className='h-7 text-[12px]'
            onClick={() => setFollowing(false)}
          >
            Exit live · scrub recording
          </Button>
        </div>
      )}
      {ready && !following && (
        <div className='mt-2 flex items-center gap-3'>
          {live && (
            <Button
              size='sm'
              variant='outline'
              className='h-7 gap-1.5 text-[12px] text-red-600 dark:text-red-400'
              onClick={() => setFollowing(true)}
            >
              <span className='h-2 w-2 animate-pulse rounded-full bg-red-500' /> Go live
            </Button>
          )}
          <Button size='sm' variant='outline' className='h-7 w-16 text-[12px]' onClick={togglePlay}>
            {playing ? 'Pause' : time >= total && total > 0 ? 'Replay' : 'Play'}
          </Button>
          <span className='w-10 text-right font-mono text-[11px] tabular-nums text-slate-500'>
            {fmtClock(time)}
          </span>
          <div className='relative flex-1'>
            {/* Event ticks: routes sky, console warn amber, error red —
                clickable, positioned by offset. */}
            <div className='pointer-events-none absolute inset-x-0 -top-1.5 h-1.5'>
              {total > 0 &&
                markers.map((m, i) => {
                  if (m.tag === 'console' && m.level === 'info') return null
                  const left = `${Math.min(100, Math.max(0, (m.offset / total) * 100))}%`
                  const color =
                    m.tag === 'route' ? '#38bdf8' : m.level === 'error' ? '#ef4444' : '#f59e0b'
                  return (
                    <button
                      key={i}
                      type='button'
                      onClick={() => seek(Math.max(0, m.offset - 500))}
                      className='pointer-events-auto absolute h-1.5 w-[3px] -translate-x-1/2 rounded-sm'
                      style={{ left, background: color }}
                      data-tip={`${fmtClock(m.offset)} · ${m.tag === 'route' ? m.text : `${m.level}: ${m.text.slice(0, 120)}`}`}
                    />
                  )
                })}
            </div>
            <input
              type='range'
              min={0}
              max={Math.max(1, total)}
              value={Math.min(time, total)}
              onChange={(e) => seek(Number(e.target.value))}
              className='w-full accent-[#00ceff]'
              aria-label='Replay position'
            />
          </div>
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
      {ready && !following && markers.some((m) => m.tag === 'console') && (
        <div className='mt-3 rounded-lg border border-slate-200 dark:border-border'>
          <div className='flex items-center gap-2 border-b border-slate-100 px-3 py-1.5 dark:border-border/60'>
            <span className='text-[11px] font-semibold uppercase tracking-wide text-slate-400'>
              Console
            </span>
            {(['all', 'info', 'warn', 'error'] as const).map((f) => {
              const n =
                f === 'all'
                  ? markers.filter((m) => m.tag === 'console').length
                  : markers.filter((m) => m.tag === 'console' && m.level === f).length
              return (
                <button
                  key={f}
                  type='button'
                  onClick={() => setConsoleFilter(f)}
                  className={`rounded px-1.5 py-0.5 text-[11px] ${consoleFilter === f ? 'bg-accent font-medium text-accent-foreground' : 'text-slate-400 hover:bg-muted'}`}
                >
                  {f} {n > 0 && <span className='tabular-nums'>({n})</span>}
                </button>
              )
            })}
            <span className='ml-auto text-[10.5px] text-slate-400'>click a line to seek</span>
          </div>
          <div className='max-h-56 overflow-y-auto p-2 font-mono text-[11px] leading-relaxed'>
            {markers
              .filter(
                (m) => m.tag === 'console' && (consoleFilter === 'all' || m.level === consoleFilter)
              )
              .map((m, i) => (
                <button
                  key={i}
                  type='button'
                  onClick={() => seek(Math.max(0, m.offset - 500))}
                  className='flex w-full items-start gap-2 rounded px-1.5 py-0.5 text-left hover:bg-muted'
                >
                  <span className='shrink-0 tabular-nums text-slate-400'>{fmtClock(m.offset)}</span>
                  <span
                    className={`shrink-0 ${m.level === 'error' ? 'text-red-500' : m.level === 'warn' ? 'text-amber-500' : 'text-sky-500'}`}
                  >
                    {m.level}
                  </span>
                  <span className='min-w-0 break-all text-slate-600 dark:text-slate-300'>
                    {m.text}
                  </span>
                </button>
              ))}
          </div>
        </div>
      )}
    </div>
  )
}
