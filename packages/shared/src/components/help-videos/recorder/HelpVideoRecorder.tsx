import { useEffect, useRef, useState } from 'react'
import { useApiFetchConfig, useNivaroClient } from '../../../context'
import { Dialog, DialogContent } from '../../ui/dialog'
import { modalHostOf } from '../../ui/popover'
import { fetchHelpVideo, helpVideoApi } from '../api'
import type { HelpVideoContext, HelpVideoDto } from '../types'
import { readCleanPref, useCleanScreen, writeCleanPref } from './cleanRecording'
import { type Failure, plainFailure, stopsRecording } from './failure'
import { findLeftovers, type Leftover, planResume } from './leftovers'
import { idbPartStore, PartUploader, type UploadState } from './partQueue'
import { RecorderBar } from './RecorderBar'
import { DEFAULT_SETUP, type PopupFrame, RecorderSetup, type SetupOptions } from './RecorderSetup'
import {
  DoneView,
  ErrorView,
  LimitView,
  RemoteView,
  SavingView,
  UnsupportedView
} from './RecorderStatus'
import {
  fitWindowTo,
  forgetHandoff,
  isRecordingWindow,
  newToken,
  openChannel,
  POPUP_BLOCKED,
  popupFeatures,
  presetById,
  RECORDING_WINDOW_NAME,
  type RecordingHandoff,
  type RecordingMessage,
  type RemoteStage,
  type RemoteStatus,
  readWindowPref,
  recordingUrl,
  type Size,
  takeResult,
  writeHandoff,
  writeResult,
  writeWindowPref
} from './recordingWindow'
import { isNextStepKey, parseScript, scriptText } from './script'
import { partSender } from './sendPart'
import { useConnectedHost } from './useConnectedHost'
import { leaveWarningActive, useLeaveWarning } from './useLeaveWarning'
import { type CaptureMeta, useScreenCapture } from './useScreenCapture'

export { RECORD_UNSUPPORTED } from './RecorderStatus'

type Stage = 'setup' | 'countdown' | 'recording' | 'saving' | 'error' | 'limit' | 'done' | 'remote'

/** Attempts per part once recording has stopped (live parts retry without limit). */
const SAVE_ATTEMPTS = 12
/** How often the opener checks whether its recording window is still there. */
const WINDOW_POLL_MS = 1000
/** How long the popup gives window.close() before falling back to the page. */
const CLOSE_GRACE_MS = 400

export function canRecord(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getDisplayMedia &&
    typeof MediaRecorder !== 'undefined'
  )
}

const emptyMeta = (): CaptureMeta => ({ duration_ms: 0, clicks: null, levels: null, pointer: null })

/** The setup a handoff (#1516) carries, as this recorder's options. */
function optionsFromHandoff(h: RecordingHandoff): SetupOptions {
  return {
    ...DEFAULT_SETUP,
    ...h.options,
    source: 'tab',
    windowPreset: `${h.size.w}x${h.size.h}`
  }
}

const REMOTE_STAGE: Record<Stage, RemoteStage> = {
  setup: 'setup',
  countdown: 'countdown',
  recording: 'recording',
  saving: 'saving',
  error: 'error',
  limit: 'uploaded',
  done: 'uploaded',
  remote: 'setup'
}

/**
 * Records this tab, a window or the whole screen with optional microphone
 * narration. Parts upload every five seconds and are kept in this browser
 * (IndexedDB) before they are sent and until the server confirms each one, so
 * an outage or a closed tab loses nothing: recording carries on through an
 * outage, and a refused or interrupted recording stays in the browser until
 * the person keeps or discards it. Recording stops by itself at 30:00.
 *
 * During recording only a small control bar shows. It portals into the
 * hosting [role="dialog"] when the recorder sits inside one (a modal sheet
 * makes everything outside it unclickable), else into document.body.
 *
 * Two more ways to record: with a script (#1491), the steps show on the bar
 * as a teleprompter and Next marks where each one starts; and in a recording
 * window (#1516), a popup of a fixed size opened from the setup panel, which
 * runs this same recorder with `handoff` set while the opener shows its
 * status (the `remote` stage) and opens the editor when it is done.
 */
export function HelpVideoRecorder({
  open,
  onClose,
  onDone,
  videoId,
  contexts,
  defaultTitle,
  barHost: hostOverride,
  handoff
}: {
  open: boolean
  onClose: () => void
  onDone: (video: HelpVideoDto) => void
  videoId?: string
  contexts?: HelpVideoContext[]
  defaultTitle?: string
  /** Mount the setup dialog and the recording bar inside this element (the
   *  modal the recording was started from) while it is connected; document.body
   *  after it goes. Without it the recorder follows its own place in the tree. */
  barHost?: HTMLElement | null
  /** Set inside a recording window (#1516): the setup the opener handed over.
   *  The recorder then records this tab, reports to the opener and closes the
   *  window when it is done. */
  handoff?: RecordingHandoff | null
}) {
  const client = useNivaroClient()
  const api = helpVideoApi(client)
  const sendPart = partSender(useApiFetchConfig())
  const [supported] = useState(canRecord)
  const [stage, setStage] = useState<Stage>('setup')
  const [options, setOptionsState] = useState<SetupOptions>(() =>
    handoff ? optionsFromHandoff(handoff) : { ...DEFAULT_SETUP, cleanScreen: readCleanPref() }
  )
  // The recording window's size choice, per browser (read once the panel shows).
  const [windowPrefRead, setWindowPrefRead] = useState(false)
  const setOptions = (next: SetupOptions) => {
    if (next.cleanScreen !== options.cleanScreen) writeCleanPref(next.cleanScreen)
    setOptionsState(next)
  }
  const [setupError, setSetupError] = useState<string | null>(null)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [leftovers, setLeftovers] = useState<Leftover[]>([])
  const [busyLeftover, setBusyLeftover] = useState<string | null>(null)
  const [confirmDiscard, setConfirmDiscard] = useState<string | null>(null)
  const [upload, setUpload] = useState<UploadState>(() => ({
    pending: 0,
    retrying: false,
    durable: idbPartStore().durable
  }))
  const [savePhase, setSavePhase] = useState<'upload' | 'finish'>('upload')
  const [autoStopped, setAutoStopped] = useState(false)
  const [saved, setSaved] = useState<HelpVideoDto | null>(null)
  // Script mode (#1491): the step being shown while recording.
  const [stepIndex, setStepIndex] = useState(0)
  const stepRef = useRef(0)
  // Inside a recording window (#1516): the size asked for and the real one.
  const [frame, setFrame] = useState<PopupFrame | null>(null)
  // The opener's side of a recording window.
  const [remote, setRemote] = useState<{
    token: string
    wanted: Size
    status: RemoteStatus | null
  } | null>(null)
  const [remoteNote, setRemoteNote] = useState<string | null>(null)
  const remoteWin = useRef<Window | null>(null)

  // Where the recording bar portals: the hosting [role="dialog"] when the
  // recorder was opened inside one (a drill sheet's modal lock makes anything
  // under document.body unclickable), else document.body. Same rule as popovers.
  const [marker, setMarker] = useState<HTMLSpanElement | null>(null)
  const override = useConnectedHost(hostOverride, open)
  const barHost =
    override ??
    (marker ? modalHostOf(marker) : undefined) ??
    (typeof document !== 'undefined' ? document.body : null)

  // Latest props for callbacks that outlive a render (timers, track events).
  // In a recording window the handoff carries what the opener was given.
  const props = useRef({ onDone, onClose, videoId, contexts, defaultTitle, handoff })
  props.current = {
    onDone,
    onClose,
    videoId: videoId ?? handoff?.videoId,
    contexts: contexts ?? handoff?.contexts,
    defaultTitle: defaultTitle ?? handoff?.defaultTitle,
    handoff
  }

  const r = useRef<{
    uploader?: PartUploader
    uploadId?: string
    failed: boolean
    meta: CaptureMeta | null
    finalized: Set<string>
    /** The video a handoff recording saved, once (the popup closes after it). */
    handedOver: boolean
  }>({ failed: false, meta: null, finalized: new Set(), handedOver: false })

  const cap = useScreenCapture({
    onLimit: () => void stop(true),
    onSharingEnded: () => (cap.isLive() ? void stop() : void cancelCountdown())
  })

  useLeaveWarning(leaveWarningActive(open, stage))
  // A clean screen from the countdown to the stop (paused included). Leaving
  // these stages, closing or unmounting the recorder brings everything back.
  useCleanScreen(open && options.cleanScreen && (stage === 'countdown' || stage === 'recording'))

  // A fresh start every time the recorder opens (unless a recording is live).
  // The script stays for the same video (a cancelled setup keeps what was
  // typed); another video starts with none, or with the draft's own (below).
  const lastVideo = useRef<string | undefined>(videoId)
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on open only
  useEffect(() => {
    if (!open || cap.isLive()) return
    setStage('setup')
    setFailure(null)
    setSetupError(null)
    setSaved(null)
    setConfirmDiscard(null)
    setRemote(null)
    setRemoteNote(null)
    setStepIndex(0)
    stepRef.current = 0
    if (handoff) {
      setOptionsState(optionsFromHandoff(handoff))
    } else if (lastVideo.current !== videoId) {
      setOptionsState((o) => ({ ...o, script: '' }))
    }
    lastVideo.current = videoId
    if (!windowPrefRead) {
      setWindowPrefRead(true)
      setOptionsState((o) => ({ ...o, windowPreset: readWindowPref() }))
    }
  }, [open])

  // Re-recording (#1491): the draft's script is offered again, unless one was
  // typed already (or the recording window brought its own).
  // biome-ignore lint/correctness/useExhaustiveDependencies: `client` is stable; runs when the setup panel shows for a video
  useEffect(() => {
    if (!open || stage !== 'setup' || !videoId || handoff || options.script) return
    let stop = false
    void fetchHelpVideo(client, videoId)
      .then((v) => {
        const steps = v.draft?.script
        if (stop || !steps?.length) return
        setOptionsState((o) => (o.script ? o : { ...o, script: scriptText(steps) }))
      })
      .catch(() => null)
    return () => {
      stop = true
    }
  }, [open, stage, videoId])

  // Interrupted recordings, read when the setup panel shows.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `api` is a new object every render; the list is read once per setup stage
  useEffect(() => {
    if (!open || stage !== 'setup' || !supported) return
    let stop = false
    void api
      .myUploads()
      .then((list) => findLeftovers(list, idbPartStore()))
      .then((rows) => !stop && setLeftovers(rows))
      .catch(() => null)
    return () => {
      stop = true
    }
  }, [open, stage, supported])

  // ── Script mode (#1491) ───────────────────────────────────────────────────
  const steps = parseScript(options.script).steps

  /** Moves the teleprompter on and marks the step in the recording. */
  function nextStep() {
    const i = stepRef.current + 1
    if (i >= steps.length || !cap.mark(i)) return
    stepRef.current = i
    setStepIndex(i)
  }

  // Alt+Shift+N while recording: caught on the window before anything else,
  // so it is never typed into a field and never counts as typing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `nextStep` reads the latest step through a ref
  useEffect(() => {
    if (!open || stage !== 'recording' || !steps.length) return
    const onKey = (e: KeyboardEvent) => {
      if (!isNextStepKey(e)) return
      e.preventDefault()
      e.stopImmediatePropagation()
      nextStep()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, stage, steps.length])

  /** The capture's data plus the script it followed (nothing when there is none). */
  function metaNow(): CaptureMeta {
    const m = cap.meta()
    return steps.length ? { ...m, script: steps } : { ...m, marks: undefined }
  }

  // ── Inside a recording window (#1516) ────────────────────────────────────
  const popupToken = handoff?.token ?? null

  // The exact size asked for (browsers may clamp it), measured again on resize.
  useEffect(() => {
    if (!open || !handoff) return
    const wanted = handoff.size
    setFrame({ wanted, actual: fitWindowTo(wanted) })
    const onResize = () =>
      setFrame({ wanted, actual: { w: window.innerWidth, h: window.innerHeight } })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [open, handoff])

  // Status for the opener: every stage change, second and queue change.
  const channel = useRef<BroadcastChannel | null>(null)
  useEffect(() => {
    if (!open || !popupToken) return
    channel.current = openChannel()
    return () => {
      channel.current?.close()
      channel.current = null
    }
  }, [open, popupToken])
  const post = (m: RecordingMessage) => {
    try {
      channel.current?.postMessage(m)
    } catch {
      /* the opener falls back to the stored result */
    }
  }
  const elapsedS = Math.floor(cap.elapsed / 1000)
  // biome-ignore lint/correctness/useExhaustiveDependencies: posts on the listed changes only
  useEffect(() => {
    if (!open || !popupToken) return
    post({
      token: popupToken,
      type: 'status',
      stage: REMOTE_STAGE[stage],
      elapsed: elapsedS * 1000,
      paused: cap.paused,
      pending: upload.pending,
      ...(frame ? { size: frame.actual } : {})
    })
  }, [open, popupToken, stage, elapsedS, cap.paused, upload.pending, frame])

  /** The popup's last word: the result for the opener, then the window
   *  closes itself. If it will not close, the page carries on as usual. */
  function leavePopup(video: HelpVideoDto | null) {
    const token = popupToken as string
    writeResult(token, video?.id ?? null)
    post(video ? { token, type: 'done', videoId: video.id } : { token, type: 'closed' })
    const p = props.current
    try {
      window.close()
    } catch {
      /* not allowed */
    }
    window.setTimeout(() => {
      if (window.closed) return
      if (video) p.onDone(video)
      else p.onClose()
    }, CLOSE_GRACE_MS)
  }

  /** Hands a saved video on: to the page, or (in a recording window) to the opener. */
  function handOver(video: HelpVideoDto) {
    if (popupToken) {
      if (r.current.handedOver) return
      r.current.handedOver = true
      leavePopup(video)
    } else {
      props.current.onDone(video)
    }
  }

  const close = () => {
    if (popupToken && !saved) leavePopup(null)
    else props.current.onClose()
  }

  // ── The opener's side of a recording window (#1516) ──────────────────────
  function openWindow() {
    if (isRecordingWindow() || handoff) return // never a window from a window
    setSetupError(null)
    const preset = presetById(options.windowPreset)
    writeWindowPref(preset.id)
    const size = { w: preset.w, h: preset.h }
    const token = newToken()
    const p = props.current
    const h: RecordingHandoff = {
      v: 1,
      token,
      at: Date.now(),
      size,
      ...(p.videoId ? { videoId: p.videoId } : {}),
      ...(p.contexts ? { contexts: p.contexts } : {}),
      ...(p.defaultTitle ? { defaultTitle: p.defaultTitle } : {}),
      options: {
        useMic: options.useMic,
        micId: options.micId,
        captureClicks: options.captureClicks,
        cleanScreen: options.cleanScreen,
        script: options.script
      }
    }
    if (!writeHandoff(h)) {
      setSetupError(
        'This browser cannot pass your settings to a recording window (storage is blocked). Record in this tab instead.'
      )
      return
    }
    let win: Window | null = null
    try {
      win = window.open(
        recordingUrl(window.location.href, token),
        RECORDING_WINDOW_NAME,
        popupFeatures(size)
      )
    } catch {
      win = null
    }
    if (!win) {
      forgetHandoff(token)
      setSetupError(POPUP_BLOCKED)
      return
    }
    remoteWin.current = win
    setRemoteNote(null)
    setRemote({ token, wanted: size, status: null })
    setStage('remote')
  }

  // Listen to the recording window: its status, its result, and whether it is
  // still there (a window closed without a word hands back its stored result).
  // biome-ignore lint/correctness/useExhaustiveDependencies: `client` is stable; runs per remote session
  useEffect(() => {
    if (!open || stage !== 'remote' || !remote) return
    const { token } = remote
    let finished = false
    const backToSetup = (note: string) => {
      if (finished) return
      finished = true
      forgetHandoff(token)
      remoteWin.current = null
      setRemote(null)
      setRemoteNote(null)
      setSetupError(note)
      setStage('setup')
    }
    const finish = (videoId: string) => {
      if (finished) return
      finished = true
      forgetHandoff(token)
      remoteWin.current = null
      void fetchHelpVideo(client, videoId)
        .then((video) => {
          setSaved(video)
          setStage('done')
          props.current.onDone(video)
        })
        .catch(() => {
          setRemote(null)
          setStage('setup')
          setSetupError(
            'The recording was saved, but this tab could not load it. You will find it in the Videos library.'
          )
        })
    }
    const ch = openChannel()
    if (ch) {
      ch.onmessage = (e: MessageEvent<RecordingMessage>) => {
        const m = e.data
        if (!m || m.token !== token) return
        if (m.type === 'status') {
          const { token: _t, type: _k, ...status } = m
          setRemote((cur) => (cur ? { ...cur, status } : cur))
        } else if (m.type === 'done') finish(m.videoId)
        else if (m.type === 'closed')
          backToSetup('The recording window was closed before a recording was saved.')
      }
    }
    const poll = window.setInterval(() => {
      const win = remoteWin.current
      if (win && !win.closed) return
      const result = takeResult(token)
      if (result?.videoId) finish(result.videoId)
      else backToSetup('The recording window was closed before a recording was saved.')
    }, WINDOW_POLL_MS)
    return () => {
      window.clearInterval(poll)
      ch?.close()
    }
  }, [open, stage, remote?.token])

  // ── Recording ────────────────────────────────────────────────────────────
  function newUploader(uploadId: string, startAt: number, maxAttempts: number) {
    return new PartUploader({
      uploadId,
      store: idbPartStore(),
      startAt,
      maxAttempts,
      send: (n, blob) => sendPart(uploadId, n, blob),
      onChange: setUpload
    })
  }

  async function start() {
    setSetupError(null)
    setAutoStopped(false)
    setUpload({ pending: 0, retrying: false, durable: idbPartStore().durable })
    setStepIndex(0)
    stepRef.current = 0
    cap.reset()
    const s = r.current
    Object.assign(s, { failed: false, meta: null, uploadId: undefined, uploader: undefined })
    try {
      const mime = await cap.acquire(options)
      const opened = await api.openUpload(mime.split(';')[0])
      s.uploadId = opened.id
      // While recording, an outage never gives up: parts wait in the browser.
      const uploader = newUploader(opened.id, 0, Number.POSITIVE_INFINITY)
      s.uploader = uploader
      cap.arm(mime, (blob) => {
        uploader.enqueue(blob)
        // Only a refusal stops the recording; the parts stay in the browser.
        void uploader.drain().catch((err) => {
          if (stopsRecording(err)) void failWhileRecording(err)
        })
      })
      setStage('countdown')
      if (!(await cap.countdown())) return
      cap.begin(options.captureClicks && options.source === 'tab')
      setStage('recording')
    } catch (err) {
      cap.release()
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
    if (!cap.cancel()) return
    const s = r.current
    if (s.uploadId) {
      const id = s.uploadId
      s.uploadId = undefined
      await api.abandonUpload(id).catch(() => null)
      await idbPartStore().clear(id)
    }
    setStage('setup')
  }

  async function stop(auto = false) {
    const s = r.current
    if (!cap.isLive()) return
    s.meta = metaNow()
    await cap.halt()
    const uploader = s.uploader as PartUploader
    uploader.limitAttempts(SAVE_ATTEMPTS)
    setAutoStopped(auto)
    setSavePhase('upload')
    setStage('saving')
    await save(String(s.uploadId), uploader, s.meta, auto)
  }

  async function failWhileRecording(err: unknown) {
    const s = r.current
    if (!cap.isLive() || s.failed) return
    s.failed = true
    s.meta = metaNow()
    await cap.halt()
    setFailure({ ...plainFailure(err), uploadId: String(s.uploadId) })
    setStage('error')
  }

  async function finish(uploadId: string, meta: CaptureMeta): Promise<HelpVideoDto> {
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

  async function save(uploadId: string, uploader: PartUploader, meta: CaptureMeta, auto: boolean) {
    try {
      await uploader.drain()
      setSavePhase('finish')
      const video = await finish(uploadId, meta)
      setSaved(video)
      // Leave 'saving' before handing the video over, so nothing (the leave
      // warning, the hidden close button) outlives the save.
      if (auto && !popupToken) {
        setStage('limit')
      } else {
        setStage('done')
        handOver(video)
      }
    } catch (err) {
      setFailure({ ...plainFailure(err), uploadId })
      setStage('error')
    }
  }

  /** Saves an upload again from what the server and this browser hold. When
   *  the end never reached the server (`gap`), only `keepPartial` saves it. */
  async function saveAgain(id: string, meta: CaptureMeta, keepPartial = false) {
    setFailure(null)
    setSavePhase('upload')
    setStage('saving')
    try {
      const parts = await idbPartStore().list(id)
      const nextServer = (await api.myUploads()).find((u) => u.id === id)?.next_part ?? 0
      const { resend, gap } = planResume(parts, nextServer)
      if (gap && !keepPartial) {
        setFailure({
          message: "The end of this recording didn't reach the server.",
          retryable: false,
          closed: false,
          partial: true,
          uploadId: id
        })
        setStage('error')
        return
      }
      const up = newUploader(id, nextServer, SAVE_ATTEMPTS)
      up.resume(resend)
      await save(id, up, meta, false)
    } catch (err) {
      setFailure({ ...plainFailure(err), uploadId: id })
      setStage('error')
    }
  }

  const metaFor = (id: string) =>
    r.current.uploadId === id && r.current.meta ? r.current.meta : emptyMeta()

  async function keepLeftover(id: string) {
    const row = leftovers.find((l) => l.id === id)
    setBusyLeftover(id)
    setAutoStopped(false)
    await saveAgain(id, emptyMeta(), !!row?.gap)
    setBusyLeftover(null)
  }

  /** A finished recording the server already holds: no parts to send and
   *  nothing to finalize, only the save (create, or re-record into this video). */
  async function saveFinished(id: string) {
    setBusyLeftover(id)
    setAutoStopped(false)
    setFailure(null)
    setSavePhase('finish')
    setStage('saving')
    r.current.finalized.add(id)
    try {
      const video = await finish(id, emptyMeta())
      setSaved(video)
      setStage('done')
      handOver(video)
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

  if (stage === 'recording' || stage === 'countdown') {
    return (
      <>
        {/* Marks where the recorder sits in the tree, for modalHostOf. */}
        <span ref={setMarker} hidden />
        {barHost && (
          <RecorderBar
            host={barHost}
            stage={stage}
            count={cap.count}
            elapsed={cap.elapsed}
            paused={cap.paused}
            muted={cap.muted}
            hasMic={cap.hasMic}
            micMissing={cap.micMissing}
            retrying={upload.retrying}
            durable={upload.durable}
            announce={cap.announce}
            script={steps}
            step={stepIndex}
            frame={frame}
            onCancel={() => void cancelCountdown()}
            onPause={cap.togglePause}
            onMute={cap.toggleMute}
            onStop={() => void stop()}
            onNext={nextStep}
          />
        )}
      </>
    )
  }

  const title = videoId ? 'Re-record this video' : 'Record a tutorial'
  const saving = stage === 'saving'
  /** The limit notice hands the video over when it is opened or closed. */
  const limitHandOver = () => {
    if (!saved) return
    setStage('done')
    handOver(saved)
  }
  return (
    <>
      {/* Rendered in every stage so the bar's host is known before recording starts. */}
      <span ref={setMarker} hidden />
      <Dialog
        open
        onOpenChange={(o) => {
          if (o || saving || stage === 'remote') return
          if (stage === 'limit') limitHandOver()
          close()
        }}
      >
        <DialogContent
          className='w-[calc(100vw-2rem)] max-w-[520px] font-sans dark:bg-card'
          hideClose={saving || stage === 'remote'}
          container={override}
          data-hv-recorder
          data-hv-stage={supported ? stage : 'unsupported'}
          data-hv-popup={handoff ? '1' : undefined}
        >
          {!supported ? (
            <UnsupportedView title={title} onClose={close} />
          ) : stage === 'saving' ? (
            <SavingView
              autoStopped={autoStopped}
              phase={savePhase}
              pending={upload.pending}
              retrying={upload.retrying}
              durable={upload.durable}
            />
          ) : stage === 'remote' && remote ? (
            <RemoteView
              title={title}
              status={remote.status}
              wanted={remote.wanted}
              note={remoteNote}
              onFocus={() => remoteWin.current?.focus()}
            />
          ) : stage === 'limit' ? (
            <LimitView onOpen={limitHandOver} />
          ) : stage === 'done' ? (
            <DoneView onClose={close} />
          ) : stage === 'error' && failure ? (
            <ErrorView
              failure={failure}
              durable={upload.durable}
              confirming={confirmDiscard === failure.uploadId}
              onAskDiscard={() => setConfirmDiscard(failure.uploadId)}
              onCancelDiscard={() => setConfirmDiscard(null)}
              onDiscard={async () => {
                await discard(failure.uploadId)
                setFailure(null)
                setStage('setup')
              }}
              onClose={close}
              onRetry={() => void saveAgain(failure.uploadId, metaFor(failure.uploadId))}
              onKeepPartial={() =>
                void saveAgain(failure.uploadId, metaFor(failure.uploadId), true)
              }
            />
          ) : (
            <RecorderSetup
              title={title}
              rerecord={!!videoId}
              options={options}
              onOptions={setOptions}
              leftovers={leftovers}
              busyLeftover={busyLeftover}
              confirmDiscard={confirmDiscard}
              onConfirmDiscard={setConfirmDiscard}
              onKeep={(id) => void keepLeftover(id)}
              onSaveFinished={(id) => void saveFinished(id)}
              onDiscard={(id) => void discard(id)}
              error={setupError}
              onCancel={close}
              onStart={() => void start()}
              popup={handoff ? (frame ?? { wanted: handoff.size, actual: handoff.size }) : null}
              onOpenWindow={handoff || isRecordingWindow() ? undefined : openWindow}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
