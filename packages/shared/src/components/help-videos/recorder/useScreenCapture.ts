import { useEffect, useRef, useState } from 'react'
import type { RecordedClick } from '../api'
import {
  POINTER_LIMITS,
  POINTER_SAMPLE_MS,
  pointerMoved,
  pointerSample,
  shortcutFromKey,
  thinPointerPath
} from '../pointer'
import type { Point, PointerPath, PointerSample, RecordedShortcut } from '../types'
import { currentHelpVideoPage } from '../walk/store'
import { describeClickTarget } from '../walk/target'
import {
  type ActivitySpan,
  createActivityTracker,
  isMaskedTarget,
  isTypingTarget
} from './activity'

export const WARN_MS = 25 * 60_000
/** From here the bar counts down the time that is left. */
export const LAST_MINUTE_MS = 29 * 60_000
export const MAX_MS = 30 * 60_000
/** One microphone level every 100 ms of recording time (10 per second). */
export const LEVEL_SAMPLE_MS = 100
const MIME_CANDIDATES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
  'video/mp4'
]

export type Source = 'tab' | 'window' | 'screen'

/** What the recorder sends with finalize (see `helpVideoApi().finalizeUpload`). */
export type CaptureMeta = {
  duration_ms: number
  clicks: RecordedClick[] | null
  levels: number[] | null
  /** Typing / idle spans on this tab (#1518); null when click capture was off. */
  activity?: ActivitySpan[] | null
  /** The pointer path and shortcuts on this tab (#1517); null when click
   *  capture was off. */
  pointer?: PointerPath | null
}

type Refs = {
  display?: MediaStream
  mic?: MediaStream
  ctx?: AudioContext
  analyser?: AnalyserNode
  stream?: MediaStream
  recorder?: MediaRecorder
  live: boolean
  /** Click capture is on for this recording (this tab only). */
  clickCapture: boolean
  cancelled: boolean
  warned: boolean
  startedAt: number
  pausedAt: number | null
  pausedTotal: number
  clicks: RecordedClick[]
  levels: number[]
  /** Typing and idle stretches (#1518), on this tab only, like clicks. */
  activity: ReturnType<typeof createActivityTracker>
  /** The pointer path (#1517): where it is now, the last sample taken, the
   *  samples so far, and the shortcuts pressed. This tab only, like clicks. */
  pointerNow: Point | null
  pointerSampled: Point | null
  pointer: PointerSample[]
  shortcuts: RecordedShortcut[]
  timers: number[]
}

const fresh = (): Refs => ({
  activity: createActivityTracker(),
  live: false,
  clickCapture: false,
  cancelled: false,
  warned: false,
  startedAt: 0,
  pausedAt: null,
  pausedTotal: 0,
  clicks: [],
  levels: [],
  pointerNow: null,
  pointerSampled: null,
  pointer: [],
  shortcuts: [],
  timers: []
})

/**
 * Screen + microphone capture for the recorder: the share prompt, the audio
 * mix, the MediaRecorder, the countdown, pause/mute, click capture and the
 * microphone level curve. It knows nothing about uploads: every recorded
 * chunk goes to the `onChunk` given to `arm`.
 */
export function useScreenCapture(events: {
  /** The 30:00 limit was reached. */
  onLimit: () => void
  /** The person used the browser's own "Stop sharing" button. */
  onSharingEnded: () => void
}) {
  const ev = useRef(events)
  ev.current = events
  const [count, setCount] = useState(3)
  const [elapsed, setElapsed] = useState(0)
  const [paused, setPaused] = useState(false)
  const [muted, setMuted] = useState(false)
  const [hasMic, setHasMic] = useState(false)
  const [micMissing, setMicMissing] = useState(false)
  const [announce, setAnnounce] = useState('')
  const r = useRef<Refs>(fresh())

  const elapsedMs = () => {
    const s = r.current
    if (!s.startedAt) return 0
    const now = s.pausedAt ?? performance.now()
    return Math.max(0, now - s.startedAt - s.pausedTotal)
  }

  // One stable listener so removeEventListener always finds it. x and y are
  // fractions of the captured frame (this tab's viewport).
  const onPointer = useRef((e: PointerEvent) => {
    if ((e.target as Element | null)?.closest?.('[data-hv-recorder-bar]')) return
    const s = r.current
    if (!s.live || s.pausedAt) return
    const at = s.startedAt
      ? Math.max(0, (s.pausedAt ?? performance.now()) - s.startedAt - s.pausedTotal)
      : 0
    s.clicks.push({
      t_ms: Math.round(at),
      x: Math.round(Math.min(1, Math.max(0, e.clientX / window.innerWidth)) * 10_000) / 10_000,
      y: Math.round(Math.min(1, Math.max(0, e.clientY / window.innerHeight)) * 10_000) / 10_000,
      // What was clicked (this tab only: the listener only runs on it). Never
      // a value or typed text; nothing inside .nvr-no-record.
      ...describeClickTarget(e.target, {
        pageKey: currentHelpVideoPage(),
        path: window.location.pathname,
        origin: window.location.origin
      })
    })
  }).current

  // Typing and idle stretches (#1518): any pointer, wheel or key input marks
  // the moment; a key into a text field is typing. Never the key itself —
  // except a shortcut (#1517: a modifier combo, Enter, Escape, Tab, an
  // arrow), kept with its moment unless pressed inside a masked area. The
  // pointer's place is noted here and sampled by the timer below.
  const onActivity = useRef((e: Event) => {
    const s = r.current
    if (!s.live || s.pausedAt || !s.startedAt) return
    const at = Math.round(Math.max(0, performance.now() - s.startedAt - s.pausedTotal))
    if (e.type === 'keydown') {
      const k = e as KeyboardEvent
      s.activity.key(at, isTypingTarget(k.target))
      const keys = isMaskedTarget(k.target) ? null : shortcutFromKey(k)
      if (keys && s.shortcuts.length < POINTER_LIMITS.shortcuts)
        s.shortcuts.push({ t_ms: at, keys })
    } else {
      s.activity.input(at)
      if (e.type === 'pointermove' || e.type === 'pointerdown') {
        const p = e as PointerEvent
        s.pointerNow = {
          x: Math.min(1, Math.max(0, p.clientX / window.innerWidth)),
          y: Math.min(1, Math.max(0, p.clientY / window.innerHeight))
        }
      }
    }
  }).current
  const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'wheel', 'keydown'] as const

  /** Stops every track, timer and listener. */
  const release = useRef(() => {
    const s = r.current
    for (const t of s.timers) window.clearInterval(t)
    s.timers = []
    for (const st of [s.display, s.mic]) for (const t of st?.getTracks() ?? []) t.stop()
    void s.ctx?.close().catch(() => null)
    s.ctx = undefined
    s.analyser = undefined
    window.removeEventListener('pointerdown', onPointer, true)
    for (const ev of ACTIVITY_EVENTS) window.removeEventListener(ev, onActivity, true)
  }).current

  useEffect(() => () => release(), [release])

  /** Clears the previous recording's state. */
  function reset() {
    r.current = fresh()
    setMicMissing(false)
    setHasMic(false)
    setPaused(false)
    setMuted(false)
    setElapsed(0)
  }

  /** Asks for the screen (and microphone) and mixes the audio. Returns the
   *  MediaRecorder mime to use. Throws when sharing is refused. */
  async function acquire(o: { source: Source; useMic: boolean; micId: string }): Promise<string> {
    const s = r.current
    // Created inside the click, before the share prompt: Chrome may start an
    // AudioContext made later (once the click's activation has lapsed)
    // suspended, and a suspended mix records silence.
    const ctx = new AudioContext()
    s.ctx = ctx
    void ctx.resume().catch(() => null)
    const display = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: 30,
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        displaySurface:
          o.source === 'tab' ? 'browser' : o.source === 'window' ? 'window' : 'monitor'
      },
      audio: true,
      // Chrome-only hints; harmless elsewhere.
      ...({
        preferCurrentTab: o.source === 'tab',
        selfBrowserSurface: 'include',
        surfaceSwitching: 'exclude'
      } as object)
    } as DisplayMediaStreamOptions)
    s.display = display
    const dest = ctx.createMediaStreamDestination()
    let hasAudio = false
    if (display.getAudioTracks().length) {
      ctx.createMediaStreamSource(new MediaStream(display.getAudioTracks())).connect(dest)
      hasAudio = true
    }
    if (o.useMic) {
      try {
        s.mic = await navigator.mediaDevices.getUserMedia({
          audio: o.micId === 'default' ? true : { deviceId: { exact: o.micId } }
        })
        const src = ctx.createMediaStreamSource(s.mic)
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 512
        src.connect(analyser)
        src.connect(dest)
        s.analyser = analyser
        hasAudio = true
        setHasMic(true)
      } catch {
        setMicMissing(true)
      }
    }
    s.stream = new MediaStream([
      ...display.getVideoTracks(),
      ...(hasAudio ? dest.stream.getAudioTracks() : [])
    ])
    return MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) ?? 'video/webm'
  }

  /** Builds the MediaRecorder; each chunk (every five seconds) goes to `onChunk`. */
  function arm(mime: string, onChunk: (blob: Blob) => void) {
    const s = r.current
    const recorder = new MediaRecorder(s.stream as MediaStream, {
      mimeType: mime,
      videoBitsPerSecond: 2_500_000
    })
    s.recorder = recorder
    recorder.ondataavailable = (e) => onChunk(e.data)
    // The browser's own "Stop sharing" button.
    s.display?.getVideoTracks()[0]?.addEventListener('ended', () => ev.current.onSharingEnded())
  }

  /** 3, 2, 1. False when cancelled meanwhile. */
  async function countdown(): Promise<boolean> {
    for (let i = 3; i > 0; i--) {
      setCount(i)
      await new Promise((res) => setTimeout(res, 1000))
      if (r.current.cancelled) return false
    }
    return true
  }

  /** Starts recording, the clock, the level sampler and (on this tab) click capture. */
  function begin(captureClicks: boolean) {
    const s = r.current
    s.startedAt = performance.now()
    s.recorder?.start(5000)
    s.live = true
    const surface = s.display?.getVideoTracks()[0]?.getSettings().displaySurface
    if (captureClicks && surface === 'browser') {
      s.clickCapture = true
      window.addEventListener('pointerdown', onPointer, true)
      for (const ev of ACTIVITY_EVENTS)
        window.addEventListener(ev, onActivity, { capture: true, passive: true })
    }
    s.timers.push(
      window.setInterval(() => {
        const ms = elapsedMs()
        setElapsed(ms)
        if (ms >= LAST_MINUTE_MS && !s.warned) {
          s.warned = true
          setAnnounce('One minute of recording is left.')
        }
        if (ms >= MAX_MS) ev.current.onLimit()
      }, 250),
      window.setInterval(() => {
        if (!s.analyser || s.pausedAt || !s.live) return
        const buf = new Uint8Array(s.analyser.fftSize)
        s.analyser.getByteTimeDomainData(buf)
        let sum = 0
        for (const v of buf) sum += ((v - 128) / 128) ** 2
        const level = Math.round(Math.min(1, Math.sqrt(sum / buf.length) * 3) * 100) / 100
        // Indexed by recording time so a late timer never shifts the curve.
        const at = Math.floor(elapsedMs() / LEVEL_SAMPLE_MS)
        while (s.levels.length < at) s.levels.push(s.levels[s.levels.length - 1] ?? 0)
        s.levels[at] = level
      }, LEVEL_SAMPLE_MS),
      // The pointer path (#1517): ~20 samples a second, only while it moves;
      // past twice the cap the path is thinned in place, so memory is bounded.
      window.setInterval(() => {
        if (!s.clickCapture || !s.live || s.pausedAt) return
        const now = s.pointerNow
        if (!now || !pointerMoved(s.pointerSampled, now)) return
        s.pointerSampled = now
        s.pointer.push(pointerSample(elapsedMs(), now.x, now.y))
        if (s.pointer.length >= POINTER_LIMITS.samples * 2)
          s.pointer = thinPointerPath(s.pointer, POINTER_LIMITS.samples)
      }, POINTER_SAMPLE_MS)
    )
    setAnnounce('Recording.')
  }

  /** The recording's data so far (call before `halt`). `clicks` is null when
   *  click capture was off, [] when it was on and caught nothing. */
  function meta(): CaptureMeta {
    const s = r.current
    return {
      duration_ms: Math.min(MAX_MS, Math.round(elapsedMs())),
      clicks: s.clickCapture ? s.clicks : null,
      levels: s.levels.length ? s.levels : null,
      activity: s.clickCapture ? s.activity.spans(Math.round(elapsedMs())) : null,
      pointer: s.clickCapture
        ? { samples: thinPointerPath(s.pointer), shortcuts: s.shortcuts.slice() }
        : null
    }
  }

  /** Stops capture and waits for the recorder's last chunk. */
  async function halt() {
    const s = r.current
    s.live = false
    const rec = s.recorder
    if (rec && rec.state !== 'inactive') {
      await new Promise<void>((res) => {
        rec.addEventListener('stop', () => res(), { once: true })
        rec.stop()
      })
    }
    release()
  }

  /** Cancels during the countdown. False when there is nothing to cancel. */
  function cancel(): boolean {
    const s = r.current
    if (s.live || s.cancelled) return false
    s.cancelled = true
    release()
    return true
  }

  function togglePause() {
    const s = r.current
    if (!s.recorder || !s.live) return
    if (s.pausedAt) {
      s.pausedTotal += performance.now() - s.pausedAt
      s.pausedAt = null
      s.recorder.resume()
      setPaused(false)
      setAnnounce('Recording again.')
    } else {
      s.pausedAt = performance.now()
      s.recorder.pause()
      setPaused(true)
      setAnnounce('Paused.')
    }
  }

  function toggleMute() {
    for (const t of r.current.mic?.getAudioTracks() ?? []) t.enabled = muted
    setAnnounce(muted ? 'Microphone on.' : 'Microphone muted.')
    setMuted((m) => !m)
  }

  return {
    count,
    elapsed,
    paused,
    muted,
    hasMic,
    micMissing,
    announce,
    /** True between `begin` and `halt`. */
    isLive: () => r.current.live,
    reset,
    acquire,
    arm,
    countdown,
    begin,
    meta,
    halt,
    cancel,
    release,
    togglePause,
    toggleMute
  }
}
