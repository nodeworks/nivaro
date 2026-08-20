import type { NivaroClient } from '@nivaro/sdk'
import {
  appendSessionRecordingEvents,
  endSessionRecording,
  sessionRecordingEnabled,
  startSessionRecording
} from '@nivaro/sdk'
import { useEffect, useRef } from 'react'
import { useOptionalNivaroClient } from '../context'

/**
 * rrweb session recorder for headless frontends — two modes, one hook
 * (the exact model the admin app runs; see admin/src/lib/use-session-recorder.ts).
 *
 * FULL mode (`session_recording_enabled` on the instance): events stream to
 * the server continuously.
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

export function useSessionRecorder(options: SessionRecorderOptions = {}) {
  const contextClient = useOptionalNivaroClient()
  const client = options.client ?? contextClient
  const appLabel = options.app
  const disabled = options.disabled ?? false

  const stateRef = useRef<{
    recordingId: string | null
    buffer: unknown[]
    seq: number
    stop: (() => void) | null
    dead: boolean
    startedAt: number
    prevWindow: unknown[]
    lastClip: { at: number; link: ErrorReplayLink | null } | null
  }>({
    recordingId: null,
    buffer: [],
    seq: 0,
    stop: null,
    dead: false,
    startedAt: 0,
    prevWindow: [],
    lastClip: null
  })

  useEffect(() => {
    if (!client || disabled || typeof window === 'undefined') return
    let cancelled = false
    const state = stateRef.current
    state.dead = false

    async function flush() {
      if (!client || state.dead || !state.recordingId || state.buffer.length === 0) return
      const events = state.buffer
      state.buffer = []
      const seq = state.seq++
      try {
        await client.request(appendSessionRecordingEvents(state.recordingId, seq, events))
      } catch (err) {
        const status =
          (err as { status?: number; response?: { status?: number } }).status ??
          (err as { response?: { status?: number } }).response?.status
        if (status === 409 || status === 413) {
          state.dead = true
          state.stop?.()
        }
      }
    }

    async function startFull() {
      const record = await loadRrweb()
      if (cancelled || !record) return
      const started = await client!.request(startSessionRecording(appLabel))
      if (cancelled) return
      state.recordingId = started.data.id
      state.startedAt = Date.now()
      state.stop =
        record({
          emit(event: unknown) {
            state.buffer.push(event)
            if (state.buffer.length >= FLUSH_COUNT) void flush()
          },
          maskAllInputs: true,
          blockClass: 'nvr-no-record',
          checkoutEveryNms: 60_000
        }) ?? null
      // A live full recording answers an error capture with itself + the
      // error's offset, after pushing whatever is still buffered.
      captureFn = async () => {
        if (!state.recordingId) return null
        const offset = Date.now() - state.startedAt
        await flush().catch(() => {})
        return { recording_id: state.recordingId, offset_ms: offset }
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
        await client.request(appendSessionRecordingEvents(id, 0, events))
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
    const timer = setInterval(() => void flush(), FLUSH_MS)
    const onHide = () => void flush()
    document.addEventListener('visibilitychange', onHide)

    return () => {
      cancelled = true
      captureFn = null
      document.removeEventListener('visibilitychange', onHide)
      clearInterval(timer)
      state.stop?.()
      state.stop = null
      state.prevWindow = []
      void flush().then(() => {
        if (client && state.recordingId) {
          void client.request(endSessionRecording(state.recordingId)).catch(() => {})
          state.recordingId = null
        }
      })
    }
  }, [client, disabled, appLabel])
}
