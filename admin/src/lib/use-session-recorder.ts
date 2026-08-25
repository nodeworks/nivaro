import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'

/**
 * rrweb session recorder — two modes, one hook.
 *
 * FULL mode (`session_recording_enabled`): events stream to the server
 * continuously, exactly as before.
 *
 * ERROR-CLIP mode (`error_replay_enabled`, when full recording is off):
 * rrweb records into a rolling IN-MEMORY buffer — two 30s checkout windows,
 * so 30-60s of history — and uploads NOTHING. When an error is reported,
 * `captureErrorClip()` flushes the buffer as a short recording labelled
 * app='error-clip' and the issue row links to it. Support sees what the user
 * did in the minute before the crash without anyone recording all day.
 *
 * Privacy is identical in both modes: every input masked, .nvr-no-record
 * blocked. In buffer mode the events never leave the browser except on error.
 *
 * `captureErrorClip` is a module singleton (registerDmOpener precedent) so
 * the error boundary — a class component far from this hook — can call it.
 */

const FLUSH_MS = 10_000
const FLUSH_COUNT = 150
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

type ClipCapture = () => Promise<ErrorReplayLink | null>

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

export async function captureErrorClip(): Promise<ErrorReplayLink | null> {
  if (!captureFn) return null
  try {
    return await Promise.race([
      captureFn(),
      // An error report should not stall behind a slow clip upload.
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000))
    ])
  } catch {
    return null
  }
}


// ── Replay context instrumentation ───────────────────────────────────────────
// Console lines + route changes ride the recording as rrweb CUSTOM events
// (type 5), so the player can mark them on the scrubber and show the user's
// console next to the replay. Capped so a render-loop error flood can't bloat
// the recording; console.log deliberately excluded (noise) — info/warn/error
// only. Returns an undo function that restores the patched globals.
function instrumentReplayContext(
  addCustomEvent: (tag: string, payload: unknown) => void
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

export function useSessionRecorder() {
  const { user } = useAuth()

  const { data: modes } = useQuery({
    queryKey: ['session-recording-enabled'],
    queryFn: () =>
      api
        .get<{ data: { enabled: boolean; error_replay?: boolean } }>('/session-recordings/enabled')
        .then((r) => r.data.data),
    enabled: !!user,
    staleTime: 5 * 60_000,
    retry: false
  })

  const stateRef = useRef<{
    recordingId: string | null
    buffer: unknown[]
    seq: number
    stop: (() => void) | null
    uninstrument: (() => void) | null
    dead: boolean
    startedAt: number
    // Buffer mode: previous + current checkout windows.
    prevWindow: unknown[]
    lastClip: { at: number; link: ErrorReplayLink | null } | null
  }>({
    recordingId: null,
    buffer: [],
    uninstrument: null,
    seq: 0,
    stop: null,
    dead: false,
    startedAt: 0,
    prevWindow: [],
    lastClip: null
  })

  const fullMode = modes?.enabled === true
  const clipMode = !fullMode && modes?.error_replay === true

  // ── Full recording (unchanged behaviour) ─────────────────────────────────
  useEffect(() => {
    if (!fullMode || !user) return
    let cancelled = false
    const state = stateRef.current
    state.dead = false

    async function flush() {
      if (state.dead || !state.recordingId || state.buffer.length === 0) return
      const events = state.buffer
      state.buffer = []
      const seq = state.seq++
      try {
        await api.post(`/session-recordings/${state.recordingId}/events`, { seq, events })
      } catch (err) {
        const status = (err as { response?: { status?: number } }).response?.status
        if (status === 409 || status === 413) {
          state.dead = true
          state.stop?.()
        }
      }
    }

    async function start() {
      try {
        const r = await api.post<{ data: { id: string } }>('/session-recordings/start', {
          origin: window.location.origin
        })
        if (cancelled) return
        state.recordingId = r.data.data.id
        state.startedAt = Date.now()
        const { record } = await import('rrweb')
        if (cancelled) return
        state.stop =
          record({
            emit(event) {
              state.buffer.push(event)
              if (state.buffer.length >= FLUSH_COUNT) void flush()
            },
            maskAllInputs: true,
            blockClass: 'nvr-no-record',
            checkoutEveryNms: 60_000
          }) ?? null
        {
          const { record: rec } = await import('rrweb')
          state.uninstrument = instrumentReplayContext((tag, payload) =>
            (rec as unknown as { addCustomEvent: (t: string, p: unknown) => void }).addCustomEvent(tag, payload)
          )
        }

        // A live full recording answers an error capture with itself + the
        // error's offset, after pushing whatever is still buffered.
        captureFn = async () => {
          if (!state.recordingId) return null
          const offset = Date.now() - state.startedAt
          await flush().catch(() => {})
          return { recording_id: state.recordingId, offset_ms: offset }
        }
      } catch {
        /* recording is best-effort — never disturb the session */
      }
    }

    void start()
    const timer = setInterval(() => void flush(), FLUSH_MS)

    const onHide = () => {
      void flush()
    }
    document.addEventListener('visibilitychange', onHide)

    return () => {
      cancelled = true
      captureFn = null
      document.removeEventListener('visibilitychange', onHide)
      clearInterval(timer)
      state.uninstrument?.()
      state.uninstrument = null
      state.stop?.()
      state.stop = null
      void flush().then(() => {
        if (state.recordingId) {
          void api.post(`/session-recordings/${state.recordingId}/end`).catch(() => {})
          state.recordingId = null
        }
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
        state.stop =
          record({
            emit(event, isCheckout) {
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
        {
          const { record: rec } = await import('rrweb')
          state.uninstrument = instrumentReplayContext((tag, payload) =>
            (rec as unknown as { addCustomEvent: (t: string, p: unknown) => void }).addCustomEvent(tag, payload)
          )
        }

        captureFn = async () => {
          // One clip per burst — a render-loop error must not mint dozens.
          if (state.lastClip && Date.now() - state.lastClip.at < CLIP_REUSE_MS) {
            return state.lastClip.link
          }
          state.lastClip = { at: Date.now(), link: null }
          const events = [...state.prevWindow, ...state.buffer]
          if (events.length === 0) return null
          const r = await api.post<{ data: { id: string } }>('/session-recordings/start', {
            clip: true,
            origin: window.location.origin
          })
          const id = r.data.data.id
          await api.post(`/session-recordings/${id}/events`, { seq: 0, events })
          await api.post(`/session-recordings/${id}/end`).catch(() => {})
          const link: ErrorReplayLink = { recording_id: id, offset_ms: null }
          state.lastClip = { at: Date.now(), link }
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
      state.uninstrument?.()
      state.uninstrument = null
      state.stop?.()
      state.stop = null
      state.buffer = []
      state.prevWindow = []
    }
  }, [clipMode, user])
}
