import type { NivaroClient } from '@nivaro/sdk'
import {
  appendSessionRecordingEvents,
  endSessionRecording,
  sessionRecordingEnabled,
  startSessionRecording
} from '@nivaro/sdk'
import { useEffect, useRef } from 'react'
import { useOptionalNivaroClient } from '../context'
import {
  backoffDelay,
  CHUNK_BYTES,
  clearResume,
  type DrainOutcome,
  isResumable,
  KEEPALIVE_CHUNK_BYTES,
  ORPHAN_TTL_MS,
  ReplayUploader,
  readResume,
  sessionStore,
  sharedChunkStore,
  splitBySize,
  writeResume
} from './replayUploadQueue'

/**
 * rrweb session recorder for headless frontends — two modes, one hook
 * (the exact model the admin app runs; see admin/src/lib/use-session-recorder.ts).
 *
 * FULL mode (`session_recording_enabled` on the instance): events stream to
 * the server continuously, through a queue that survives failures (#1369):
 * chunks that can't go now wait in IndexedDB and retry with backoff, a reload
 * within ten minutes continues the same recording, and pagehide sends the
 * tail with fetch keepalive. See replayUploadQueue.ts.
 *
 * ERROR-CLIP mode (`error_replay_enabled`, when full recording is off):
 * rrweb records into a rolling IN-MEMORY buffer — two 30s checkout windows,
 * so 30–60s of history — and uploads NOTHING. When the host reports an error,
 * `captureErrorClip()` flushes the buffer as a short recording labelled
 * app='error-clip'; attach the returned `recording_id`/`offset_ms` to your
 * `POST /issues/client` body and the issue links straight to the replay.
 *
 * Drop `useSessionRecorder({ app: 'customer-portal' })` anywhere inside a
 * NivaroProvider (or pass a client explicitly). Needs `rrweb` installed in
 * the host (optional peer dependency; without it the hook warns once and
 * no-ops). Privacy in both modes: every input masked, `nvr-no-record`
 * class blocked; in clip mode events never leave the browser except on error.
 *
 * `captureErrorClip` is a module singleton so an error boundary — a class
 * component far from this hook — can call it without plumbing.
 */

export interface SessionRecorderOptions {
  /** Label shown in the admin replay list — which frontend this is. */
  app?: string
  /** Explicit client; defaults to the NivaroProvider context client. */
  client?: NivaroClient
  /** Force-disable locally regardless of the instance setting. */
  disabled?: boolean
}

export interface ErrorReplayLink {
  recording_id: string
  /** Milliseconds into the recording where the error happened. Null for
   *  clips — the whole clip IS the error context. */
  offset_ms: number | null
}

const FLUSH_MS = 10_000
const FLUSH_COUNT = 150
/**
 * Upload backpressure. Recording shares the page's six connections per
 * origin: a multi-megabyte snapshot POST fired while a record page loads sits
 * in the same queue as the reads that paint it. So uploads are single-flight
 * and sequential, wait for a QUIET window (page loaded, no route change for
 * QUIET_MS) and ride requestIdleCallback when the browser has one. The
 * buffer never grows without bound: past HARD_FLUSH_COUNT events it uploads
 * regardless, and hide / unmount / error capture always force a flush.
 */
const QUIET_MS = 3_000
const HARD_FLUSH_COUNT = 600
// Chunk sizing (CHUNK_BYTES, splitBySize) lives in replayUploadQueue.ts.

/** sessionStorage key for this tab's resumable recording (#1369), per app label. */
const resumeKey = (app?: string) => `nvr_replay_resume${app ? `:${app}` : ''}`

const isOnline = () => typeof navigator === 'undefined' || navigator.onLine !== false

/**
 * A keepalive POST straight to the instance, with the same auth the client
 * uses (its bearer token, or the cookie session when it has none) — the
 * SDK's request() has no keepalive. Null when the client doesn't expose its
 * URL (a test double): callers fall back to client.request.
 */
function keepaliveSender(
  client: NivaroClient
): ((recordingId: string, body: string) => Promise<Response>) | null {
  if (typeof client.url !== 'string' || typeof fetch !== 'function') return null
  return (recordingId, body) => {
    const token = typeof client.getToken === 'function' ? client.getToken() : undefined
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (token) headers.Authorization = `Bearer ${token}`
    return fetch(`${client.url}/api/session-recordings/${recordingId}/events`, {
      method: 'POST',
      keepalive: true,
      credentials: token ? 'omit' : 'include',
      headers,
      body
    })
  }
}

/**
 * Upload events in size-bounded chunks, once — error-clip mode only. A 413
 * drops THAT chunk and keeps going (one lost snapshot beats a dead clip); a
 * 409 means the recording is closed or capped — stop for good. Full mode
 * goes through the resilient queue instead.
 */
async function postEventChunks(
  client: NivaroClient,
  recordingId: string,
  nextSeq: () => number,
  events: unknown[]
): Promise<'ok' | 'closed'> {
  for (const chunk of splitBySize(events)) {
    const seq = nextSeq()
    try {
      await client.request(appendSessionRecordingEvents(recordingId, seq, chunk))
    } catch (err) {
      const status =
        (err as { status?: number; response?: { status?: number } }).status ??
        (err as { response?: { status?: number } }).response?.status
      if (status === 409) return 'closed'
      if (status === 413) {
        console.warn(`[session-recorder] chunk ${seq} too large — dropped`)
      }
    }
  }
  return 'ok'
}
/** Buffer checkout window — two of these = the clip length ceiling. */
const CLIP_WINDOW_MS = 30_000
/** One clip per error burst: reuse a clip minted this recently. */
const CLIP_REUSE_MS = 30_000

let warnedMissingRrweb = false

type ClipCapture = () => Promise<ErrorReplayLink | null>
let captureFn: ClipCapture | null = null

/**
 * Grab the replay link for an error being reported right now. Resolves null
 * when no recorder is active (both settings off, recording failed, or the
 * clip upload took longer than 4s) — error reporting must never wait on or
 * break because of replay capture.
 */
export async function captureErrorClip(): Promise<ErrorReplayLink | null> {
  if (!captureFn) return null
  try {
    return await Promise.race([
      captureFn(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000))
    ])
  } catch {
    return null
  }
}

async function loadRrweb(): Promise<typeof import('rrweb')['record'] | null> {
  try {
    return (await import('rrweb')).record
  } catch {
    if (!warnedMissingRrweb) {
      warnedMissingRrweb = true
      console.warn(
        '[nivaro] session recording is enabled on the instance but `rrweb` is not installed in this app — run `npm i rrweb` to record.'
      )
    }
    return null
  }
}

// ── Replay context instrumentation (mirrors the admin recorder) ─────────────
// Console lines + route changes ride the recording as rrweb CUSTOM events
// (type 5) so the replay player can mark them on the scrubber and show the
// user's console beside the replay. Capped so an error flood can't bloat the
// recording; console.log deliberately excluded. Returns an undo function.
function instrumentReplayContext(
  addCustomEvent: (tag: string, payload: unknown) => void,
  onRoute?: () => void
): () => void {
  let captured = 0
  const MAX_EVENTS = 500
  const originals: Partial<Record<'info' | 'warn' | 'error', (...a: unknown[]) => void>> = {}
  let inHook = false
  for (const level of ['info', 'warn', 'error'] as const) {
    originals[level] = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      originals[level]?.(...args)
      if (inHook || captured >= MAX_EVENTS) return
      inHook = true
      try {
        captured++
        const msg = args
          .map((a) => {
            if (typeof a === 'string') return a
            if (a instanceof Error) return `${a.name}: ${a.message}`
            try {
              return JSON.stringify(a)
            } catch {
              return String(a)
            }
          })
          .join(' ')
          .slice(0, 500)
        addCustomEvent('console', { level, msg })
      } catch {
        /* never break the console */
      } finally {
        inHook = false
      }
    }
  }
  const routeEvent = () => {
    onRoute?.()
    try {
      addCustomEvent('route', { path: window.location.pathname + window.location.search })
    } catch {
      /* best-effort */
    }
  }
  const origPush = history.pushState.bind(history)
  const origReplace = history.replaceState.bind(history)
  history.pushState = (...a: Parameters<History['pushState']>) => {
    origPush(...a)
    routeEvent()
  }
  history.replaceState = (...a: Parameters<History['replaceState']>) => {
    origReplace(...a)
    routeEvent()
  }
  window.addEventListener('popstate', routeEvent)
  routeEvent() // the starting page is a marker too
  return () => {
    for (const level of ['info', 'warn', 'error'] as const) {
      if (originals[level]) console[level] = originals[level] as never
    }
    history.pushState = origPush
    history.replaceState = origReplace
    window.removeEventListener('popstate', routeEvent)
  }
}

export function useSessionRecorder(options: SessionRecorderOptions = {}) {
  const contextClient = useOptionalNivaroClient()
  const client = options.client ?? contextClient
  const appLabel = options.app
  const disabled = options.disabled ?? false

  const stateRef = useRef<{
    // Full mode's recording id and seq live in its ReplayUploader.
    buffer: unknown[]
    stop: (() => void) | null
    uninstrument: (() => void) | null
    dead: boolean
    startedAt: number
    prevWindow: unknown[]
    lastClip: { at: number; link: ErrorReplayLink | null } | null
    lastNavAt: number
    inFlight: Promise<void> | null
    flushAfter: boolean
  }>({
    buffer: [],
    stop: null,
    uninstrument: null,
    dead: false,
    startedAt: 0,
    prevWindow: [],
    lastClip: null,
    lastNavAt: 0,
    inFlight: null,
    flushAfter: false
  })

  useEffect(() => {
    if (!client || disabled || typeof window === 'undefined') return
    let cancelled = false
    const state = stateRef.current
    state.dead = false
    const api = client
    const storage = sessionStore()
    const RESUME_KEY = resumeKey(appLabel)
    const store = sharedChunkStore()
    const viaKeepalive = keepaliveSender(api)
    /**
     * POST one queued chunk. While the page is hidden (it may be unloading)
     * a small chunk rides fetch keepalive so it outlives the page.
     */
    const sendChunk = async (id: string, seq: number, events: unknown[], keepalive: boolean) => {
      if (!keepalive || !viaKeepalive) {
        await api.request(appendSessionRecordingEvents(id, seq, events))
        return
      }
      const res = await viaKeepalive(id, JSON.stringify({ seq, events }))
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status })
    }
    const uploader = new ReplayUploader({ store, send: sendChunk, online: isOnline })
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    /** Uploads wait until then after a transient failure (backoff). */
    let retryAt = 0

    const quiet = () =>
      document.readyState === 'complete' && Date.now() - state.lastNavAt >= QUIET_MS

    /**
     * Remember the recording for a reload in this tab (sessionStorage). No
     * user id here — the SDK identity is a token we won't copy into storage;
     * a resumed id that isn't ours answers 403 and a fresh recording starts.
     */
    function saveResume() {
      if (!uploader.recordingId) return
      writeResume(storage, RESUME_KEY, {
        recordingId: uploader.recordingId,
        nextSeq: uploader.nextSeq,
        startedAt: state.startedAt,
        lastActivityAt: Date.now()
      })
    }

    function clearRetry() {
      if (retryTimer) clearTimeout(retryTimer)
      retryTimer = null
      retryAt = 0
    }

    function scheduleRetry() {
      clearRetry()
      const delay = backoffDelay(uploader.attempt)
      retryAt = Date.now() + delay
      retryTimer = setTimeout(() => {
        retryTimer = null
        retryAt = 0
        void flush(true)
      }, delay)
    }

    /** 409 (closed / capped) or a recording that will never take a chunk. */
    function kill() {
      state.dead = true
      state.stop?.()
      clearRetry()
      uploader.discard()
      clearResume(storage, RESUME_KEY)
    }

    /**
     * Move buffered events into the queue — their seq is fixed from here on.
     * While the page may be unloading the chunks are cut small enough to
     * ride fetch keepalive.
     */
    function enqueueBuffer(hiding: boolean) {
      if (state.buffer.length === 0 || !uploader.recordingId) return
      const events = state.buffer
      state.buffer = []
      for (const chunk of splitBySize(events, hiding ? KEEPALIVE_CHUNK_BYTES : CHUNK_BYTES)) {
        uploader.enqueue(chunk)
      }
      saveResume()
    }

    async function afterDrain(outcome: DrainOutcome): Promise<void> {
      // After cleanup the shared stateRef may already belong to the next
      // run of this effect — a late outcome must not stop ITS rrweb.
      if (cancelled) return
      if (outcome === 'retry') scheduleRetry()
      else if (outcome === 'closed' || outcome === 'abandoned') kill()
      else if (outcome === 'stale') {
        // The recording this tab was resuming is gone (ended, purged, not
        // this identity's). Start a fresh one and move this page's chunks —
        // the opening full snapshot among them — onto it.
        try {
          const started = await api.request(startSessionRecording(appLabel))
          if (cancelled) return
          uploader.rebase(started.data.id)
          state.startedAt = Date.now()
          saveResume()
          state.flushAfter = true
        } catch {
          kill()
        }
      }
      // 'offline' waits for the online event; 'ok' has nothing left to do.
    }

    /**
     * Single-flight: one upload at a time, chunks in seq order. A forced
     * flush that lands mid-upload runs again once that upload settles; an
     * unforced one just waits for the next tick. Chunks that fail stay
     * queued (and in IndexedDB) and go again after the backoff.
     */
    function flush(force = false, hiding = false): Promise<void> {
      if (state.inFlight) {
        if (force) state.flushAfter = true
        return state.inFlight
      }
      if (state.dead || !uploader.recordingId) return Promise.resolve()
      if (!force && !quiet() && state.buffer.length < HARD_FLUSH_COUNT) return Promise.resolve()
      enqueueBuffer(hiding)
      if (!uploader.hasPending() || Date.now() < retryAt) return Promise.resolve()
      state.inFlight = uploader
        .drain(hiding)
        .then(afterDrain)
        .catch(() => {})
        .finally(() => {
          state.inFlight = null
          if (state.flushAfter) {
            state.flushAfter = false
            void flush(true)
          }
        })
      return state.inFlight
    }

    /** Timer / count-triggered flush: yield to page work first. */
    function scheduleFlush() {
      const ric = (
        window as unknown as {
          requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void
        }
      ).requestIdleCallback
      if (ric) ric(() => void flush(), { timeout: FLUSH_MS })
      else void flush()
    }

    async function startFull() {
      const record = await loadRrweb()
      if (cancelled || !record) return
      void store.prune(Date.now() - ORPHAN_TTL_MS)
      // A reload in this tab within the resume window continues the same
      // recording: no start call, seq carries on, and whatever the previous
      // page could not upload goes first. If the server no longer takes that
      // id, the first upload answers 'stale' and a fresh recording starts
      // then (afterDrain).
      const saved = readResume(storage, RESUME_KEY)
      if (saved && isResumable(saved, Date.now())) {
        const restored = await store.list(saved.recordingId)
        if (cancelled) return
        uploader.begin(saved.recordingId, saved.nextSeq, { trusted: false, restored })
        state.startedAt = saved.startedAt
      } else {
        if (saved) {
          void store.clear(saved.recordingId)
          clearResume(storage, RESUME_KEY)
        }
        const started = await api.request(startSessionRecording(appLabel))
        if (cancelled) return
        uploader.begin(started.data.id)
        state.startedAt = Date.now()
      }
      saveResume()
      state.lastNavAt = Date.now()
      state.stop =
        record({
          emit(event: unknown) {
            state.buffer.push(event)
            if (state.buffer.length >= FLUSH_COUNT) scheduleFlush()
          },
          maskAllInputs: true,
          blockClass: 'nvr-no-record',
          checkoutEveryNms: 60_000
        }) ?? null
      state.uninstrument = instrumentReplayContext(
        (tag, payload) =>
          (record as unknown as { addCustomEvent: (t: string, p: unknown) => void }).addCustomEvent(
            tag,
            payload
          ),
        () => {
          state.lastNavAt = Date.now()
        }
      )
      // A live full recording answers an error capture with itself + the
      // error's offset, after pushing whatever is still buffered.
      // (Queued chunks may still be on their way; the link is valid either
      // way and they land on retry.)
      captureFn = async () => {
        if (!uploader.recordingId) return null
        const offset = Date.now() - state.startedAt
        await flush(true).catch(() => {})
        if (!uploader.recordingId) return null
        return { recording_id: uploader.recordingId, offset_ms: offset }
      }
    }

    async function startClip() {
      const record = await loadRrweb()
      if (cancelled || !record) return
      state.buffer = []
      state.prevWindow = []
      state.stop =
        record({
          emit(event: unknown, isCheckout?: boolean) {
            if (isCheckout) {
              // A checkout event is a full DOM snapshot — it starts a
              // self-sufficient window, so the one before last can drop.
              state.prevWindow = state.buffer
              state.buffer = [event]
            } else {
              state.buffer.push(event)
            }
          },
          maskAllInputs: true,
          blockClass: 'nvr-no-record',
          checkoutEveryNms: CLIP_WINDOW_MS
        }) ?? null
      state.uninstrument = instrumentReplayContext((tag, payload) =>
        (record as unknown as { addCustomEvent: (t: string, p: unknown) => void }).addCustomEvent(
          tag,
          payload
        )
      )

      captureFn = async () => {
        // One clip per burst — a render-loop error must not mint dozens.
        if (state.lastClip && Date.now() - state.lastClip.at < CLIP_REUSE_MS) {
          return state.lastClip.link
        }
        state.lastClip = { at: Date.now(), link: null }
        const events = [...state.prevWindow, ...state.buffer]
        if (events.length === 0 || !client) return null
        const started = await client.request(
          startSessionRecording(appLabel ?? 'error-clip', undefined, true)
        )
        const id = started.data.id
        let clipSeq = 0
        await postEventChunks(client, id, () => clipSeq++, events)
        await client.request(endSessionRecording(id)).catch(() => {})
        const link: ErrorReplayLink = { recording_id: id, offset_ms: null }
        state.lastClip = { at: Date.now(), link }
        return link
      }
    }

    let fullMode = false
    async function start() {
      try {
        const modes = await client!.request(sessionRecordingEnabled())
        if (cancelled) return
        fullMode = modes.data.enabled === true
        const clipMode = !fullMode && modes.data.error_replay === true
        if (fullMode) await startFull()
        else if (clipMode) await startClip()
      } catch {
        /* recording is best-effort — never disturb the host app */
      }
    }

    void start()
    const timer = setInterval(scheduleFlush, FLUSH_MS)
    const onHide = () => {
      if (document.visibilityState === 'hidden') void flush(true, true)
    }
    document.addEventListener('visibilitychange', onHide)

    /**
     * The page is going away (reload, navigation, tab close). Queue the
     * buffer (≤10s of events) in keepalive-sized chunks — that also writes
     * them to IndexedDB — then send what fits in the keepalive allowance.
     * No end call: a reload in this tab continues this recording, and the
     * server already reads "live" off last_event_at. Without a keepalive
     * route (a client that doesn't expose its URL) the IndexedDB copy alone
     * carries the tail to the next load.
     */
    const onPageHide = () => {
      if (state.dead || !uploader.recordingId) return
      enqueueBuffer(true)
      saveResume()
      if (!isOnline() || !viaKeepalive) return
      for (const { chunk, body } of uploader.keepaliveBatch()) {
        try {
          void viaKeepalive(chunk.recordingId, body).catch(() => {})
        } catch {
          /* over the browser's keepalive allowance — the next load sends it */
        }
      }
    }
    window.addEventListener('pagehide', onPageHide)

    const onOnline = () => {
      clearRetry()
      void flush(true)
    }
    window.addEventListener('online', onOnline)

    return () => {
      cancelled = true
      captureFn = null
      document.removeEventListener('visibilitychange', onHide)
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('online', onOnline)
      clearInterval(timer)
      clearRetry()
      state.uninstrument?.()
      state.uninstrument = null
      state.stop?.()
      state.stop = null
      state.prevWindow = []
      // A real unmount — the host turned recording off or tore the provider
      // down — ends the recording: one last upload attempt, then end, and
      // nothing is left behind to retry or resume.
      void flush(true).then(() => {
        const id = uploader.recordingId
        if (!id) return
        if (!state.dead) void api.request(endSessionRecording(id)).catch(() => {})
        uploader.discard()
        uploader.recordingId = null
        clearResume(storage, RESUME_KEY)
      })
    }
  }, [client, disabled, appLabel])
}
