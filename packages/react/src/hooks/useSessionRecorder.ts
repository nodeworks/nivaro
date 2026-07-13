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
 * rrweb session recorder for headless frontends.
 *
 * Drop `useSessionRecorder({ app: 'customer-portal' })` anywhere inside a
 * NivaroProvider (or pass a client explicitly) and the app records itself —
 * ONLY when the Nivaro instance has session recording enabled in Settings,
 * and ONLY if the host app has `rrweb` installed (optional peer dependency;
 * without it the hook warns once and no-ops).
 *
 * Privacy defaults match the admin recorder: every input masked before
 * events leave the browser, elements with the `nvr-no-record` class blocked.
 * Events flush every 10s (or 150 events); the server enforces size caps and
 * a 7-day retention. Recordings attribute to the authenticated SDK identity
 * (usually your service token's user) with the `app` label telling replays
 * apart per frontend.
 */

export interface SessionRecorderOptions {
  /** Label shown in the admin replay list — which frontend this is. */
  app?: string
  /** Explicit client; defaults to the NivaroProvider context client. */
  client?: NivaroClient
  /** Force-disable locally regardless of the instance setting. */
  disabled?: boolean
}

const FLUSH_MS = 10_000
const FLUSH_COUNT = 150

let warnedMissingRrweb = false

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
  }>({ recordingId: null, buffer: [], seq: 0, stop: null, dead: false })

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

    async function start() {
      try {
        const enabled = await client!.request(sessionRecordingEnabled())
        if (cancelled || !enabled.data.enabled) return

        let record: typeof import('rrweb')['record'] | null = null
        try {
          record = (await import('rrweb')).record
        } catch {
          if (!warnedMissingRrweb) {
            warnedMissingRrweb = true
            console.warn(
              '[nivaro] session recording is enabled on the instance but `rrweb` is not installed in this app — run `npm i rrweb` to record.'
            )
          }
          return
        }
        if (cancelled || !record) return

        const started = await client!.request(startSessionRecording(appLabel))
        if (cancelled) return
        state.recordingId = started.data.id

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
      document.removeEventListener('visibilitychange', onHide)
      clearInterval(timer)
      state.stop?.()
      state.stop = null
      void flush().then(() => {
        if (client && state.recordingId) {
          void client.request(endSessionRecording(state.recordingId)).catch(() => {})
          state.recordingId = null
        }
      })
    }
  }, [client, disabled, appLabel])
}
