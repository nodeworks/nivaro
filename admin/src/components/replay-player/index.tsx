/**
 * Session replay player on rrweb's own Replayer engine — the /session-replays page and the
 * Traffic Map's recording panel both use it. (rrweb-player 2.x ships a broken build — its bundle
 * never constructs a Replayer — so the controls live here: play/pause, scrubber, speed,
 * auto-scaled viewport, live follow, route + console markers above the scrubber, the
 * server-side event rail (#1356) under it and the Console / Network panel (#1357) beside it.)
 */
import { TipLayer } from '@nivaro/shared'
import { PictureInPicture2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { ChapterList, useChapterKeys } from './ChapterList'
import { buildChapters, chapterIndexAt } from './chapters'
import type { ReplayControls } from './controls'
import { EventRail } from './EventRail'
import { findInactiveGaps, type InactiveGap } from './inactivity'
import {
  activeIndex,
  fmtClock,
  parseReplayContext,
  type RailItem,
  type RailKind,
  type ReplayContext,
  railMarkers
} from './logic'
import { ReplaySidePanel } from './SidePanel'
import { SkipBands, SkippingBadge, SkipToggle, useSkipInactivity } from './SkipInactivity'
import { WatchTogetherBar } from './WatchTogether'

const SPEEDS = [1, 2, 4, 8]

/** The Console / Network column right of the frame (w-80 + the gap). */
const SIDE_PANEL_PX = 320 + 12
/** Below this viewport width a 'side' panel stacks under the controls instead. */
const SIDE_MIN_VIEWPORT = 1100

const NO_CONTEXT: ReplayContext = { routes: [], console: [], network: [] }

function useWideViewport(): boolean {
  const [wide, setWide] = useState(() =>
    typeof window === 'undefined' ? true : window.innerWidth >= SIDE_MIN_VIEWPORT
  )
  useEffect(() => {
    const on = () => setWide(window.innerWidth >= SIDE_MIN_VIEWPORT)
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])
  return wide
}

export function ReplayPlayer({
  recordingId,
  startAt,
  live,
  minHeight = 400,
  panel = 'side',
  onFloat,
  controlsRef
}: {
  recordingId: string
  /** Offset into the recording (ms); playback opens 5 s before it. */
  startAt?: number | null
  live?: boolean
  /** Frame height before the first snapshot scales it (a narrow panel wants less). */
  minHeight?: number
  /**
   * Where the Console / Network panel goes: 'side' (right of the frame — the
   * Session replays sheet; stacks on a narrow window) or 'stacked' (under the
   * controls — narrow hosts like the Traffic Map's Recording level).
   */
  panel?: 'side' | 'stacked' | 'none'
  /** #1401 — shows a Float button; called with the playhead to hand over. */
  onFloat?: (time: number) => void
  /** Filled while the replay is ready: read / drive the playhead from the host. */
  controlsRef?: { current: ReplayControls | null }
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
  // Replay context: route changes, the user's console lines and (#1357) the
  // page's requests ride the recording as rrweb custom events (type 5) —
  // ticks on the scrubber, the Console / Network panel beside the player.
  const [ctx, setCtx] = useState<ReplayContext>(NO_CONTEXT)
  const ticks = useMemo(
    () =>
      [
        ...ctx.routes.map((r) => ({ offset: r.offset, color: '#38bdf8', tip: r.text })),
        ...ctx.console
          .filter((c) => c.level !== 'info')
          .map((c) => ({
            offset: c.offset,
            color: c.level === 'error' ? '#ef4444' : '#f59e0b',
            tip: `${c.level}: ${c.text.slice(0, 120)}`
          }))
      ].sort((a, b) => a.offset - b.offset),
    [ctx]
  )
  const wide = useWideViewport()
  const hasPanel = ctx.console.length > 0 || ctx.network.length > 0
  const sideBySide = panel === 'side' && wide
  // Read by rescale() inside the load effect: the frame's width budget.
  const sideReserveRef = useRef(0)
  sideReserveRef.current = sideBySide && hasPanel && !following ? SIDE_PANEL_PX : 0
  const rescaleRef = useRef<(() => void) | null>(null)
  // #1356 event rail: the person's requests / errors / page changes /
  // transitions from the server, placed against the first event's clock.
  const [rail, setRail] = useState<{
    items: RailItem[]
    first: number
    truncated: RailKind[]
  } | null>(null)
  const railMarks = useMemo(
    () => (rail ? railMarkers(rail.items, rail.first, total) : []),
    [rail, total]
  )
  // #1358 skip inactivity: idle stretches crossed at 8× (or real time).
  const [gaps, setGaps] = useState<InactiveGap[]>([])
  const skip = useSkipInactivity(replayerRef, gaps, speed, ready && !following && playing)
  const skipTickRef = useRef(skip.onTick)
  skipTickRef.current = skip.onTick

  useEffect(() => {
    let cancelled = false
    let raf = 0
    setRail(null)
    setCtx(NO_CONTEXT)
    setGaps([])

    function rescale() {
      const rep = replayerRef.current
      const host = frameRef.current
      if (!rep || !host) return
      const w = rep.iframe.offsetWidth || 1280
      const h = rep.iframe.offsetHeight || 720
      // Width budget from the sheet itself — the host div can be mid-animation
      // (or grown by the giant iframe), so never trust host.clientWidth alone.
      // The Console / Network column, when it sits beside the frame, comes off.
      const sheetW = window.innerWidth * 0.85 - 56 - sideReserveRef.current
      const budget = Math.min(host.parentElement?.clientWidth || sheetW, sheetW)
      // Fill the sheet: scale up as well as down, bounded by width and viewport height
      const scale = Math.min(budget / w, (window.innerHeight - 170) / h)
      rep.wrapper.style.transform = `scale(${scale})`
      rep.wrapper.style.transformOrigin = 'top left'
      host.style.width = `${Math.ceil(w * scale)}px`
      host.style.height = `${Math.ceil(h * scale)}px`
    }
    rescaleRef.current = rescale

    async function load() {
      try {
        // The rail rides alongside the events and never holds the replay up.
        const railReq = api
          .get<{
            data: { items: RailItem[]; truncated_kinds?: RailKind[] }
          }>(`/session-recordings/${recordingId}/events-rail`)
          .then((x) => x.data.data)
          .catch(() => null)
        const r = await api.get<{ data: { events: unknown[]; last_seq?: number } }>(
          `/session-recordings/${recordingId}/events`
        )
        if (cancelled || !frameRef.current) return
        const events = r.data.data.events
        lastSeqRef.current = r.data.data.last_seq ?? -1
        {
          const first = Number(
            (events as Array<{ timestamp?: unknown } | null>).find(
              (e) => typeof e?.timestamp === 'number'
            )?.timestamp ?? 0
          )
          void railReq.then((d) => {
            if (cancelled || !d || !first) return
            setRail({ items: d.items ?? [], first, truncated: d.truncated_kinds ?? [] })
          })
          setCtx(parseReplayContext(events, first))
          setGaps(findInactiveGaps(events, first))
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
          // Inactivity is skipped by our own driver (#1358, ./SkipInactivity).
          skipInactive: false,
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
            const now = replayerRef.current.getCurrentTime()
            setTime(Math.min(now, total || Number.MAX_SAFE_INTEGER))
            skipTickRef.current(now)
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
      rescaleRef.current = null
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

  // Stable for the memoised rail and panel — they must not re-render every animation frame.
  const seekRef = useRef(seek)
  seekRef.current = seek
  const stableSeek = useCallback((ms: number) => seekRef.current(ms), [])

  // #1397 chapters: a new one at every page change (recorder stamps + page trail).
  const chapters = useMemo(
    () =>
      buildChapters(
        ctx.routes,
        railMarks
          .filter((m) => m.kind === 'route')
          .map((m) => ({ offset: m.offset, text: m.label })),
        total
      ),
    [ctx.routes, railMarks, total]
  )
  const timeRef = useRef(time)
  timeRef.current = time
  useChapterKeys(chapters, () => timeRef.current, stableSeek, ready && !following)

  // #1401 / #1399: the host reads and drives the playhead (refs and setters
  // only, so the first render's closures stay valid).
  const speedRef = useRef(speed)
  speedRef.current = speed
  // biome-ignore lint/correctness/useExhaustiveDependencies: playAt / changeSpeed only touch refs and setters
  const controls = useMemo<ReplayControls>(
    () => ({
      getTime: () => timeRef.current,
      isPlaying: () => playingRef.current,
      getSpeed: () => speedRef.current,
      seek: (ms) => seekRef.current(ms),
      playAt,
      setSpeed: changeSpeed
    }),
    []
  )
  const ownControlsRef = useRef<ReplayControls | null>(null)
  useEffect(() => {
    const live = ready && !following ? controls : null
    ownControlsRef.current = live
    if (controlsRef) controlsRef.current = live
    return () => {
      ownControlsRef.current = null
      if (controlsRef) controlsRef.current = null
    }
  }, [controlsRef, controls, ready, following])

  // The panel re-renders when the highlighted row changes, not every frame.
  const activeConsole = activeIndex(ctx.console, time)
  const activeNetwork = activeIndex(ctx.network, time)
  const showPanel = ready && !following && hasPanel && panel !== 'none'
  const side = showPanel && sideBySide
  // The frame's width budget moved: scale it again.
  const lastSideRef = useRef(side)
  useEffect(() => {
    if (lastSideRef.current === side) return
    lastSideRef.current = side
    rescaleRef.current?.()
  }, [side])

  function playAt(on: boolean, ms: number) {
    const rep = replayerRef.current
    if (!rep) return
    setTime(ms)
    if (on) rep.play(ms)
    else rep.pause(ms)
    playingRef.current = on
    setPlaying(on)
  }

  function changeSpeed(v: number) {
    setSpeed(v)
    replayerRef.current?.setConfig({ speed: v })
  }

  if (error) return <p className='py-10 text-center text-[13px] text-slate-400'>{error}</p>

  const panelEl = (layout: 'side' | 'stacked') => (
    <ReplaySidePanel
      consoleEntries={ctx.console}
      networkEntries={ctx.network}
      activeConsole={activeConsole}
      activeNetwork={activeNetwork}
      onSeek={stableSeek}
      layout={layout}
    />
  )

  return (
    <div className='nvr-no-record mt-3'>
      <TipLayer />
      {/* Same element tree with or without the side column — the frame must
          never remount under a live Replayer. */}
      <div className={side ? 'flex items-stretch gap-3' : ''}>
        <div className={side ? 'relative min-w-0 flex-1' : 'relative'}>
          <SkippingBadge gap={skip.current} />
          <div
            ref={frameRef}
            className='w-full overflow-hidden rounded-lg border border-slate-200 bg-slate-100 dark:border-border dark:bg-muted [&_iframe]:border-0 [&_iframe]:bg-white'
            style={{ minHeight }}
          />
        </div>
        {side && panelEl('side')}
      </div>
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
                ticks.map((m, i) => (
                  <button
                    key={`${i}:${m.offset}`}
                    type='button'
                    onClick={() => seek(Math.max(0, m.offset - 500))}
                    className='pointer-events-auto absolute h-1.5 w-[3px] -translate-x-1/2 rounded-sm'
                    style={{
                      left: `${Math.min(100, Math.max(0, (m.offset / total) * 100))}%`,
                      background: m.color
                    }}
                    data-tip={`${fmtClock(m.offset)} · ${m.tip}`}
                  />
                ))}
            </div>
            <SkipBands gaps={gaps} total={total} enabled={skip.enabled} />
            <input
              type='range'
              min={0}
              max={Math.max(1, total)}
              value={Math.min(time, total)}
              onChange={(e) => seek(Number(e.target.value))}
              className='w-full accent-[#00ceff]'
              aria-label='Replay position'
            />
            <EventRail
              markers={railMarks}
              total={total}
              truncated={rail?.truncated ?? []}
              onSeek={stableSeek}
            />
          </div>
          <span className='w-10 font-mono text-[11px] tabular-nums text-slate-500'>
            {fmtClock(total)}
          </span>
          {onFloat && (
            <Button
              size='sm'
              variant='outline'
              className='h-7 gap-1 px-2 text-[12px]'
              onClick={() => onFloat(time)}
              data-tip='Float — keep watching in a corner window while you use the admin'
              data-replay-float=''
            >
              <PictureInPicture2 className='h-3 w-3' /> Float
            </Button>
          )}
          {gaps.length > 0 && (
            <SkipToggle enabled={skip.enabled} onChange={skip.setEnabled} count={gaps.length} />
          )}
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
      {ready && !following && (
        <ChapterList
          chapters={chapters}
          current={chapterIndexAt(chapters, time)}
          onSeek={stableSeek}
        />
      )}
      <WatchTogetherBar
        recordingId={recordingId}
        controlsRef={ownControlsRef}
        ready={ready && !following}
      />
      {showPanel && !side && panelEl('stacked')}
    </div>
  )
}
