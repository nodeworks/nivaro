import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'

/**
 * rrweb session recorder — runs only when Settings enables session recording.
 *
 * Privacy defaults: every input masked, elements with .nvr-no-record blocked.
 * Events buffer client-side and flush every 10s (or 150 events); a full DOM
 * checkout every 60s keeps replays seekable. The server owns the size cap —
 * on 409/413 the recorder stops for the session.
 */

const FLUSH_MS = 10_000
const FLUSH_COUNT = 150

export function useSessionRecorder() {
  const { user } = useAuth()

  const { data: enabled } = useQuery({
    queryKey: ['session-recording-enabled'],
    queryFn: () =>
      api
        .get<{ data: { enabled: boolean } }>('/session-recordings/enabled')
        .then((r) => r.data.data.enabled),
    enabled: !!user,
    staleTime: 5 * 60_000,
    retry: false
  })

  const stateRef = useRef<{
    recordingId: string | null
    buffer: unknown[]
    seq: number
    stop: (() => void) | null
    dead: boolean
  }>({ recordingId: null, buffer: [], seq: 0, stop: null, dead: false })

  useEffect(() => {
    if (!enabled || !user) return
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
          // cap reached or closed — stop recording for this session
          state.dead = true
          state.stop?.()
        }
      }
    }

    async function start() {
      try {
        // Tell the server where this is happening — a replay list that cannot
        // distinguish production from a developer's laptop is hard to act on.
        const r = await api.post<{ data: { id: string } }>('/session-recordings/start', {
          origin: window.location.origin
        })
        if (cancelled) return
        state.recordingId = r.data.data.id
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
      } catch {
        /* recording is best-effort — never disturb the session */
      }
    }

    void start()
    const timer = setInterval(() => void flush(), FLUSH_MS)

    const onHide = () => {
      // last-gasp flush via beacon-ish fire and forget
      void flush()
    }
    document.addEventListener('visibilitychange', onHide)

    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onHide)
      clearInterval(timer)
      state.stop?.()
      state.stop = null
      void flush().then(() => {
        if (state.recordingId) {
          void api.post(`/session-recordings/${state.recordingId}/end`).catch(() => {})
          state.recordingId = null
        }
      })
    }
  }, [enabled, user])
}
