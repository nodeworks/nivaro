import {
  clipEndOffset,
  emitReplayTap,
  instrumentSocket,
  type ReplayClipKind,
  registerReplayCapture,
  setReplayRecorderMode
} from '@nivaro/shared'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { api, WORKSPACE_KEY } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useAutoRecordListener } from '@/lib/auto-record-listener'
import { readMasquerade } from '@/lib/masquerade'
import {
  backoffDelay,
  CHUNK_BYTES,
  type ChunkExtra,
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
} from '@/lib/replay-upload-queue'
import {
  instrumentConsole,
  instrumentRequests,
  redactSecrets
} from '../../../packages/shared/src/lib/replay-context'
import {
  buildReplayMaskingOptions,
  normalizeReplayMasking,
  type ReplayMaskingRules
} from '../../../packages/shared/src/lib/replay-masking'
import {
  attributeChunkRoutes,
  currentReplayRoute,
  isReplayRouteSampled,
  normalizeReplaySampling,
  type ReplaySampling,
  replaySampleDraw
} from '../../../packages/shared/src/lib/replay-sampling'

function clientMeta(): Record<string, string | number> {
  try {
    return {
      user_agent: navigator.userAgent,
      platform:
        (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform ??
        navigator.platform ??
        '',
      screen: `${window.screen?.width ?? 0}x${window.screen?.height ?? 0}`,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      dpr: window.devicePixelRatio ?? 1,
      language: navigator.language ?? '',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? ''
    }
  } catch {
    return {}
  }
}

/**
 * rrweb session recorder — two modes, one hook.
 *
 * FULL mode (`session_recording_enabled`): events stream to the server
 * continuously, through a queue that survives failures (#1369): chunks that
 * can't go now wait in IndexedDB and retry with backoff, a reload within ten
 * minutes continues the same recording, and pagehide sends the tail with
 * fetch keepalive. See replay-upload-queue.ts.
 *
 * ERROR-CLIP mode (`error_replay_enabled`, when full recording is off):
 * rrweb records into a rolling IN-MEMORY buffer — two 30s checkout windows,
 * so 30-60s of history — and uploads NOTHING. When an error is reported,
 * `captureErrorClip()` flushes the buffer as a short recording labelled
 * app='error-clip' and the issue row links to it. Support sees what the user
 * did in the minute before the crash without anyone recording all day.
 *
 * Privacy is identical in both modes: every input masked, .nvr-no-record
 * blocked, and record field values, rich text and file names masked by the
 * instance's masking rules (#1361, lib/replay-masking.ts) — an admin can
 * allow a safe field. In buffer mode the events never leave the browser
 * except on error.
 *
 * `captureErrorClip` is a module singleton (registerDmOpener precedent) so
 * the error boundary — a class component far from this hook — can call it.
 */

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
// Chunk sizing (CHUNK_BYTES, splitBySize) lives in replay-upload-queue.ts.

/** sessionStorage key for this tab's resumable recording (#1369). */
const RESUME_KEY = 'nvr_replay_resume'

const isOnline = () => typeof navigator === 'undefined' || navigator.onLine !== false

/**
 * POST one queued chunk. While the page is hidden (it may be unloading) a
 * small chunk rides fetch keepalive so it outlives the page. The admin API
 * authenticates by cookie, so a plain same-origin fetch carries the session;
 * recording never runs in a "View as" tab, so there is no bearer to add.
 */
async function sendChunk(
  recordingId: string,
  seq: number,
  events: unknown[],
  keepalive: boolean,
  extra: ChunkExtra = {}
): Promise<void> {
  if (!keepalive) {
    await api.post(`/session-recordings/${recordingId}/events`, { seq, events, ...extra })
    return
  }
  const res = await fetch(
    eventsUrl(recordingId),
    keepaliveInit(JSON.stringify({ seq, events, ...extra }))
  )
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status })
}

/** The build this bundle was made from — stamped on every chunk (#1368). */
const BUILD = typeof __NIVARO_ADMIN_BUILD__ === 'string' ? __NIVARO_ADMIN_BUILD__ : 'dev'

/** Fire-and-forget keepalive POST for pagehide; the IndexedDB copy is the net. */
function sendKeepalive(recordingId: string, body: string): void {
  try {
    void fetch(eventsUrl(recordingId), keepaliveInit(body)).catch(() => {})
  } catch {
    /* over the browser's keepalive allowance — the next load sends it */
  }
}

function eventsUrl(recordingId: string): string {
  return `/api/session-recordings/${recordingId}/events`
}

function keepaliveInit(body: string): RequestInit {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  try {
    const ws = localStorage.getItem(WORKSPACE_KEY)
    if (ws) headers['x-workspace'] = ws
  } catch {
    /* storage blocked — the events route is not workspace-scoped anyway */
  }
  return { method: 'POST', keepalive: true, credentials: 'include', headers, body }
}

/**
 * Upload events in size-bounded chunks, once — error-clip mode only. A 413
 * drops THAT chunk and keeps going (one lost snapshot beats a dead clip); a
 * 409 means the recording is closed or capped — stop for good. Full mode
 * goes through the resilient queue instead.
 */
async function postEventChunks(
  recordingId: string,
  nextSeq: () => number,
  events: unknown[],
  startRoute: string
): Promise<'ok' | 'closed'> {
  const chunks = splitBySize(events)
  const { routes } = attributeChunkRoutes(chunks, startRoute)
  for (const [i, chunk] of chunks.entries()) {
    const seq = nextSeq()
    try {
      await api.post(`/session-recordings/${recordingId}/events`, {
        seq,
        events: chunk,
        route: routes[i],
        build: BUILD
      })
    } catch (err) {
      const status = (err as { response?: { status?: number } }).response?.status
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

export interface ErrorReplayLink {
  recording_id: string
  /** Milliseconds into the recording where the error happened. Null for
   *  clips — the whole clip IS the error context. */
  offset_ms: number | null
}

type ClipCapture = (kind: ReplayClipKind) => Promise<ErrorReplayLink | null>
/** #1377 — take the moment now, upload on commit (see prepareReplayClip). */
type ClipSnapshot = (kind: ReplayClipKind) => (() => Promise<ErrorReplayLink | null>) | null
let snapshotFn: ClipSnapshot | null = null

let captureFn: ClipCapture | null = null

/**
 * Grab the replay link for an error being reported right now. Resolves null
 * when no recorder is active (both settings off, or recording failed) —
 * error reporting must never wait on or break because of replay capture.
 */
// Dev-only test handle — lets an automated browser exercise the capture path
// without needing to crash a real component.
if (import.meta.env.DEV && typeof window !== 'undefined') {
  ;(window as unknown as { __nvrCaptureErrorClip?: unknown }).__nvrCaptureErrorClip = () =>
    captureErrorClip()
}

export async function captureErrorClip(
  kind: ReplayClipKind = 'error'
): Promise<ErrorReplayLink | null> {
  if (!captureFn) return null
  try {
    return await Promise.race([
      captureFn(kind),
      // An error report should not stall behind a slow clip upload.
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000))
    ])
  } catch {
    return null
  }
}

// ── Replay context instrumentation ───────────────────────────────────────────
// Console lines, the page's requests (#1357) and route changes ride the
// recording as rrweb CUSTOM events (type 5), so the player can mark them on
// the scrubber and list console + network beside the replay. The console and
// request patches live in packages/shared (lib/replay-context.ts — one
// implementation for this recorder and @nivaro/react's): warn/error only, 200
// characters, token-shaped text redacted; requests as method, route pattern,
// status and duration, never bodies. Returns an undo that restores the globals.
function instrumentReplayContext(
  addCustomEvent: (tag: string, payload: unknown) => void,
  onRoute?: () => void
): () => void {
  const undoConsole = instrumentConsole(addCustomEvent)
  const undoRequests = instrumentRequests(addCustomEvent)
  const undoSocket = instrumentSocket(addCustomEvent)
  const routeEvent = () => {
    onRoute?.()
    try {
      // A query string can carry a reset or invite token — redact like the console.
      addCustomEvent('route', {
        path: redactSecrets(window.location.pathname + window.location.search)
      })
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
    undoConsole()
    undoRequests()
    undoSocket()
    history.pushState = origPush
    history.replaceState = origReplace
    window.removeEventListener('popstate', routeEvent)
  }
}

export function useSessionRecorder() {
  const { user } = useAuth()
  // #1371 — replay:record signals (rage click, monitor, breaker…).
  useAutoRecordListener()

  const { data: modes } = useQuery({
    queryKey: ['session-recording-enabled'],
    queryFn: () =>
      api
        .get<{
          data: {
            enabled: boolean
            error_replay?: boolean
            masking?: unknown
            sampling?: unknown
            cap_reached?: boolean
          }
        }>('/session-recordings/enabled')
        .then((r) => r.data.data),
    // Never record a "View as" tab — it would be filed under the other person.
    enabled: !!user && !readMasquerade(),
    staleTime: 5 * 60_000,
    retry: false
  })

  const stateRef = useRef<{
    // Full mode's recording id and seq live in its ReplayUploader.
    buffer: unknown[]
    stop: (() => void) | null
    uninstrument: (() => void) | null
    dead: boolean
    startedAt: number
    // Buffer mode: previous + current checkout windows.
    prevWindow: unknown[]
    lastClip: { at: number; link: ErrorReplayLink | null } | null
    lastNavAt: number
    inFlight: Promise<void> | null
    flushAfter: boolean
    // #1368 — route attribution and per-route sampling.
    /** Route pattern the tab is on now. */
    route: string
    /** Route in force at the buffer's first event. */
    bufferRoute: string
    /** Clip mode: route in force at the previous window's first event. */
    prevWindowRoute: string
    /** Is the current route sampled in? Events on a sampled-out route are dropped. */
    sampled: boolean
  }>({
    buffer: [],
    uninstrument: null,
    stop: null,
    dead: false,
    startedAt: 0,
    prevWindow: [],
    lastClip: null,
    lastNavAt: 0,
    inFlight: null,
    flushAfter: false,
    route: '/',
    bufferRoute: '/',
    prevWindowRoute: '/',
    sampled: true
  })

  // #1361 — read through a ref by rrweb's mask functions, so a rules change
  // (the query refetches) applies without restarting the recording.
  const maskingRef = useRef<ReplayMaskingRules>(normalizeReplayMasking(null))
  maskingRef.current = normalizeReplayMasking(modes?.masking)

  // #1368 — per-route sampling, read live like the masking rules.
  const samplingRef = useRef<ReplaySampling>(normalizeReplaySampling(null))
  samplingRef.current = normalizeReplaySampling(modes?.sampling)

  // Today's byte cap reached (#1368): nothing records until the server says
  // otherwise — not even clips, which it would refuse too.
  const capReached = modes?.cap_reached === true
  const fullMode = modes?.enabled === true && !capReached
  const clipMode = modes?.enabled !== true && modes?.error_replay === true && !capReached

  // ── Full recording ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!fullMode || !user) return
    let cancelled = false
    const state = stateRef.current
    state.dead = false
    const userId = user.id
    const storage = sessionStore()
    const store = sharedChunkStore()
    const uploader = new ReplayUploader({ store, send: sendChunk, online: isOnline })
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    /** Uploads wait until then after a transient failure (backoff). */
    let retryAt = 0
    /** Re-decides sampling on a route change (#1368); set once rrweb runs. */
    let onRouteSample = () => {}

    const quiet = () =>
      document.readyState === 'complete' && Date.now() - state.lastNavAt >= QUIET_MS

    /** Remember the recording for a reload in this tab (sessionStorage). */
    function saveResume() {
      if (!uploader.recordingId) return
      writeResume(storage, RESUME_KEY, {
        recordingId: uploader.recordingId,
        nextSeq: uploader.nextSeq,
        startedAt: state.startedAt,
        lastActivityAt: Date.now(),
        userId
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
      const chunks = splitBySize(events, hiding ? KEEPALIVE_CHUNK_BYTES : CHUNK_BYTES)
      // #1368 — each chunk is attributed to the route at its first event.
      const { routes } = attributeChunkRoutes(chunks, state.bufferRoute)
      for (const [i, chunk] of chunks.entries()) {
        uploader.enqueue(chunk, { route: routes[i], build: BUILD })
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
        // this user's). Start a fresh one and move this page's chunks —
        // the opening full snapshot among them — onto it.
        try {
          const r = await api.post<{ data: { id: string } }>('/session-recordings/start', {
            origin: window.location.origin,
            meta: clientMeta()
          })
          if (cancelled) return
          uploader.rebase(r.data.data.id)
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

    async function start() {
      try {
        void store.prune(Date.now() - ORPHAN_TTL_MS)
        // A reload in this tab within the resume window continues the same
        // recording: no /start, seq carries on, and whatever the previous
        // page could not upload goes first. If the server no longer takes
        // that id, the first upload answers 'stale' and a fresh recording
        // starts then (afterDrain).
        const saved = readResume(storage, RESUME_KEY)
        if (saved && isResumable(saved, Date.now(), userId)) {
          const restored = await store.list(saved.recordingId)
          if (cancelled) return
          uploader.begin(saved.recordingId, saved.nextSeq, { trusted: false, restored })
          state.startedAt = saved.startedAt
        } else {
          if (saved) {
            void store.clear(saved.recordingId)
            clearResume(storage, RESUME_KEY)
          }
          const r = await api.post<{ data: { id: string } }>('/session-recordings/start', {
            origin: window.location.origin,
            meta: clientMeta()
          })
          if (cancelled) return
          uploader.begin(r.data.data.id)
          state.startedAt = Date.now()
        }
        saveResume()
        state.lastNavAt = Date.now()
        const { record } = await import('rrweb')
        if (cancelled) return
        // #1368 — per-route sampling: one draw per tab session; events on a
        // sampled-out route are dropped, and coming back to a sampled route
        // takes a full snapshot so the replay resumes from a whole page.
        const draw = replaySampleDraw(storage)
        state.route = currentReplayRoute()
        state.bufferRoute = state.route
        state.sampled = isReplayRouteSampled(samplingRef.current, state.route, draw)
        onRouteSample = () => {
          state.route = currentReplayRoute()
          const was = state.sampled
          state.sampled = isReplayRouteSampled(samplingRef.current, state.route, draw)
          if (state.sampled && !was) {
            try {
              record.takeFullSnapshot(true)
            } catch {
              /* the next checkout snapshot covers it */
            }
          }
        }
        state.stop =
          record({
            emit(event) {
              if (!state.sampled) return
              if (state.buffer.length === 0) state.bufferRoute = state.route
              state.buffer.push(event)
              if (state.buffer.length >= FLUSH_COUNT) scheduleFlush()
            },
            ...buildReplayMaskingOptions(() => maskingRef.current),
            checkoutEveryNms: 60_000
          }) ?? null
        {
          const { record: rec } = await import('rrweb')
          state.uninstrument = instrumentReplayContext(
            (tag, payload) =>
              (
                rec as unknown as { addCustomEvent: (t: string, p: unknown) => void }
              ).addCustomEvent(tag, payload),
            () => {
              state.lastNavAt = Date.now()
              onRouteSample()
            }
          )
        }

        // A live full recording answers an error capture with itself + the
        // error's offset, after pushing whatever is still buffered.
        // (Queued chunks — this page's or a resumed page's — may still be on
        // their way; the link is valid either way and they land on retry.)
        captureFn = async () => {
          if (!uploader.recordingId) return null
          const offset = Date.now() - state.startedAt
          await flush(true).catch(() => {})
          if (!uploader.recordingId) return null
          return { recording_id: uploader.recordingId, offset_ms: offset }
        }
        setReplayRecorderMode('full')
        snapshotFn = () => {
          if (!uploader.recordingId) return null
          const offset = Date.now() - state.startedAt
          return async () => {
            await flush(true).catch(() => {})
            if (!uploader.recordingId) return null
            return { recording_id: uploader.recordingId, offset_ms: offset }
          }
        }
      } catch {
        /* recording is best-effort — never disturb the session */
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
     * No /end: a reload in this tab continues this recording, and the
     * server already reads "live" off last_event_at.
     */
    const onPageHide = () => {
      if (state.dead || !uploader.recordingId) return
      enqueueBuffer(true)
      saveResume()
      if (!isOnline()) return
      for (const { chunk, body } of uploader.keepaliveBatch()) {
        sendKeepalive(chunk.recordingId, body)
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
      snapshotFn = null
      setReplayRecorderMode(null)
      document.removeEventListener('visibilitychange', onHide)
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('online', onOnline)
      clearInterval(timer)
      clearRetry()
      state.uninstrument?.()
      state.uninstrument = null
      state.stop?.()
      state.stop = null
      // A real unmount — signed out, recording switched off — ends the
      // recording: one last upload attempt, then /end, and nothing is left
      // behind to retry or resume.
      void flush(true).then(() => {
        const id = uploader.recordingId
        if (!id) return
        if (!state.dead) void api.post(`/session-recordings/${id}/end`).catch(() => {})
        uploader.discard()
        uploader.recordingId = null
        clearResume(storage, RESUME_KEY)
      })
    }
  }, [fullMode, user])

  // ── Error-clip buffer mode ───────────────────────────────────────────────
  useEffect(() => {
    if (!clipMode || !user) return
    let cancelled = false
    const state = stateRef.current

    async function start() {
      try {
        const { record } = await import('rrweb')
        if (cancelled) return
        state.buffer = []
        state.prevWindow = []
        state.route = currentReplayRoute()
        state.bufferRoute = state.route
        state.prevWindowRoute = state.route
        state.stop =
          record({
            emit(event, isCheckout) {
              emitReplayTap(event) // #1371 — an auto recording rides the buffer
              if (isCheckout) {
                // A checkout event is a full DOM snapshot — it starts a
                // self-sufficient window, so the one before last can drop.
                state.prevWindow = state.buffer
                state.prevWindowRoute = state.bufferRoute
                state.buffer = [event]
                state.bufferRoute = state.route
              } else {
                state.buffer.push(event)
              }
            },
            ...buildReplayMaskingOptions(() => maskingRef.current),
            checkoutEveryNms: CLIP_WINDOW_MS
          }) ?? null
        {
          const { record: rec } = await import('rrweb')
          state.uninstrument = instrumentReplayContext(
            (tag, payload) =>
              (
                rec as unknown as { addCustomEvent: (t: string, p: unknown) => void }
              ).addCustomEvent(tag, payload),
            () => {
              state.route = currentReplayRoute()
            }
          )
        }

        setReplayRecorderMode('clip')
        // #1377 — the buffer as it is NOW; nothing uploads until commit.
        snapshotFn = (kind) => {
          const events = [...state.prevWindow, ...state.buffer]
          const startRoute = state.prevWindow.length > 0 ? state.prevWindowRoute : state.bufferRoute
          if (events.length === 0) return null
          const offset = clipEndOffset(events, kind)
          return async () => {
            const r = await api.post<{ data: { id: string } }>('/session-recordings/start', {
              clip: true,
              clip_kind: kind,
              origin: window.location.origin,
              meta: clientMeta()
            })
            const id = r.data.data.id
            let clipSeq = 0
            await postEventChunks(id, () => clipSeq++, events, startRoute)
            await api.post(`/session-recordings/${id}/end`).catch(() => {})
            return { recording_id: id, offset_ms: offset }
          }
        }
        captureFn = async (kind) => {
          // One error clip per burst — a render-loop error must not mint dozens.
          if (kind === 'error') {
            if (state.lastClip && Date.now() - state.lastClip.at < CLIP_REUSE_MS) {
              return state.lastClip.link
            }
            state.lastClip = { at: Date.now(), link: null }
          }
          const upload = snapshotFn?.(kind)
          if (!upload) return null
          const link = await upload()
          if (kind === 'error') state.lastClip = { at: Date.now(), link }
          return link
        }
      } catch {
        /* best-effort */
      }
    }

    void start()
    return () => {
      cancelled = true
      captureFn = null
      snapshotFn = null
      setReplayRecorderMode(null)
      state.uninstrument?.()
      state.uninstrument = null
      state.stop?.()
      state.stop = null
      state.buffer = []
      state.prevWindow = []
    }
  }, [clipMode, user])
}

// #1370 — shared surfaces (reportClientCrash, the support dialog, Report a
// problem) reach this recorder through the shared registry, never by
// importing the host.
registerReplayCapture(
  (kind) => captureErrorClip(kind),
  (kind) => snapshotFn?.(kind) ?? null
)
