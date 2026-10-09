import { useQueryClient } from '@tanstack/react-query'
import { Captions, Hourglass, Maximize, Pause, Play, RotateCw, VideoOff } from 'lucide-react'
import {
  type KeyboardEvent,
  type MutableRefObject,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { useApiFetchConfig, useNivaroClient } from '../../context'
import { fetchHelpVideo, helpVideoApi, helpVideoKeys, useCardBrand } from './api'
import { CardLayer } from './CardLayer'
import {
  bodyDuration,
  cardPhaseAt,
  editedDuration,
  editedToSource,
  introMs,
  outroMs,
  sourceToEdited
} from './edits'
import { OverlayLayer } from './OverlayLayer'
import { fitFrame, liveStep, resolveDurationMs, zoomAt } from './playerMath'
import { createProgressBeats } from './progressBeats'
import type { HelpVideoDto, VideoEdits } from './types'

export type PlayerHandle = {
  seekEdited(ms: number): void
  seekSource(ms: number): void
  play(): void
  pause(): void
  sourceMs(): number
  editedMs(): number
  frame(): { width: number; height: number } | null
}

const SPEEDS = [0.75, 1, 1.25, 1.5, 2]

/** The intro or outro card on screen while the edits play live: the video
 *  waits (paused on the first or last kept frame) and this clock runs. */
type Card = { kind: 'intro' | 'outro'; at: number; playing: boolean }
const fmt = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** A video the stream would refuse with 409 HELP_VIDEO_PROCESSING: a viewer
 *  (authors always get a file) and the published version has no current
 *  render while its edits hide something. */
const isAuthorView = (v: HelpVideoDto) => v.visibility !== undefined
const viewerMustWait = (v: HelpVideoDto) => !isAuthorView(v) && v.published?.playable === false

/** Progress is reported for the published video only. Waiting for the
 *  video's length is the beat tracker's job (progressBeats.ts). */
const isTracking = (l: { trackProgress: boolean; useDraft: boolean }) =>
  l.trackProgress && !l.useDraft

// Shape and states only; each button adds its own ink (mixing two text-*
// colours in one class list lets CSS order pick the winner).
const iconButton =
  'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors duration-150 hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan motion-reduce:transition-none dark:hover:bg-white/5 dark:hover:text-foreground'
const inkMuted = 'text-slate-600 dark:text-muted-foreground'
const inkStrong = 'text-slate-900 dark:text-foreground'

export type HelpVideoPlayerProps = {
  video: HelpVideoDto
  /** viewer = rendered file when current; live = always source + edits (authors). */
  mode?: 'viewer' | 'live'
  /** Editor working copy (live mode). */
  edits?: VideoEdits
  /** Play the draft (authors in the editor). */
  useDraft?: boolean
  onTime?: (sourceMs: number, editedMs: number) => void
  trackProgress?: boolean
  autoPlay?: boolean
  handleRef?: MutableRefObject<PlayerHandle | null>
  className?: string
  /** Rendered in frame coordinates above the video, outside the zoom (editor tools). */
  children?: (frame: { width: number; height: number }) => ReactNode
}

/** Keyed by video id: switching to another video starts a fresh player, so
 *  progress, the resume point and the one-retry flag never carry over. */
export function HelpVideoPlayer(props: HelpVideoPlayerProps) {
  return <PlayerInner key={props.video.id} {...props} />
}

function PlayerInner({
  video,
  mode,
  edits: editsProp,
  useDraft = false,
  onTime,
  trackProgress = true,
  autoPlay = false,
  handleRef,
  className,
  children
}: HelpVideoPlayerProps) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const { apiBase, authHeaders, credentials } = useApiFetchConfig()
  const origin = apiBase.replace(/\/api$/, '')

  // Media tickets expire after a few hours. A failed load fetches the video
  // again for fresh URLs; that copy wins until the host passes a newer one.
  const [fresh, setFresh] = useState<HelpVideoDto | null>(null)
  const [failure, setFailure] = useState<null | 'processing' | 'error'>(null)
  const retried = useRef(false)
  // A new `video` prop (the host refetched: fresh tickets, maybe a finished
  // render) supersedes the refreshed copy and any earlier load failure. The
  // one-retry flag is NOT reset here: our own refresh updates a host that
  // reads useHelpVideo(id), and resetting would turn a broken stream into an
  // endless refresh loop. Only a successful load (onLoadedData) re-arms it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on purpose when `video` changes
  useEffect(() => {
    setFresh(null)
    setFailure(null)
  }, [video])
  const dto = fresh && fresh.id === video.id ? fresh : video

  const author = isAuthorView(dto)
  const live = useDraft || (mode === 'live' && author)
  const version = useDraft ? dto.draft : dto.published
  const edits = editsProp ?? version?.edits
  const rendered = !live && !!version?.rendered_current
  // Ticketed URLs are used exactly as the server sent them. Authors previewing
  // a draft or live edits play the draft's original (draft_stream_url). When
  // there is no draft yet (the editor creates it on first load) or it was just
  // published, an author falls back to the published original; a viewer never
  // asks for an original.
  const withSource = (url: string) => `${url}${url.includes('?') ? '&' : '?'}source=1`
  const srcPath = live
    ? (dto.draft_stream_url ?? (author && dto.stream_url ? withSource(dto.stream_url) : null))
    : dto.stream_url
  const src = srcPath ? `${origin}${srcPath}` : null
  const poster = !live && dto.poster_url ? `${origin}${dto.poster_url}` : undefined

  const rootRef = useRef<HTMLDivElement | null>(null)
  const boxRef = useRef<HTMLDivElement | null>(null)
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  videoRef.current = videoEl
  const [frame, setFrame] = useState<{
    left: number
    top: number
    width: number
    height: number
  } | null>(null)
  const [srcMs, setSrcMs] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [started, setStarted] = useState(false)
  const [userRate, setUserRate] = useState(1)
  const [captions, setCaptions] = useState(true)
  const [fileDurMs, setFileDurMs] = useState(0)
  const [checking, setChecking] = useState(false)
  const resumeAt = useRef<number | null>(null)
  // Edits played live (no render): the intro and outro cards are drawn here
  // and run on their own clock. A rendered file already contains them.
  const liveEdits = !rendered && !!edits
  const lead = edits ? introMs(edits) : 0
  const tail = edits ? outroMs(edits) : 0
  const hasCards = !!edits && (lead > 0 || tail > 0 || edits.chapter_banners === true)
  const brand = useCardBrand(hasCards && !rendered, origin)
  const [card, setCardState] = useState<Card | null>(() =>
    liveEdits && lead > 0 ? { kind: 'intro', at: 0, playing: false } : null
  )
  const cardRef = useRef(card)
  const setCard = useCallback((c: Card | null) => {
    cardRef.current = c
    setCardState(c)
  }, [])

  const status: 'ok' | 'processing' | 'error' | 'unavailable' =
    (!live && viewerMustWait(dto)) || failure === 'processing'
      ? 'processing'
      : failure === 'error'
        ? 'error'
        : src
          ? 'ok'
          : 'unavailable'

  const totalMs = rendered ? fileDurMs : edits ? editedDuration(edits) : 0
  const bodyEdited = rendered ? srcMs : edits ? (sourceToEdited(edits, srcMs) ?? lead) : srcMs
  const editedMs =
    card && edits
      ? card.kind === 'intro'
        ? card.at
        : lead + bodyDuration(edits) + card.at
      : bodyEdited
  const overlaySrcMs = rendered && edits ? editedToSource(edits, srcMs) : srcMs
  // Captions and the overlays belong to the recording, not to a card.
  const phase = edits ? cardPhaseAt(edits, editedMs).phase : 'body'
  const isPlaying = card ? card.playing : playing

  // The cards come and go with the edits (the editor switches them on and
  // off): a card that is no longer there gives way; a new intro shows only
  // before playback starts.
  useEffect(() => {
    const c = cardRef.current
    if (!liveEdits) {
      if (c) setCard(null)
      return
    }
    if (c?.kind === 'intro' && lead <= 0) setCard(null)
    else if (c?.kind === 'outro' && tail <= 0) setCard(null)
    else if (!c && lead > 0 && !started && (videoRef.current?.paused ?? true)) {
      setCard({ kind: 'intro', at: 0, playing: false })
    }
  }, [liveEdits, lead, tail, started, setCard])

  // Measure the visible picture (object-fit: contain letterboxing).
  useEffect(() => {
    const box = boxRef.current
    if (!box) return
    const measure = () => {
      const w = videoEl?.videoWidth || version?.width || 16
      const h = videoEl?.videoHeight || version?.height || 9
      setFrame(fitFrame(box.clientWidth, box.clientHeight, w, h))
    }
    const ro = new ResizeObserver(measure)
    ro.observe(box)
    videoEl?.addEventListener('loadedmetadata', measure)
    measure()
    return () => {
      ro.disconnect()
      videoEl?.removeEventListener('loadedmetadata', measure)
    }
  }, [videoEl, version?.width, version?.height])

  // Live mode: skip cuts and apply each piece's speed on every frame.
  useEffect(() => {
    const v = videoEl
    if (!v) return
    let raf = 0
    let last = performance.now()
    const tick = (now: number) => {
      const dt = Math.max(0, now - last)
      last = now
      const c = cardRef.current
      if (!rendered && edits && c?.playing) {
        const len = c.kind === 'intro' ? introMs(edits) : outroMs(edits)
        const at = c.at + dt * userRate
        if (at < len) setCard({ ...c, at })
        else if (c.kind === 'intro') {
          // The intro is over: the recording starts at its first kept frame.
          setCard(null)
          v.currentTime = (edits.segments[0]?.start_ms ?? 0) / 1000
          void v.play().catch(() => null)
        } else {
          setCard({ ...c, at: len, playing: false })
          cardEndedRef.current()
        }
      }
      const ms = v.currentTime * 1000
      if (!rendered && edits && !v.paused) {
        const step = liveStep(edits, ms)
        if (step.action === 'end') {
          v.pause()
          // The recording is over: the outro card plays, then the video ends.
          if (outroMs(edits) > 0 && !cardRef.current) {
            setCard({ kind: 'outro', at: 0, playing: true })
          }
        } else {
          if (v.playbackRate !== step.rate * userRate) v.playbackRate = step.rate * userRate
          if (step.action === 'seek') v.currentTime = step.toMs / 1000
        }
      }
      setSrcMs(v.currentTime * 1000)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [videoEl, rendered, edits, userRate, setCard])

  useEffect(() => {
    if (rendered && videoEl) videoEl.playbackRate = userRate
  }, [videoEl, rendered, userRate])

  useEffect(() => {
    onTime?.(overlaySrcMs, editedMs)
  }, [overlaySrcMs, editedMs, onTime])

  const seekEdited = useCallback(
    (ms: number) => {
      const v = videoRef.current
      if (!v) return
      if (rendered || !edits) {
        v.currentTime = ms / 1000
        return
      }
      const c = cardRef.current
      const wasPlaying = c ? c.playing : !v.paused
      const p = cardPhaseAt(edits, ms)
      if (p.phase === 'body') {
        if (c) setCard(null)
        v.currentTime = editedToSource(edits, ms) / 1000
        if (c && wasPlaying && v.paused) void v.play().catch(() => null)
        return
      }
      // Inside a card: the video waits on the frame next to it.
      const segs = edits.segments
      const at = p.phase === 'intro' ? segs[0]?.start_ms : segs[segs.length - 1]?.end_ms
      if (!v.paused) v.pause()
      v.currentTime = (at ?? 0) / 1000
      setCard({ kind: p.phase, at: p.at, playing: wasPlaying })
    },
    [rendered, edits, setCard]
  )
  const seekSource = useCallback(
    (ms: number) => {
      // A source moment is always in the recording, never on a card.
      if (cardRef.current) setCard(null)
      if (videoRef.current) videoRef.current.currentTime = ms / 1000
    },
    [setCard]
  )
  const togglePlay = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    const c = cardRef.current
    if (c && edits && !rendered) {
      const ended = c.kind === 'outro' && !c.playing && c.at >= outroMs(edits)
      if (ended) {
        // Play again from the very start.
        if (introMs(edits) > 0) setCard({ kind: 'intro', at: 0, playing: true })
        else {
          setCard(null)
          v.currentTime = (edits.segments[0]?.start_ms ?? 0) / 1000
          void v.play().catch(() => null)
        }
        return
      }
      setCard({ ...c, playing: !c.playing })
      if (!c.playing) {
        setStarted(true)
        openWatchRef.current()
      } else sendRef.current()
      return
    }
    if (v.paused) void v.play().catch(() => null)
    else v.pause()
  }, [edits, rendered, setCard])
  const fullscreen = () => void rootRef.current?.requestFullscreen?.().catch(() => null)

  if (handleRef) {
    handleRef.current = {
      seekEdited,
      seekSource,
      play: () => {
        const c = cardRef.current
        if (c) {
          if (!c.playing) togglePlay()
        } else void videoRef.current?.play().catch(() => null)
      },
      pause: () => {
        const c = cardRef.current
        if (c) {
          if (c.playing) togglePlay()
        } else videoRef.current?.pause()
      },
      sourceMs: () => (videoRef.current?.currentTime ?? 0) * 1000,
      editedMs: () => editedMs,
      frame: () => (frame ? { width: frame.width, height: frame.height } : null)
    }
  }

  // Resume where this person stopped (unless they finished it).
  const resumed = useRef(false)
  useEffect(() => {
    const v = videoEl
    if (!v || resumed.current || useDraft) return
    const at = dto.my_progress && !dto.my_progress.completed ? dto.my_progress.position_ms : 0
    const onMeta = () => {
      resumed.current = true
      if (at > 5000) seekEdited(at)
      if (!rendered && edits?.segments[0] && v.currentTime * 1000 < edits.segments[0].start_ms) {
        // Straight to the first kept frame (an intro card stays up meanwhile).
        v.currentTime = edits.segments[0].start_ms / 1000
      }
    }
    v.addEventListener('loadedmetadata', onMeta, { once: true })
    return () => v.removeEventListener('loadedmetadata', onMeta)
  }, [videoEl, dto.my_progress, useDraft, rendered, edits, seekEdited])

  // Autoplay with an intro card: the card's clock starts instead of the video.
  const autoStarted = useRef(false)
  useEffect(() => {
    if (!autoPlay || autoStarted.current || !card || card.kind !== 'intro' || started) return
    autoStarted.current = true
    setCard({ ...card, playing: true })
    setStarted(true)
  }, [autoPlay, card, started, setCard])

  // Progress: one beat the moment watching starts (it opens the server's
  // watch period), then the sections seen every 10 s, on pause, at the end
  // and on close. See progressBeats.ts.
  // Everything the beats read lives in refs, so `beats` is created once per
  // player (useApiFetchConfig returns a new headers object every render).
  const latest = useRef({ trackProgress, useDraft, totalMs, editedMs, dto })
  latest.current = { trackProgress, useDraft, totalMs, editedMs, dto }
  const io = useRef({ apiBase, authHeaders, credentials, client, qc })
  io.current = { apiBase, authHeaders, credentials, client, qc }
  const [beats] = useState(() =>
    createProgressBeats((body, keepalive) => {
      const { apiBase, authHeaders, credentials, client, qc } = io.current
      const id = latest.current.dto.id
      if (keepalive) {
        return fetch(`${apiBase}/help-videos/${id}/progress`, {
          method: 'POST',
          keepalive: true,
          credentials,
          headers: { 'Content-Type': 'application/json', ...authHeaders },
          body: JSON.stringify(body)
        })
      }
      const wasComplete = !!latest.current.dto.my_progress?.completed
      return helpVideoApi(client)
        .progress(id, body)
        .then((r) => {
          // The first post that counts the video as watched refreshes the
          // required list and the video's own progress.
          if (r?.data?.completed && !wasComplete) {
            void qc.invalidateQueries({ queryKey: helpVideoKeys.required })
            void qc.invalidateQueries({ queryKey: helpVideoKeys.one(id) })
          }
        })
    })
  )
  useEffect(() => {
    if (!isPlaying || !totalMs) {
      beats.idle()
      return
    }
    // Playback may start before the length is known (autoplay, slow
    // network): the watch period opens as soon as it is.
    if (!beats.opened && isTracking(latest.current)) {
      void beats.tryOpen(editedMs, latest.current.dto.published?.id, totalMs)
    }
    beats.see(editedMs, totalMs, performance.now())
  }, [beats, isPlaying, editedMs, totalMs])
  const send = useCallback(
    (keepalive = false) => {
      const l = latest.current
      if (!isTracking(l)) return
      void beats.beat(l.editedMs, l.dto.published?.id, l.totalMs, keepalive)
    },
    [beats]
  )
  const openWatch = () => {
    const l = latest.current
    if (!isTracking(l) || beats.opened) return
    void beats.play(l.editedMs, l.dto.published?.id, l.totalMs)
  }
  const openWatchRef = useRef(openWatch)
  openWatchRef.current = openWatch
  const sendRef = useRef(send)
  sendRef.current = send
  // The outro card finished: the video has ended.
  const cardEndedRef = useRef(() => sendRef.current())
  useEffect(() => {
    if (!isPlaying) return
    const t = setInterval(() => sendRef.current(), 10_000)
    return () => clearInterval(t)
  }, [isPlaying])
  useEffect(() => {
    const onHide = () => sendRef.current(true)
    window.addEventListener('pagehide', onHide)
    return () => {
      window.removeEventListener('pagehide', onHide)
      sendRef.current(true)
    }
  }, [])

  // ── Load failures ────────────────────────────────────────────────────────
  // A <video> error carries no HTTP status, so ask the stream once: a 409
  // HELP_VIDEO_PROCESSING means "still being prepared". Anything else is most
  // likely an expired ticket — fetch the video ONCE for fresh URLs and load
  // again; a second failure shows the error with Retry.
  const refresh = useCallback(async () => {
    const next = await qc.fetchQuery({
      queryKey: helpVideoKeys.one(video.id),
      queryFn: () => fetchHelpVideo(client, video.id),
      staleTime: 0
    })
    setFresh(next)
    return next
  }, [qc, client, video.id])

  const reload = useCallback((next: HelpVideoDto) => {
    if (viewerMustWait(next)) {
      setFailure('processing')
      return
    }
    setFailure(null)
    // Same URL (nothing changed server-side): load it again by hand.
    requestAnimationFrame(() => videoRef.current?.load())
  }, [])

  const onMediaError = useCallback(async () => {
    if (checking || !src) return
    resumeAt.current = (videoRef.current?.currentTime ?? 0) * 1000
    setChecking(true)
    try {
      const res = await fetch(src, { headers: { Range: 'bytes=0-0' }, credentials }).catch(
        () => null
      )
      if (res?.status === 409) {
        const body = (await res.json().catch(() => null)) as { code?: string } | null
        if (body?.code === 'HELP_VIDEO_PROCESSING') {
          setFailure('processing')
          return
        }
      } else {
        void res?.body?.cancel().catch(() => null)
      }
      if (retried.current) {
        setFailure('error')
        return
      }
      retried.current = true
      reload(await refresh())
    } catch {
      setFailure('error')
    } finally {
      setChecking(false)
    }
  }, [checking, src, credentials, refresh, reload])

  const retry = useCallback(async () => {
    setChecking(true)
    retried.current = true
    try {
      reload(await refresh())
    } catch {
      setFailure((f) => f ?? 'error')
    } finally {
      setChecking(false)
    }
  }, [refresh, reload])

  // The recording's own size: annotations are laid out at render size.
  const natural =
    videoEl?.videoWidth && videoEl.videoHeight
      ? { width: videoEl.videoWidth, height: videoEl.videoHeight }
      : version?.width && version.height
        ? { width: version.width, height: version.height }
        : null
  const zoom = !rendered && edits ? zoomAt(edits, overlaySrcMs) : { z: 1, tx: 0, ty: 0 }
  const chapters = useMemo(
    () =>
      (edits?.chapters ?? [])
        .map((c) => ({ ...c, edited: edits ? sourceToEdited(edits, c.at_ms) : null }))
        // A chapter at the very start needs no tick: the track's own start is it.
        .filter((c): c is typeof c & { edited: number } => c.edited !== null && c.edited > 0),
    [edits]
  )

  const onKey = (e: KeyboardEvent) => {
    if (status !== 'ok' || !videoRef.current) return
    const k = e.key.toLowerCase()
    if (k === ' ' || k === 'k') {
      e.preventDefault()
      togglePlay()
    } else if (k === 'arrowleft' || k === 'j') {
      e.preventDefault()
      seekEdited(Math.max(0, editedMs - 5000))
    } else if (k === 'arrowright' || k === 'l') {
      e.preventDefault()
      seekEdited(Math.min(totalMs, editedMs + 5000))
    } else if (k === 'c') setCaptions((x) => !x)
    else if (k === 'f') fullscreen()
  }

  const pct = totalMs ? Math.min(100, (Math.min(editedMs, totalMs) / totalMs) * 100) : 0
  const playable = status === 'ok'

  return (
    <div
      ref={rootRef}
      className={`flex flex-col overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card ${className ?? ''}`}
      data-hv-player={video.id}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useAriaPropsSupportedByRole: the stage is role=application with a label and key handler exactly when it is playable; otherwise it has neither */}
      <div
        ref={boxRef}
        // only a playable stage takes keyboard shortcuts; the state panels are plain content
        role={playable ? 'application' : undefined}
        aria-label={playable ? `Video player: ${dto.title}` : undefined}
        tabIndex={playable ? 0 : undefined}
        onKeyDown={playable ? onKey : undefined}
        className={`relative aspect-video min-h-0 flex-1 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan ${
          playable ? 'bg-[#0b0f17]' : 'bg-slate-50 dark:bg-background'
        }`}
      >
        {playable && (
          <div
            className='absolute overflow-hidden'
            style={
              frame
                ? { left: frame.left, top: frame.top, width: frame.width, height: frame.height }
                : { inset: 0 }
            }
          >
            <div
              className='absolute inset-0 origin-top-left transition-transform duration-75 motion-reduce:transition-none'
              style={{
                transform: `translate(${zoom.tx * 100}%, ${zoom.ty * 100}%) scale(${zoom.z})`
              }}
            >
              {/* biome-ignore lint/a11y/useMediaCaption: captions are drawn by OverlayLayer from the edits */}
              <video
                ref={setVideoEl}
                src={src ?? undefined}
                poster={poster}
                // With an intro card up, the card's clock starts first (see above).
                autoPlay={autoPlay && !(liveEdits && lead > 0)}
                playsInline
                preload='metadata'
                crossOrigin='use-credentials'
                className='absolute inset-0 h-full w-full'
                onPlay={() => {
                  setPlaying(true)
                  setStarted(true)
                  openWatch()
                }}
                onPause={(e) => {
                  setPlaying(false)
                  // at the end the browser fires pause and then ended: onEnded sends
                  if (!e.currentTarget.ended) send()
                }}
                onEnded={() => {
                  setPlaying(false)
                  // The file ran out before the live step saw the end: the outro still plays.
                  if (liveEdits && tail > 0 && !cardRef.current) {
                    setCard({ kind: 'outro', at: 0, playing: true })
                  } else send()
                }}
                onLoadedMetadata={() => {
                  if (resumeAt.current !== null) {
                    seekSource(resumeAt.current)
                    resumeAt.current = null
                  }
                }}
                onLoadedData={() => {
                  // A good load re-arms the one fresh-URL retry for a later expiry.
                  retried.current = false
                }}
                onError={() => void onMediaError()}
                onDurationChange={(e) =>
                  setFileDurMs(
                    resolveDurationMs(e.currentTarget.duration, version?.source_duration_ms ?? null)
                  )
                }
                onClick={togglePlay}
              />
              {frame && edits && !rendered && phase === 'body' && (
                <OverlayLayer
                  edits={edits}
                  frame={frame}
                  srcMs={overlaySrcMs}
                  source={natural}
                  showCaptions={false}
                />
              )}
            </div>
            {/* Cards and chapter banners: drawn here only when the edits play
                live; a rendered file already has them in the picture. */}
            {frame && edits && liveEdits && hasCards && (
              <CardLayer
                edits={edits}
                editedMs={editedMs}
                frame={frame}
                source={natural}
                video={dto}
                brand={brand}
              />
            )}
            {frame && edits && captions && phase === 'body' && (
              <OverlayLayer
                edits={{ ...edits, annotations: [], blurs: [] }}
                frame={frame}
                srcMs={overlaySrcMs}
                showAnnotations={false}
              />
            )}
            {frame && phase === 'body' && children?.({ width: frame.width, height: frame.height })}
          </div>
        )}
        {playable && !started && !checking && (
          <button
            type='button'
            aria-label='Play'
            onClick={togglePlay}
            className='absolute left-1/2 top-1/2 inline-flex h-14 w-14 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-[#0b0f17]/70 text-white transition-[background-color,transform] duration-150 hover:scale-105 hover:bg-[#0b0f17]/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan focus-visible:ring-offset-2 focus-visible:ring-offset-[#0b0f17] motion-reduce:transition-none motion-reduce:hover:scale-100'
            data-hv-big-play
          >
            <Play className='ml-0.5 h-6 w-6 fill-current' />
          </button>
        )}
        {status === 'processing' && (
          <StatePanel
            role='status'
            icon={<Hourglass className='h-5 w-5' />}
            tint='bg-slate-200/70 text-slate-600 dark:bg-white/10 dark:text-muted-foreground'
            title='This video is still being prepared.'
            body='Try again in a few minutes.'
            data='processing'
            action={
              <button
                type='button'
                onClick={() => void retry()}
                disabled={checking}
                className='inline-flex h-8 items-center rounded-md border border-slate-200 bg-white px-3 text-[12.5px] font-medium text-slate-700 transition-colors duration-150 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan disabled:opacity-50 motion-reduce:transition-none dark:border-border dark:bg-card dark:text-foreground dark:hover:bg-white/5'
                data-hv-check-again
              >
                {checking ? 'Checking…' : 'Check again'}
              </button>
            }
          />
        )}
        {status === 'error' && (
          <StatePanel
            role='alert'
            icon={<VideoOff className='h-5 w-5' />}
            tint='bg-red-100 text-red-600 dark:bg-red-500/15 dark:text-red-400'
            title='This video didn’t load.'
            body='The connection may have dropped, or its link expired. Retrying usually fixes it.'
            data='error'
            action={
              <button
                type='button'
                onClick={() => void retry()}
                disabled={checking}
                className='inline-flex h-8 items-center gap-1.5 rounded-md bg-nvr-cyan px-3 text-[12.5px] font-semibold text-nvr-navy transition-colors duration-150 hover:bg-nvr-cyan-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan focus-visible:ring-offset-2 focus-visible:ring-offset-slate-50 disabled:opacity-50 motion-reduce:transition-none dark:focus-visible:ring-offset-background'
                data-hv-retry
              >
                <RotateCw
                  className={`h-3.5 w-3.5 ${checking ? 'animate-spin motion-reduce:animate-none' : ''}`}
                />
                {checking ? 'Retrying…' : 'Retry'}
              </button>
            }
          />
        )}
        {status === 'unavailable' && (
          <StatePanel
            role='status'
            icon={<VideoOff className='h-5 w-5' />}
            tint='bg-slate-200/70 text-slate-600 dark:bg-white/10 dark:text-muted-foreground'
            title='This recording is not available yet.'
            data='unavailable'
          />
        )}
      </div>
      {playable && (
        <div className='flex shrink-0 flex-col gap-0.5 border-t border-slate-200 px-2 pb-1.5 pt-1 dark:border-border'>
          <div className='group relative flex h-5 items-center'>
            <input
              type='range'
              min={0}
              max={Math.max(1, totalMs)}
              step={100}
              value={Math.min(editedMs, totalMs)}
              onChange={(e) => seekEdited(Number(e.target.value))}
              aria-label='Seek'
              aria-valuetext={`${fmt(editedMs)} of ${fmt(totalMs)}`}
              className='peer absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0'
              data-hv-scrubber
            />
            <div className='pointer-events-none relative h-1 w-full overflow-hidden rounded-full bg-slate-300 transition-transform duration-150 group-hover:scale-y-150 motion-reduce:transition-none dark:bg-white/15'>
              <div
                className='absolute inset-y-0 left-0 bg-nvr-cyan-dark dark:bg-nvr-cyan'
                style={{ width: `${pct}%` }}
              />
            </div>
            <div
              className='pointer-events-none absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-nvr-cyan-dark ring-2 ring-slate-700 peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-nvr-cyan-dark dark:bg-nvr-cyan dark:ring-card dark:peer-focus-visible:outline-nvr-cyan'
              style={{ left: `${pct}%` }}
            />
            {chapters.map((c) => (
              <button
                key={c.id}
                type='button'
                data-tip={c.title}
                aria-label={`Chapter: ${c.title}`}
                onClick={() => seekEdited(c.edited)}
                className='group/tick absolute top-0 z-20 flex h-5 w-3 -translate-x-1/2 items-center justify-center focus-visible:outline-none'
                style={{ left: `${totalMs ? (c.edited / totalMs) * 100 : 0}%` }}
                data-hv-chapter-tick={c.id}
              >
                <span className='h-2.5 w-[3px] rounded-full bg-white ring-1 ring-slate-500 group-hover/tick:ring-slate-800 group-focus-visible/tick:ring-2 group-focus-visible/tick:ring-nvr-cyan-dark dark:bg-card dark:ring-white/50 dark:group-hover/tick:ring-white/80 dark:group-focus-visible/tick:ring-nvr-cyan' />
              </button>
            ))}
          </div>
          <div className='flex items-center gap-1'>
            <button
              type='button'
              aria-label={isPlaying ? 'Pause' : 'Play'}
              className={`${iconButton} ${inkStrong}`}
              onClick={togglePlay}
              data-hv-play
            >
              {isPlaying ? (
                <Pause className='h-4 w-4 fill-current' />
              ) : (
                <Play className='h-4 w-4 fill-current' />
              )}
            </button>
            <span className='px-1 text-[12px] tabular-nums text-slate-600 dark:text-muted-foreground'>
              {fmt(editedMs)} / {fmt(totalMs)}
            </span>
            <span className='flex-1' />
            <SpeedButton value={userRate} onChange={setUserRate} />
            <button
              type='button'
              aria-pressed={captions}
              aria-label='Captions'
              data-tip={captions ? 'Hide captions (C)' : 'Show captions (C)'}
              onClick={() => setCaptions((x) => !x)}
              className={`${iconButton} ${captions ? `bg-slate-100 dark:bg-white/10 ${inkStrong}` : inkMuted}`}
            >
              <Captions className='h-4 w-4' />
            </button>
            <button
              type='button'
              aria-label='Full screen'
              data-tip='Full screen (F)'
              onClick={fullscreen}
              className={`${iconButton} ${inkMuted}`}
            >
              <Maximize className='h-4 w-4' />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function StatePanel({
  role,
  icon,
  tint,
  title,
  body,
  action,
  data
}: {
  role: 'status' | 'alert'
  icon: ReactNode
  tint: string
  title: string
  body?: string
  action?: ReactNode
  data: 'processing' | 'error' | 'unavailable'
}) {
  return (
    <div
      role={role}
      className='nvr-rise-in absolute inset-0 flex flex-col items-center justify-center gap-2 overflow-y-auto p-6 text-center'
      data-hv-state={data}
      {...(data === 'unavailable' ? { 'data-hv-unavailable': '' } : {})}
      {...(data === 'processing' ? { 'data-hv-processing': '' } : {})}
      {...(data === 'error' ? { 'data-hv-error': '' } : {})}
    >
      <div className={`mb-1 flex h-10 w-10 items-center justify-center rounded-full ${tint}`}>
        {icon}
      </div>
      <p className='text-[14px] font-semibold text-slate-900 dark:text-foreground'>{title}</p>
      {body && (
        <p className='max-w-[42ch] text-[12.5px] leading-relaxed text-slate-600 dark:text-muted-foreground'>
          {body}
        </p>
      )}
      {action && <div className='mt-2'>{action}</div>}
    </div>
  )
}

function SpeedButton({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  return (
    <button
      type='button'
      aria-label={`Playback speed ${value}×`}
      data-tip='Playback speed'
      onClick={() => onChange(SPEEDS[(SPEEDS.indexOf(value) + 1) % SPEEDS.length])}
      className='h-8 min-w-[2.75rem] rounded-md px-1.5 text-[12px] font-medium tabular-nums text-slate-600 transition-colors duration-150 hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan motion-reduce:transition-none dark:text-muted-foreground dark:hover:bg-white/5 dark:hover:text-foreground'
      data-hv-speed
    >
      {value}×
    </button>
  )
}
