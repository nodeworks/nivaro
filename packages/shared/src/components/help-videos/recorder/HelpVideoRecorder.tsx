import { useEffect, useRef, useState } from 'react'
import { useApiFetchConfig, useNivaroClient } from '../../../context'
import { Dialog, DialogContent } from '../../ui/dialog'
import { modalHostOf } from '../../ui/popover'
import { fetchHelpVideo, helpVideoApi } from '../api'
import type { HelpVideoContext, HelpVideoDto } from '../types'
import { type Failure, plainFailure, serverMessage } from './failure'
import { idbPartStore, PartUploader } from './partQueue'
import { RecorderBar } from './RecorderBar'
import { DEFAULT_SETUP, type Leftover, RecorderSetup, type SetupOptions } from './RecorderSetup'
import { ErrorView, LimitView, SavingView, UnsupportedView } from './RecorderStatus'
import { type CaptureMeta, useScreenCapture } from './useScreenCapture'

export { RECORD_UNSUPPORTED } from './RecorderStatus'

type Stage = 'setup' | 'countdown' | 'recording' | 'saving' | 'error' | 'limit'

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
  const [options, setOptions] = useState<SetupOptions>(DEFAULT_SETUP)
  const [setupError, setSetupError] = useState<string | null>(null)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [leftovers, setLeftovers] = useState<Leftover[]>([])
  const [busyLeftover, setBusyLeftover] = useState<string | null>(null)
  const [confirmDiscard, setConfirmDiscard] = useState<string | null>(null)
  const [upload, setUpload] = useState({ pending: 0, retrying: false })
  const [savePhase, setSavePhase] = useState<'upload' | 'finish'>('upload')
  const [autoStopped, setAutoStopped] = useState(false)
  const [limitVideo, setLimitVideo] = useState<HelpVideoDto | null>(null)

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

  // A fresh start every time the recorder opens (unless a recording is live).
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on open only
  useEffect(() => {
    if (!open || cap.isLive()) return
    setStage('setup')
    setFailure(null)
    setSetupError(null)
    setLimitVideo(null)
    setConfirmDiscard(null)
  }, [open])

  // Interrupted recordings, read when the setup panel shows.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `api` is a new object every render; the list is read once per setup stage
  useEffect(() => {
    if (!open || stage !== 'setup' || !supported) return
    let stop = false
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

  async function start() {
    setSetupError(null)
    setAutoStopped(false)
    setUpload({ pending: 0, retrying: false })
    cap.reset()
    const s = r.current
    Object.assign(s, { failed: false, meta: null, uploadId: undefined, uploader: undefined })
    try {
      const mime = await cap.acquire(options)
      const opened = await api.openUpload(mime.split(';')[0])
      s.uploadId = opened.id
      const uploader = newUploader(opened.id)
      s.uploader = uploader
      cap.arm(mime, (blob) => {
        uploader.enqueue(blob)
        // A refusal mid-recording stops it at once; the parts stay in the browser.
        void uploader.drain().catch((err) => void failWhileRecording(err))
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
    setAutoStopped(auto)
    setSavePhase('upload')
    setStage('saving')
    await save(String(s.uploadId), s.uploader as PartUploader, s.meta, auto)
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

  /** Saves an upload again from what the server and this browser hold. */
  async function saveAgain(id: string, meta: CaptureMeta) {
    setSavePhase('upload')
    setStage('saving')
    try {
      await save(id, await resumeUploader(id), meta, false)
    } catch (err) {
      setFailure({ ...plainFailure(err), uploadId: id })
      setStage('error')
    }
  }

  async function retry() {
    if (!failure) return
    const id = failure.uploadId
    const meta = r.current.uploadId === id && r.current.meta ? r.current.meta : emptyMeta()
    setFailure(null)
    await saveAgain(id, meta)
  }

  async function keepLeftover(id: string) {
    setBusyLeftover(id)
    setAutoStopped(false)
    await saveAgain(id, emptyMeta())
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
            <UnsupportedView title={title} onClose={onClose} />
          ) : stage === 'saving' ? (
            <SavingView
              autoStopped={autoStopped}
              phase={savePhase}
              pending={upload.pending}
              retrying={upload.retrying}
            />
          ) : stage === 'limit' ? (
            <LimitView onOpen={() => limitVideo && props.current.onDone(limitVideo)} />
          ) : stage === 'error' && failure ? (
            <ErrorView
              failure={failure}
              confirming={confirmDiscard === failure.uploadId}
              onAskDiscard={() => setConfirmDiscard(failure.uploadId)}
              onCancelDiscard={() => setConfirmDiscard(null)}
              onDiscard={async () => {
                await discard(failure.uploadId)
                setFailure(null)
                setStage('setup')
              }}
              onClose={onClose}
              onRetry={() => void retry()}
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
