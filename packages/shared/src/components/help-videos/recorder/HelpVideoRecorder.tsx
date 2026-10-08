import {
  AppWindow,
  CircleCheck,
  History,
  Loader2,
  Mic,
  MicOff,
  Monitor,
  MonitorX,
  PanelTop,
  Pause,
  Play,
  Square,
  TriangleAlert
} from 'lucide-react'
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useApiFetchConfig, useNivaroClient } from '../../../context'
import { Button } from '../../ui/button'
import { Checkbox } from '../../ui/checkbox'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../../ui/dialog'
import { Label } from '../../ui/label'
import { modalHostOf } from '../../ui/popover'
import { SimpleSelect } from '../../ui/SimpleSelect'
import { fetchHelpVideo, helpVideoApi, type RecordedClick } from '../api'
import type { HelpVideoContext, HelpVideoDto } from '../types'
import { idbPartStore, isFatalStatus, PartUploader } from './partQueue'

const WARN_MS = 25 * 60_000
/** From here the bar counts down the time that is left. */
const LAST_MINUTE_MS = 29 * 60_000
const MAX_MS = 30 * 60_000
/** One microphone level every 100 ms of recording time (10 per second). */
const LEVEL_SAMPLE_MS = 100
const MIME_CANDIDATES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
  'video/mp4'
]
const LIMIT_SENTENCE =
  'Recordings can be up to 30 minutes, so recording stopped at 30:00 and everything you recorded was saved.'

type Stage = 'setup' | 'countdown' | 'recording' | 'saving' | 'error' | 'limit'
type Source = 'tab' | 'window' | 'screen'
type Leftover = { id: string; created_at: string; bytes: number }
type Failure = { message: string; retryable: boolean; uploadId: string }
type FinalizeMeta = { duration_ms: number; clicks: RecordedClick[] | null; levels: number[] | null }

const SOURCES: Array<{ id: Source; label: string; hint: string; icon: ReactNode }> = [
  { id: 'tab', label: 'This tab', hint: 'Recommended', icon: <PanelTop className='h-4 w-4' /> },
  { id: 'window', label: 'A window', hint: 'Any app', icon: <AppWindow className='h-4 w-4' /> },
  { id: 'screen', label: 'Whole screen', hint: 'Everything', icon: <Monitor className='h-4 w-4' /> }
]
const SOURCE_NOTES: Record<Source, string> = {
  tab: 'The recording bar sits in the bottom-left corner of the video. You can blur it in the editor.',
  window: 'Your browser will ask which window to share.',
  screen: 'Your browser will ask which screen to share. Close anything private first.'
}

export function canRecord(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getDisplayMedia &&
    typeof MediaRecorder !== 'undefined'
  )
}

/** Shown on Record buttons a browser cannot honour (phones, tablets, old browsers). */
export const RECORD_UNSUPPORTED = 'Recording needs a desktop browser that can share the screen'

/** m:ss from whole seconds. */
function clock(totalSeconds: number): string {
  const s = Math.max(0, totalSeconds)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function sizeLabel(bytes: number): string {
  const mb = bytes / 1_048_576
  if (mb < 1) return 'less than 1 MB'
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`
  return `${Math.round(mb)} MB`
}

function sentence(text: string): string {
  const t = text.trim()
  return /[.!?]$/.test(t) ? t : `${t}.`
}

/** A refusal's plain sentence. Errors thrown by a service arrive in Fastify's
 *  shape (`error` is the HTTP reason, e.g. "Conflict"; the sentence is in
 *  `message`); a route's own reply carries the sentence in `error`. */
function serverMessage(body: { error?: unknown; message?: unknown }): string | undefined {
  if (typeof body.message === 'string' && body.message.trim()) return body.message
  if (typeof body.error === 'string' && body.error.trim()) return body.error
  return undefined
}

/** The server's own plain message for a refusal (never a raw code), and
 *  whether trying again could help. No status means the request never got
 *  an answer: the network or the server is down. */
function plainFailure(err: unknown): { message: string; retryable: boolean } {
  const e = (err ?? {}) as {
    message?: unknown
    status?: unknown
    code?: unknown
    response?: { code?: unknown; error?: unknown; message?: unknown }
  }
  const status = typeof e.status === 'number' ? e.status : undefined
  if (status === undefined) {
    return { message: 'The server could not be reached.', retryable: true }
  }
  const code =
    typeof e.code === 'string'
      ? e.code
      : typeof e.response?.code === 'string'
        ? e.response.code
        : undefined
  const text = (e.response && serverMessage(e.response)) ?? e.message
  const message =
    typeof text === 'string' && text.trim()
      ? sentence(text)
      : 'The server did not accept the recording.'
  return { message, retryable: !isFatalStatus(status, code) }
}

/**
 * Records this tab, a window or the whole screen with optional microphone
 * narration. Parts upload every five seconds and are kept in this browser
 * (IndexedDB) until the server confirms each one, so an outage or a closed
 * tab loses nothing: a refused or interrupted recording stays in the browser
 * until the person keeps or discards it. Recording stops by itself at 30:00.
 *
 * During recording only a small control bar shows. It portals into the
 * hosting [role="dialog"] when the recorder sits inside one (a modal sheet
 * makes everything outside it unclickable), else into document.body.
 */
export function HelpVideoRecorder({
  open,
  onClose,
  onDone,
  videoId,
  contexts,
  defaultTitle
}: {
  open: boolean
  onClose: () => void
  onDone: (video: HelpVideoDto) => void
  videoId?: string
  contexts?: HelpVideoContext[]
  defaultTitle?: string
}) {
  const client = useNivaroClient()
  const api = helpVideoApi(client)
  const { apiBase, authHeaders, credentials } = useApiFetchConfig()
  const [supported] = useState(canRecord)
  const [stage, setStage] = useState<Stage>('setup')
  const [source, setSource] = useState<Source>('tab')
  const [mics, setMics] = useState<MediaDeviceInfo[]>([])
  const [micId, setMicId] = useState<string>('default')
  const [useMic, setUseMic] = useState(true)
  const [captureClicks, setCaptureClicks] = useState(true)
  const [count, setCount] = useState(3)
  const [elapsed, setElapsed] = useState(0)
  const [paused, setPaused] = useState(false)
  const [muted, setMuted] = useState(false)
  const [hasMic, setHasMic] = useState(false)
  const [micMissing, setMicMissing] = useState(false)
  const [setupError, setSetupError] = useState<string | null>(null)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [leftovers, setLeftovers] = useState<Leftover[]>([])
  const [busyLeftover, setBusyLeftover] = useState<string | null>(null)
  const [confirmDiscard, setConfirmDiscard] = useState<string | null>(null)
  const [upload, setUpload] = useState({ pending: 0, retrying: false })
  const [savePhase, setSavePhase] = useState<'upload' | 'finish'>('upload')
  const [autoStopped, setAutoStopped] = useState(false)
  const [limitVideo, setLimitVideo] = useState<HelpVideoDto | null>(null)
  const [announce, setAnnounce] = useState('')
  const ids = useId()

  // Where the recording bar portals: the hosting [role="dialog"] when the
  // recorder was opened inside one (a drill sheet's modal lock makes anything
  // under document.body unclickable), else document.body. Same rule as popovers.
  const [marker, setMarker] = useState<HTMLSpanElement | null>(null)
  const barHost =
    (marker ? modalHostOf(marker) : undefined) ??
    (typeof document !== 'undefined' ? document.body : null)

  // Latest props for callbacks that outlive a render (timers, track events).
  const props = useRef({ onDone, videoId, contexts, defaultTitle })
  props.current = { onDone, videoId, contexts, defaultTitle }

  const r = useRef<{
    display?: MediaStream
    mic?: MediaStream
    ctx?: AudioContext
    analyser?: AnalyserNode
    recorder?: MediaRecorder
    uploader?: PartUploader
    uploadId?: string
    live: boolean
    cancelled: boolean
    failed: boolean
    warned: boolean
    startedAt: number
    pausedAt: number | null
    pausedTotal: number
    clicks: RecordedClick[]
    levels: number[]
    meta: FinalizeMeta | null
    finalized: Set<string>
    timers: number[]
  }>({
    live: false,
    cancelled: false,
    failed: false,
    warned: false,
    startedAt: 0,
    pausedAt: null,
    pausedTotal: 0,
    clicks: [],
    levels: [],
    meta: null,
    finalized: new Set(),
    timers: []
  })

  const elapsedMs = () => {
    const s = r.current
    if (!s.startedAt) return 0
    const now = s.pausedAt ?? performance.now()
    return Math.max(0, now - s.startedAt - s.pausedTotal)
  }

  // A fresh start every time the recorder opens (unless a recording is live).
  useEffect(() => {
    if (!open || r.current.live) return
    setStage('setup')
    setFailure(null)
    setSetupError(null)
    setLimitVideo(null)
    setConfirmDiscard(null)
    setElapsed(0)
    setPaused(false)
    setMuted(false)
  }, [open])

  // Microphone list and interrupted recordings, read when the setup panel shows.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `api` is a new object every render; the lists are read once per setup stage
  useEffect(() => {
    if (!open || stage !== 'setup' || !supported) return
    let stop = false
    void navigator.mediaDevices
      .enumerateDevices()
      .then((d) => !stop && setMics(d.filter((x) => x.kind === 'audioinput')))
      .catch(() => null)
    void api
      .myUploads()
      .then(async (list) => {
        const store = idbPartStore()
        const rows: Leftover[] = []
        for (const u of list) {
          const local = await store.list(u.id).catch(() => [])
          const kept = local.filter((p) => p.n >= u.next_part)
          rows.push({
            id: u.id,
            created_at: u.created_at,
            bytes: u.bytes_received + kept.reduce((sum, p) => sum + p.blob.size, 0)
          })
        }
        if (!stop) setLeftovers(rows)
      })
      .catch(() => null)
    return () => {
      stop = true
    }
  }, [open, stage, supported])

  // Leaving the page mid-recording would drop the parts not yet in the browser.
  useEffect(() => {
    if (stage !== 'countdown' && stage !== 'recording' && stage !== 'saving') return
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [stage])

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
      y: Math.round(Math.min(1, Math.max(0, e.clientY / window.innerHeight)) * 10_000) / 10_000
    })
  }).current

  const cleanup = useRef(() => {
    const s = r.current
    for (const t of s.timers) window.clearInterval(t)
    s.timers = []
    for (const st of [s.display, s.mic]) for (const t of st?.getTracks() ?? []) t.stop()
    void s.ctx?.close().catch(() => null)
    s.ctx = undefined
    s.analyser = undefined
    window.removeEventListener('pointerdown', onPointer, true)
  }).current

  useEffect(() => () => cleanup(), [cleanup])

  async function sendPart(uploadId: string, n: number, blob: Blob) {
    const res = await fetch(`${apiBase}/help-videos/uploads/${uploadId}/parts/${n}`, {
      method: 'PUT',
      credentials,
      headers: { 'Content-Type': 'application/octet-stream', ...authHeaders },
      body: blob
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as {
        error?: string
        message?: string
        code?: string
      }
      throw Object.assign(
        new Error(serverMessage(body) ?? 'The server did not accept part of the recording'),
        { status: res.status, code: body.code }
      )
    }
  }

  function newUploader(uploadId: string, startAt = 0) {
    return new PartUploader({
      uploadId,
      store: idbPartStore(),
      startAt,
      send: (n, blob) => sendPart(uploadId, n, blob),
      onChange: setUpload
    })
  }

  /** Stops capture and waits for the recorder's last part. */
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
    cleanup()
  }

  async function start() {
    setSetupError(null)
    setMicMissing(false)
    setHasMic(false)
    setAutoStopped(false)
    setPaused(false)
    setMuted(false)
    setElapsed(0)
    setUpload({ pending: 0, retrying: false })
    const s = r.current
    Object.assign(s, {
      cancelled: false,
      failed: false,
      warned: false,
      startedAt: 0,
      pausedAt: null,
      pausedTotal: 0,
      clicks: [],
      levels: [],
      meta: null,
      uploadId: undefined,
      recorder: undefined,
      mic: undefined
    })
    try {
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
          displaySurface: source === 'tab' ? 'browser' : source === 'window' ? 'window' : 'monitor'
        },
        audio: true,
        // Chrome-only hints; harmless elsewhere.
        ...({
          preferCurrentTab: source === 'tab',
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
      if (useMic) {
        try {
          s.mic = await navigator.mediaDevices.getUserMedia({
            audio: micId === 'default' ? true : { deviceId: { exact: micId } }
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
      const tracks = [
        ...display.getVideoTracks(),
        ...(hasAudio ? dest.stream.getAudioTracks() : [])
      ]
      const mime = MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) ?? 'video/webm'
      const opened = await api.openUpload(mime.split(';')[0])
      s.uploadId = opened.id
      const uploader = newUploader(opened.id)
      s.uploader = uploader
      const recorder = new MediaRecorder(new MediaStream(tracks), {
        mimeType: mime,
        videoBitsPerSecond: 2_500_000
      })
      s.recorder = recorder
      recorder.ondataavailable = (e) => {
        uploader.enqueue(e.data)
        // A refusal mid-recording stops it at once; the parts stay in the browser.
        void uploader.drain().catch((err) => void failWhileRecording(err))
      }
      // The browser's own "Stop sharing" button.
      display.getVideoTracks()[0]?.addEventListener('ended', () => {
        if (r.current.live) void stop()
        else void cancelCountdown()
      })

      setStage('countdown')
      for (let i = 3; i > 0; i--) {
        setCount(i)
        await new Promise((res) => setTimeout(res, 1000))
        if (s.cancelled) return
      }
      s.startedAt = performance.now()
      recorder.start(5000)
      s.live = true
      const surface = display.getVideoTracks()[0]?.getSettings().displaySurface
      if (captureClicks && source === 'tab' && surface === 'browser') {
        window.addEventListener('pointerdown', onPointer, true)
      }
      s.timers.push(
        window.setInterval(() => {
          const ms = elapsedMs()
          setElapsed(ms)
          if (ms >= LAST_MINUTE_MS && !s.warned) {
            s.warned = true
            setAnnounce('One minute of recording is left.')
          }
          if (ms >= MAX_MS) void stop(true)
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
        }, LEVEL_SAMPLE_MS)
      )
      setStage('recording')
      setAnnounce('Recording.')
    } catch (err) {
      cleanup()
      if (s.uploadId) {
        void api.abandonUpload(s.uploadId).catch(() => null)
        void idbPartStore().clear(s.uploadId)
      }
      setStage('setup')
      const name = (err as Error)?.name
      setSetupError(
        name === 'NotAllowedError'
          ? 'Screen sharing was not allowed. Choose a tab, window or screen when your browser asks, or allow screen sharing for this site in your browser settings.'
          : name === 'NotFoundError' || name === 'NotReadableError'
            ? 'Your browser could not capture the screen. Close other apps that share the screen and try again.'
            : plainFailure(err).message
      )
    }
  }

  async function cancelCountdown() {
    const s = r.current
    if (s.live || s.cancelled) return
    s.cancelled = true
    cleanup()
    if (s.uploadId) {
      const id = s.uploadId
      s.uploadId = undefined
      await api.abandonUpload(id).catch(() => null)
      await idbPartStore().clear(id)
    }
    setStage('setup')
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

  async function stop(auto = false) {
    const s = r.current
    if (!s.live) return
    const duration = Math.min(MAX_MS, Math.round(elapsedMs()))
    await halt()
    s.meta = {
      duration_ms: duration,
      clicks: s.clicks,
      levels: s.levels.length ? s.levels : null
    }
    setAutoStopped(auto)
    setSavePhase('upload')
    setStage('saving')
    await save(String(s.uploadId), s.uploader as PartUploader, s.meta, auto)
  }

  async function failWhileRecording(err: unknown) {
    const s = r.current
    if (!s.live || s.failed) return
    s.failed = true
    const duration = Math.round(elapsedMs())
    await halt()
    s.meta = { duration_ms: duration, clicks: s.clicks, levels: s.levels.length ? s.levels : null }
    setFailure({ ...plainFailure(err), uploadId: String(s.uploadId) })
    setStage('error')
  }

  async function finish(uploadId: string, meta: FinalizeMeta): Promise<HelpVideoDto> {
    const s = r.current
    if (!s.finalized.has(uploadId)) {
      await api.finalizeUpload(uploadId, meta)
      s.finalized.add(uploadId)
    }
    const p = props.current
    let video: HelpVideoDto
    if (p.videoId) {
      await api.rerecord(p.videoId, uploadId)
      video = await fetchHelpVideo(client, p.videoId)
    } else {
      video = await api.create({
        upload_id: uploadId,
        title: p.defaultTitle ?? '',
        contexts: p.contexts
      })
    }
    s.finalized.delete(uploadId)
    await idbPartStore().clear(uploadId)
    return video
  }

  async function save(uploadId: string, uploader: PartUploader, meta: FinalizeMeta, auto: boolean) {
    try {
      await uploader.drain()
      setSavePhase('finish')
      const video = await finish(uploadId, meta)
      if (auto) {
        setLimitVideo(video)
        setStage('limit')
      } else {
        props.current.onDone(video)
      }
    } catch (err) {
      setFailure({ ...plainFailure(err), uploadId })
      setStage('error')
    }
  }

  /** Re-sends what this browser kept for an upload, from the part the server expects next. */
  async function resumeUploader(uploadId: string): Promise<PartUploader> {
    const parts = await idbPartStore().list(uploadId)
    const nextServer = (await api.myUploads()).find((u) => u.id === uploadId)?.next_part ?? 0
    const up = newUploader(uploadId, nextServer)
    up.resume(parts.filter((p) => p.n >= nextServer))
    return up
  }

  async function retry() {
    if (!failure) return
    const id = failure.uploadId
    const meta = r.current.uploadId === id && r.current.meta ? r.current.meta : emptyMeta()
    setFailure(null)
    setSavePhase('upload')
    setStage('saving')
    try {
      await save(id, await resumeUploader(id), meta, false)
    } catch (err) {
      setFailure({ ...plainFailure(err), uploadId: id })
      setStage('error')
    }
  }

  async function keepLeftover(id: string) {
    setBusyLeftover(id)
    setAutoStopped(false)
    setSavePhase('upload')
    setStage('saving')
    try {
      await save(id, await resumeUploader(id), emptyMeta(), false)
    } catch (err) {
      setFailure({ ...plainFailure(err), uploadId: id })
      setStage('error')
    } finally {
      setBusyLeftover(null)
    }
  }

  async function discard(id: string) {
    setBusyLeftover(id)
    await api.abandonUpload(id).catch(() => null)
    await idbPartStore().clear(id)
    setLeftovers((l) => l.filter((x) => x.id !== id))
    setConfirmDiscard(null)
    setBusyLeftover(null)
  }

  if (!open) return null

  // ── The floating bar (countdown and recording) ────────────────────────────
  if (stage === 'recording' || stage === 'countdown') {
    if (!barHost) return null
    const remainingS = Math.ceil((MAX_MS - elapsed) / 1000)
    const lastMinute = elapsed >= LAST_MINUTE_MS
    return (
      <>
        {/* Marks where the recorder sits in the tree, for modalHostOf. */}
        <span ref={setMarker} hidden />
        {createPortal(
          <div
            data-hv-recorder-bar
            role='toolbar'
            aria-label='Recording controls'
            className='nvr-rise-in fixed bottom-4 left-4 z-[140] flex max-w-[calc(100vw-2rem)] flex-wrap items-center gap-x-1 gap-y-1 rounded-full bg-[#0b0f17] py-1 pl-3.5 pr-1 font-sans text-[12.5px] font-medium text-white shadow-[0_4px_16px_rgba(0,0,0,0.25),0_1px_4px_rgba(0,0,0,0.15)] ring-1 ring-white/15'
          >
            <span className='sr-only' aria-live='polite'>
              {announce}
            </span>
            {stage === 'countdown' ? (
              <>
                <span data-hv-countdown className='pr-2'>
                  Recording starts in <span className='tabular-nums font-semibold'>{count}</span>
                </span>
                <BarButton label='Cancel recording' onClick={() => void cancelCountdown()}>
                  Cancel
                </BarButton>
              </>
            ) : (
              <>
                <span
                  aria-hidden
                  className={`h-2.5 w-2.5 shrink-0 rounded-full ${
                    paused ? 'bg-slate-400' : 'animate-pulse bg-rose-500 motion-reduce:animate-none'
                  }`}
                />
                <span className='sr-only'>{paused ? 'Paused' : 'Recording'}</span>
                <span data-hv-timer className='ml-1 tabular-nums'>
                  {clock(Math.floor(elapsed / 1000))}
                </span>
                {lastMinute ? (
                  <span
                    data-hv-remaining
                    className='ml-1.5 rounded-full bg-amber-300 px-2 py-0.5 text-[11.5px] font-semibold tabular-nums text-amber-950'
                  >
                    {clock(remainingS)} left
                  </span>
                ) : elapsed >= WARN_MS ? (
                  <span className='ml-1.5 hidden text-white/70 sm:inline'>stops at 30:00</span>
                ) : null}
                {upload.retrying && (
                  <span className='ml-1.5 text-amber-300' data-hv-reconnecting>
                    Reconnecting…
                  </span>
                )}
                {micMissing && (
                  <span
                    className='ml-1.5 inline-flex text-white/70'
                    title='No microphone was available, so this recording has no narration'
                  >
                    <MicOff className='h-3.5 w-3.5' aria-hidden />
                    <span className='sr-only'>
                      No microphone was available, so this recording has no narration.
                    </span>
                  </span>
                )}
                <span aria-hidden className='mx-1.5 h-4 w-px bg-white/20' />
                <BarButton label={paused ? 'Resume' : 'Pause'} onClick={togglePause}>
                  {paused ? (
                    <Play className='h-3.5 w-3.5 fill-current' />
                  ) : (
                    <Pause className='h-3.5 w-3.5 fill-current' />
                  )}
                </BarButton>
                {hasMic && (
                  <BarButton
                    label={muted ? 'Unmute microphone' : 'Mute microphone'}
                    onClick={toggleMute}
                  >
                    {muted ? <MicOff className='h-3.5 w-3.5' /> : <Mic className='h-3.5 w-3.5' />}
                  </BarButton>
                )}
                <BarButton
                  label='Stop recording'
                  tone='stop'
                  onClick={() => void stop()}
                  data-hv-stop
                >
                  <Square className='h-3 w-3 fill-current' />
                  <span>Stop</span>
                </BarButton>
              </>
            )}
          </div>,
          barHost
        )}
      </>
    )
  }

  // ── The dialog (setup, saving, error, limit, unsupported) ─────────────────
  const title = videoId ? 'Re-record this video' : 'Record a tutorial'
  const saving = stage === 'saving'
  return (
    <>
      {/* Rendered in every stage so the bar's host is known before recording starts. */}
      <span ref={setMarker} hidden />
      <Dialog
        open
        onOpenChange={(o) => {
          if (o || saving) return
          // The video exists once the limit notice shows: closing still hands it over.
          if (stage === 'limit' && limitVideo) props.current.onDone(limitVideo)
          else onClose()
        }}
      >
        <DialogContent
          className={`w-[calc(100vw-2rem)] max-w-[520px] font-sans dark:bg-card ${
            saving ? '[&>button:last-child]:hidden' : ''
          }`}
          data-hv-recorder
          data-hv-stage={supported ? stage : 'unsupported'}
        >
          {!supported ? (
            <>
              <DialogHeader className='pr-12'>
                <DialogTitle className='text-[16px] dark:text-foreground'>{title}</DialogTitle>
                <DialogDescription className='sr-only'>{RECORD_UNSUPPORTED}</DialogDescription>
              </DialogHeader>
              <DialogBody>
                <div className='flex items-start gap-3' data-hv-unsupported>
                  <span className='flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-700 dark:bg-white/10 dark:text-foreground'>
                    <MonitorX className='h-4 w-4' />
                  </span>
                  <div className='text-[13px] leading-relaxed'>
                    <p className='font-medium text-slate-900 dark:text-foreground'>
                      {sentence(RECORD_UNSUPPORTED)}
                    </p>
                    <p className='mt-1 text-slate-600 dark:text-muted-foreground'>
                      Open this page on a computer in Chrome, Edge, Firefox or Safari to record a
                      tutorial.
                    </p>
                  </div>
                </div>
              </DialogBody>
              <DialogFooter className='dark:border-border'>
                <Button variant='outline' className={secondaryBtn} onClick={onClose}>
                  Close
                </Button>
              </DialogFooter>
            </>
          ) : stage === 'saving' ? (
            <>
              <DialogHeader className='pr-12'>
                <DialogTitle className='text-[16px] dark:text-foreground'>
                  Saving your recording
                </DialogTitle>
                <DialogDescription className='text-[13px] text-slate-600 dark:text-muted-foreground'>
                  Keep this page open until it finishes.
                </DialogDescription>
              </DialogHeader>
              <DialogBody className='space-y-3 text-[13px]'>
                {autoStopped && (
                  <p
                    className='rounded-lg border border-amber-300 bg-amber-50 px-3.5 py-2.5 text-amber-950 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-100'
                    data-hv-limit-note
                  >
                    {LIMIT_SENTENCE}
                  </p>
                )}
                <div
                  role='status'
                  className='flex items-start gap-3 rounded-lg bg-muted/70 px-3.5 py-3'
                  data-hv-saving
                >
                  <Loader2 className='mt-0.5 h-4 w-4 shrink-0 animate-spin text-slate-500 motion-reduce:animate-none dark:text-muted-foreground' />
                  <div>
                    <p className='font-medium text-slate-900 dark:text-foreground'>
                      {savePhase === 'finish'
                        ? 'Preparing the video'
                        : upload.pending > 1
                          ? `Uploading the last ${upload.pending} parts of your recording`
                          : 'Uploading the end of your recording'}
                    </p>
                    <p className='mt-0.5 text-slate-600 dark:text-muted-foreground'>
                      {upload.retrying && savePhase === 'upload'
                        ? 'The connection dropped, so it is trying again. Your recording is safe in this browser.'
                        : savePhase === 'finish'
                          ? 'This takes a few seconds for a long recording.'
                          : 'Every part is kept in this browser until the server has it.'}
                    </p>
                  </div>
                </div>
              </DialogBody>
            </>
          ) : stage === 'limit' ? (
            <>
              <DialogHeader className='pr-12'>
                <DialogTitle className='text-[16px] dark:text-foreground'>
                  Your recording is saved
                </DialogTitle>
                <DialogDescription className='sr-only'>{LIMIT_SENTENCE}</DialogDescription>
              </DialogHeader>
              <DialogBody>
                <div className='flex items-start gap-3 text-[13px]' data-hv-limit>
                  <CircleCheck className='mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400' />
                  <p className='leading-relaxed text-slate-700 dark:text-foreground'>
                    {LIMIT_SENTENCE}
                  </p>
                </div>
              </DialogBody>
              <DialogFooter className='dark:border-border'>
                <Button
                  className={primaryBtn}
                  onClick={() => limitVideo && props.current.onDone(limitVideo)}
                  data-hv-open-video
                >
                  Open the video
                </Button>
              </DialogFooter>
            </>
          ) : stage === 'error' && failure ? (
            <>
              <DialogHeader className='pr-12'>
                <DialogTitle className='text-[16px] dark:text-foreground'>
                  Your recording was not saved
                </DialogTitle>
                <DialogDescription className='text-[13px] text-slate-600 dark:text-muted-foreground'>
                  Everything you recorded is kept in this browser until you discard it.
                </DialogDescription>
              </DialogHeader>
              <DialogBody>
                <p
                  role='alert'
                  className='flex items-start gap-2.5 rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-[13px] text-rose-900 dark:border-rose-400/30 dark:bg-rose-400/10 dark:text-rose-100'
                  data-hv-error
                >
                  <TriangleAlert className='mt-0.5 h-4 w-4 shrink-0' />
                  <span>{failure.message}</span>
                </p>
                <p className='mt-3 text-[13px] text-slate-600 dark:text-muted-foreground'>
                  {failure.retryable
                    ? 'Try again now, or close this and use Record later to keep it.'
                    : 'Use Record later to keep what was saved so far, or discard it.'}
                </p>
              </DialogBody>
              <DialogFooter className='flex-wrap dark:border-border'>
                {confirmDiscard === failure.uploadId ? (
                  <div className='mr-auto flex flex-wrap items-center gap-2 text-[13px]'>
                    <span className='text-slate-700 dark:text-foreground'>
                      Discard it for good?
                    </span>
                    <Button
                      variant='ghost'
                      className={ghostBtn}
                      onClick={() => setConfirmDiscard(null)}
                    >
                      Keep it
                    </Button>
                    <Button
                      variant='destructive'
                      className={dangerBtn}
                      data-hv-discard-confirm
                      onClick={async () => {
                        await discard(failure.uploadId)
                        setFailure(null)
                        setStage('setup')
                      }}
                    >
                      Discard
                    </Button>
                  </div>
                ) : (
                  <>
                    <Button
                      variant='ghost'
                      className={`mr-auto ${ghostBtn} text-rose-700 hover:text-rose-800 dark:text-rose-300 dark:hover:text-rose-200`}
                      onClick={() => setConfirmDiscard(failure.uploadId)}
                      data-hv-discard
                    >
                      Discard recording
                    </Button>
                    <Button variant='outline' className={secondaryBtn} onClick={onClose}>
                      Close
                    </Button>
                    {failure.retryable && (
                      <Button className={primaryBtn} onClick={() => void retry()} data-hv-retry>
                        Try again
                      </Button>
                    )}
                  </>
                )}
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader className='pr-12'>
                <DialogTitle className='text-[16px] dark:text-foreground'>{title}</DialogTitle>
                <DialogDescription className='text-[13px] text-slate-600 dark:text-muted-foreground'>
                  {videoId
                    ? 'The new recording becomes a fresh draft. The published video stays as it is until you publish again.'
                    : 'Show how something works while you talk it through. You can trim, annotate and caption it afterwards.'}
                </DialogDescription>
              </DialogHeader>
              <DialogBody className='space-y-5 text-[13px]'>
                {leftovers.length > 0 && (
                  <section
                    aria-labelledby={`${ids}-left`}
                    className='rounded-lg border border-amber-300 bg-amber-50 px-3.5 py-3 dark:border-amber-400/30 dark:bg-amber-400/10'
                    data-hv-leftovers
                  >
                    <div className='flex items-start gap-2.5'>
                      <History className='mt-0.5 h-4 w-4 shrink-0 text-amber-700 dark:text-amber-300' />
                      <div className='min-w-0 flex-1'>
                        <p
                          id={`${ids}-left`}
                          className='font-medium text-amber-950 dark:text-amber-100'
                        >
                          {leftovers.length === 1
                            ? 'A recording was interrupted'
                            : `${leftovers.length} recordings were interrupted`}
                        </p>
                        <ul className='mt-2 space-y-2.5'>
                          {leftovers.map((l) => (
                            <li key={l.id} className='flex flex-col items-start gap-2'>
                              <span className='text-amber-900 dark:text-amber-200'>
                                Started{' '}
                                {new Date(l.created_at).toLocaleString(undefined, {
                                  month: 'short',
                                  day: 'numeric',
                                  hour: 'numeric',
                                  minute: '2-digit'
                                })}
                                , {sizeLabel(l.bytes)} saved so far.
                              </span>
                              {confirmDiscard === l.id ? (
                                <span className='flex items-center gap-1.5'>
                                  <Button
                                    size='sm'
                                    variant='ghost'
                                    className={leftoverGhost}
                                    onClick={() => setConfirmDiscard(null)}
                                  >
                                    Keep it
                                  </Button>
                                  <Button
                                    size='sm'
                                    variant='destructive'
                                    className={`${dangerBtn} h-8 px-3 text-[12.5px]`}
                                    disabled={busyLeftover === l.id}
                                    onClick={() => void discard(l.id)}
                                  >
                                    Discard for good
                                  </Button>
                                </span>
                              ) : (
                                <span className='flex items-center gap-1.5'>
                                  <Button
                                    size='sm'
                                    className={`h-8 text-[12.5px] ${primaryBtn}`}
                                    disabled={!!busyLeftover}
                                    onClick={() => void keepLeftover(l.id)}
                                    data-hv-keep
                                  >
                                    Keep what was recorded
                                  </Button>
                                  <Button
                                    size='sm'
                                    variant='ghost'
                                    className={leftoverGhost}
                                    disabled={!!busyLeftover}
                                    onClick={() => setConfirmDiscard(l.id)}
                                  >
                                    Discard
                                  </Button>
                                </span>
                              )}
                            </li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  </section>
                )}

                <fieldset>
                  <legend
                    id={`${ids}-src`}
                    className='mb-2 font-medium text-slate-900 dark:text-foreground'
                  >
                    What to record
                  </legend>
                  <SourcePicker value={source} onChange={setSource} labelledBy={`${ids}-src`} />
                  <p className='mt-2 text-[12.5px] text-slate-600 dark:text-muted-foreground'>
                    {SOURCE_NOTES[source]}
                  </p>
                </fieldset>

                <div className='space-y-3.5'>
                  <div className='flex items-start gap-2.5'>
                    <Checkbox
                      id={`${ids}-mic`}
                      checked={useMic}
                      onCheckedChange={(v) => setUseMic(v === true)}
                      className='mt-px'
                      data-hv-use-mic
                    />
                    <div className='min-w-0 flex-1'>
                      <Label
                        htmlFor={`${ids}-mic`}
                        className='text-[13px] leading-snug text-slate-900 dark:text-foreground'
                      >
                        Narrate with my microphone
                      </Label>
                      {useMic && (
                        <SimpleSelect
                          value={micId}
                          onChange={setMicId}
                          ariaLabel='Microphone'
                          className='mt-2 h-9 text-[13px]'
                          options={[
                            { value: 'default', label: 'Default microphone' },
                            ...mics
                              .filter((m) => m.deviceId && m.deviceId !== 'default')
                              .map((m) => ({ value: m.deviceId, label: m.label || 'Microphone' }))
                          ]}
                        />
                      )}
                    </div>
                  </div>
                  <div className='flex items-start gap-2.5'>
                    <Checkbox
                      id={`${ids}-clicks`}
                      checked={captureClicks && source === 'tab'}
                      disabled={source !== 'tab'}
                      onCheckedChange={(v) => setCaptureClicks(v === true)}
                      className='mt-px'
                    />
                    <div className='min-w-0 flex-1'>
                      <Label
                        htmlFor={`${ids}-clicks`}
                        className='text-[13px] leading-snug text-slate-900 dark:text-foreground'
                      >
                        Capture my clicks
                      </Label>
                      <p className='mt-1 text-[12.5px] text-slate-600 dark:text-muted-foreground'>
                        {source === 'tab'
                          ? 'The editor can turn them into click ripples.'
                          : 'Clicks can only be captured when you record this tab.'}
                      </p>
                    </div>
                  </div>
                </div>

                {setupError && (
                  <p
                    role='alert'
                    className='flex items-start gap-2.5 rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-rose-900 dark:border-rose-400/30 dark:bg-rose-400/10 dark:text-rose-100'
                    data-hv-setup-error
                  >
                    <TriangleAlert className='mt-0.5 h-4 w-4 shrink-0' />
                    <span>{setupError}</span>
                  </p>
                )}
              </DialogBody>
              <DialogFooter className='dark:border-border'>
                <Button variant='ghost' className={ghostBtn} onClick={onClose}>
                  Cancel
                </Button>
                <Button className={primaryBtn} onClick={() => void start()} data-hv-start>
                  Start recording
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

function emptyMeta(): FinalizeMeta {
  return { duration_ms: 0, clicks: null, levels: null }
}

const primaryBtn =
  'h-9 bg-nvr-cyan px-4 text-[13px] font-semibold text-nvr-navy hover:bg-nvr-cyan-dark focus-visible:ring-nvr-cyan dark:focus-visible:ring-offset-card'
// rose-600: white text clears 4.5:1 (the destructive token's red-500 does not).
const dangerBtn =
  'h-9 bg-rose-600 px-4 text-[13px] text-white hover:bg-rose-700 dark:focus-visible:ring-offset-card'
const secondaryBtn =
  'h-9 px-4 text-[13px] dark:border-border dark:bg-transparent dark:hover:bg-white/5 dark:focus-visible:ring-offset-card'
const ghostBtn =
  'h-9 px-3 text-[13px] text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-muted-foreground dark:hover:bg-white/5 dark:hover:text-foreground dark:focus-visible:ring-offset-card'
const leftoverGhost =
  'h-8 px-2.5 text-[12.5px] text-amber-900 hover:bg-amber-100 hover:text-amber-950 dark:text-amber-200 dark:hover:bg-amber-400/10 dark:hover:text-amber-100'

/** Tab / window / screen as a radio group: arrow keys move the choice. */
function SourcePicker({
  value,
  onChange,
  labelledBy
}: {
  value: Source
  onChange: (s: Source) => void
  labelledBy: string
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const step =
      e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? 1
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
          ? -1
          : 0
    if (!step) return
    e.preventDefault()
    const next = (i + step + SOURCES.length) % SOURCES.length
    onChange(SOURCES[next].id)
    refs.current[next]?.focus()
  }
  return (
    <div
      role='radiogroup'
      aria-labelledby={labelledBy}
      className='grid grid-cols-1 gap-2 sm:grid-cols-3'
    >
      {SOURCES.map((s, i) => {
        const on = value === s.id
        return (
          // biome-ignore lint/a11y/useSemanticElements: a segmented control — buttons in a radiogroup, not native radios
          <button
            key={s.id}
            ref={(el) => {
              refs.current[i] = el
            }}
            type='button'
            role='radio'
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(s.id)}
            onKeyDown={(e) => onKey(e, i)}
            data-hv-source={s.id}
            className={`flex min-w-0 items-center gap-3 rounded-lg border px-3 py-2.5 sm:flex-col sm:items-start sm:gap-1.5 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan motion-reduce:transition-none ${
              on
                ? 'border-nvr-cyan bg-nvr-cyan/10'
                : 'border-slate-200 hover:bg-slate-50 dark:border-border dark:hover:bg-white/5'
            }`}
          >
            <span
              className={
                on
                  ? 'text-slate-900 dark:text-foreground'
                  : 'text-slate-500 dark:text-muted-foreground'
              }
            >
              {s.icon}
            </span>
            <span className='flex min-w-0 flex-1 items-baseline gap-2 sm:block sm:w-full'>
              <span className='block truncate font-medium text-slate-900 dark:text-foreground'>
                {s.label}
              </span>
              <span className='block truncate text-[12px] text-slate-600 dark:text-muted-foreground'>
                {s.hint}
              </span>
            </span>
          </button>
        )
      })}
    </div>
  )
}

function BarButton({
  label,
  onClick,
  children,
  tone = 'plain',
  ...rest
}: {
  label: string
  onClick: () => void
  children: ReactNode
  tone?: 'plain' | 'stop'
} & Record<`data-${string}`, unknown>) {
  return (
    <button
      type='button'
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`inline-flex h-8 min-w-8 shrink-0 items-center justify-center gap-1.5 rounded-full px-2.5 text-white transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan motion-reduce:transition-none ${
        tone === 'stop' ? 'bg-rose-600 hover:bg-rose-500' : 'hover:bg-white/10'
      }`}
      {...rest}
    >
      {children}
    </button>
  )
}
