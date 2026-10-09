import { useEffect, useRef, useState } from 'react'
import { useApiFetchConfig, useNivaroClient } from '../../../context'
import { Dialog, DialogContent } from '../../ui/dialog'
import { modalHostOf } from '../../ui/popover'
import { fetchHelpVideo, helpVideoApi } from '../api'
import type { HelpVideoContext, HelpVideoDto } from '../types'
import { type Failure, plainFailure, stopsRecording } from './failure'
import { findLeftovers, type Leftover, planResume } from './leftovers'
import { idbPartStore, PartUploader, type UploadState } from './partQueue'
import { RecorderBar } from './RecorderBar'
import { DEFAULT_SETUP, RecorderSetup, type SetupOptions } from './RecorderSetup'
import { DoneView, ErrorView, LimitView, SavingView, UnsupportedView } from './RecorderStatus'
import { partSender } from './sendPart'
import { useConnectedHost } from './useConnectedHost'
import { leaveWarningActive, useLeaveWarning } from './useLeaveWarning'
import { type CaptureMeta, useScreenCapture } from './useScreenCapture'

export { RECORD_UNSUPPORTED } from './RecorderStatus'

type Stage = 'setup' | 'countdown' | 'recording' | 'saving' | 'error' | 'limit' | 'done'

/** Attempts per part once recording has stopped (live parts retry without limit). */
const SAVE_ATTEMPTS = 12

export function canRecord(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getDisplayMedia &&
    typeof MediaRecorder !== 'undefined'
  )
}

const emptyMeta = (): CaptureMeta => ({ duration_ms: 0, clicks: null, levels: null })

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
 */
export function HelpVideoRecorder({
  open,
  onClose,
  onDone,
  videoId,
  contexts,
  defaultTitle,
  barHost: hostOverride
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
}) {
  const client = useNivaroClient()
  const api = helpVideoApi(client)
  const sendPart = partSender(useApiFetchConfig())
  const [supported] = useState(canRecord)
  const [stage, setStage] = useState<Stage>('setup')
  const [options, setOptions] = useState<SetupOptions>(DEFAULT_SETUP)
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
  const props = useRef({ onDone, videoId, contexts, defaultTitle })
  props.current = { onDone, videoId, contexts, defaultTitle }

  const r = useRef<{
    uploader?: PartUploader
    uploadId?: string
    failed: boolean
    meta: CaptureMeta | null
    finalized: Set<string>
  }>({ failed: false, meta: null, finalized: new Set() })

  const cap = useScreenCapture({
    onLimit: () => void stop(true),
    onSharingEnded: () => (cap.isLive() ? void stop() : void cancelCountdown())
  })

  useLeaveWarning(leaveWarningActive(open, stage))

  // A fresh start every time the recorder opens (unless a recording is live).
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on open only
  useEffect(() => {
    if (!open || cap.isLive()) return
    setStage('setup')
    setFailure(null)
    setSetupError(null)
    setSaved(null)
    setConfirmDiscard(null)
  }, [open])

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
    s.meta = cap.meta()
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
    s.meta = cap.meta()
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
      if (auto) {
        setStage('limit')
      } else {
        setStage('done')
        props.current.onDone(video)
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
            onCancel={() => void cancelCountdown()}
            onPause={cap.togglePause}
            onMute={cap.toggleMute}
            onStop={() => void stop()}
          />
        )}
      </>
    )
  }

  const title = videoId ? 'Re-record this video' : 'Record a tutorial'
  const saving = stage === 'saving'
  /** The limit notice hands the video over when it is opened or closed. */
  const handOver = () => {
    if (!saved) return
    setStage('done')
    props.current.onDone(saved)
  }
  return (
    <>
      {/* Rendered in every stage so the bar's host is known before recording starts. */}
      <span ref={setMarker} hidden />
      <Dialog
        open
        onOpenChange={(o) => {
          if (o || saving) return
          if (stage === 'limit') handOver()
          onClose()
        }}
      >
        <DialogContent
          className='w-[calc(100vw-2rem)] max-w-[520px] font-sans dark:bg-card'
          hideClose={saving}
          container={override}
          data-hv-recorder
          data-hv-stage={supported ? stage : 'unsupported'}
        >
          {!supported ? (
            <UnsupportedView title={title} onClose={onClose} />
          ) : stage === 'saving' ? (
            <SavingView
              autoStopped={autoStopped}
              phase={savePhase}
              pending={upload.pending}
              retrying={upload.retrying}
              durable={upload.durable}
            />
          ) : stage === 'limit' ? (
            <LimitView onOpen={handOver} />
          ) : stage === 'done' ? (
            <DoneView onClose={onClose} />
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
              onClose={onClose}
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
              onDiscard={(id) => void discard(id)}
              error={setupError}
              onCancel={onClose}
              onStart={() => void start()}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
