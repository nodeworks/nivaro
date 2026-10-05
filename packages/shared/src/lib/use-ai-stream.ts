import type { NivaroClient } from '@nivaro/sdk'
import { useCallback, useEffect, useRef, useState } from 'react'
import { post } from './commands'

/**
 * A streamed AI answer on the client (#688). Socket-agnostic: the host hands
 * in `subscribe(event, handler)` for its own transport (admin: the shared
 * admin socket; a headless host: its socket, or an EventSource over the SSE
 * form). The hook POSTs with `stream: true`, pairs the events to the
 * stream id the 202 answered with — events that race ahead of that answer
 * are buffered — and keeps the growing text, the status line and the
 * narration (a tool round's own words) as state, flushed once per frame.
 *
 * A reply that comes back WHOLE (the server had no socket for the caller,
 * or `stream` was not honoured) is handed to `onDone` straight away, so a
 * caller never branches on the transport.
 */

export type AiStreamSubscribe = (
  event: 'ai:delta' | 'ai:status' | 'ai:done' | 'ai:error',
  handler: (payload: Record<string, unknown>) => void
) => () => void

export interface AiStreamHandlers<TDone = Record<string, unknown>> {
  onDelta?: (text: string, round: number) => void
  onStatus?: (status: { text: string; round: number; tool?: string }) => void
  /** The finished body — the same `data` object a plain reply carries. */
  onDone?: (body: TDone) => void
  onError?: (message: string) => void
}

export interface AiStreamOptions<TDone> extends AiStreamHandlers<TDone> {
  subscribe: AiStreamSubscribe
  /** Is the transport up right now? False = POST without `stream`. */
  connected?: () => boolean
}

export interface AiStreamState {
  active: boolean
  streamId: string | null
  /** The current round's text, as it arrives. */
  text: string
  /** The latest tool status line, while tools run. */
  status: string | null
  /** A tool round's own words, kept muted above the status. */
  narration: string
}

export interface AiStreamHandle<TDone> extends AiStreamState {
  /** POST `body` to `path` (default /ai/chat) and follow the stream. */
  start: (body: Record<string, unknown>, path?: string) => Promise<void>
  /** Best effort: tell the server to halt the current stream. */
  stop: () => Promise<void>
  /** Reset the visible state (after the host rendered the done body). */
  reset: () => void
  /** The last finished body, for hosts that prefer polling to callbacks. */
  last: TDone | null
}

const BUFFER_CAP = 500
const BUFFER_TTL_MS = 30_000

type Buffered = { event: string; payload: Record<string, unknown>; at: number }

const EMPTY: AiStreamState = {
  active: false,
  streamId: null,
  text: '',
  status: null,
  narration: ''
}

export function useAiStream<TDone = Record<string, unknown>>(
  client: NivaroClient,
  opts: AiStreamOptions<TDone>
): AiStreamHandle<TDone> {
  const [state, setState] = useState<AiStreamState>(EMPTY)
  const [last, setLast] = useState<TDone | null>(null)
  const handlers = useRef(opts)
  handlers.current = opts
  const idRef = useRef<string | null>(null)
  const pendingRef = useRef(false)
  const buffer = useRef<Buffered[]>([])
  const draft = useRef({ text: '', round: -1, narration: '', status: null as string | null })
  const frame = useRef<number | null>(null)

  const flush = useCallback(() => {
    frame.current = null
    const d = draft.current
    setState((s) => ({ ...s, text: d.text, narration: d.narration, status: d.status }))
  }, [])
  const schedule = useCallback(() => {
    if (frame.current != null) return
    if (typeof requestAnimationFrame === 'function') frame.current = requestAnimationFrame(flush)
    else frame.current = setTimeout(flush, 16) as unknown as number
  }, [flush])

  const finish = useCallback((body: TDone | null, error: string | null) => {
    idRef.current = null
    pendingRef.current = false
    if (frame.current != null && typeof cancelAnimationFrame === 'function')
      cancelAnimationFrame(frame.current)
    frame.current = null
    draft.current = { text: '', round: -1, narration: '', status: null }
    setState({ ...EMPTY })
    if (error) handlers.current.onError?.(error)
    else if (body) {
      setLast(body)
      handlers.current.onDone?.(body)
    }
  }, [])

  const handle = useCallback(
    (event: string, payload: Record<string, unknown>) => {
      const d = draft.current
      if (event === 'ai:delta') {
        const text = String(payload.text ?? '')
        const round = Number(payload.round ?? 0)
        if (round !== d.round) {
          // a new round: what the previous one said was narration
          if (d.text.trim()) d.narration = d.text.trim()
          d.text = ''
          d.round = round
        }
        d.text += text
        handlers.current.onDelta?.(text, round)
        schedule()
      } else if (event === 'ai:status') {
        const text = String(payload.text ?? '')
        const round = Number(payload.round ?? 0)
        if (d.text.trim()) d.narration = d.text.trim()
        d.text = ''
        d.status = text
        handlers.current.onStatus?.({
          text,
          round,
          tool: typeof payload.tool === 'string' ? payload.tool : undefined
        })
        schedule()
      } else if (event === 'ai:done') {
        const { stream_id: _id, ...rest } = payload
        const body = ((rest as { data?: unknown }).data ?? rest) as TDone
        finish(body, null)
      } else if (event === 'ai:error') {
        finish(null, String(payload.message ?? 'AI request failed'))
      }
    },
    [finish, schedule]
  )

  // Subscribe for the hook's whole life: the first delta can land before
  // the 202 does, so events for an unknown stream wait in the buffer.
  useEffect(() => {
    const sub = handlers.current.subscribe
    const events = ['ai:delta', 'ai:status', 'ai:done', 'ai:error'] as const
    const offs = events.map((ev) =>
      sub(ev, (payload) => {
        const id = typeof payload.stream_id === 'string' ? payload.stream_id : null
        if (!id) return
        if (idRef.current === id) {
          handle(ev, payload)
          return
        }
        if (!pendingRef.current) return
        const now = Date.now()
        const buf = buffer.current.filter((b) => now - b.at < BUFFER_TTL_MS)
        buf.push({ event: ev, payload, at: now })
        buffer.current = buf.slice(-BUFFER_CAP)
      })
    )
    return () => {
      for (const off of offs) off()
    }
  }, [handle])

  const start = useCallback(
    async (body: Record<string, unknown>, path = '/ai/chat') => {
      const connected = handlers.current.connected?.() ?? true
      pendingRef.current = connected
      buffer.current = []
      draft.current = { text: '', round: -1, narration: '', status: null }
      setState({ ...EMPTY, active: true })
      let res: Record<string, unknown>
      try {
        res = (await client.request(
          post<Record<string, unknown>>(path, connected ? { ...body, stream: true } : body)
        )) as Record<string, unknown>
      } catch (err) {
        finish(null, (err as Error)?.message || 'AI request failed')
        return
      }
      const data = (res.data ?? res) as Record<string, unknown>
      const id = typeof data.stream_id === 'string' ? data.stream_id : null
      if (!id) {
        // answered whole
        finish(data as TDone, null)
        return
      }
      idRef.current = id
      pendingRef.current = false
      setState((s) => ({ ...s, streamId: id }))
      const replay = buffer.current.filter((b) => b.payload.stream_id === id)
      buffer.current = []
      for (const b of replay) {
        if (idRef.current !== id) break
        handle(b.event, b.payload)
      }
    },
    [client, finish, handle]
  )

  const stop = useCallback(async () => {
    const id = idRef.current
    if (!id) return
    try {
      await client.request(post(`/ai/chat/${id}/stop`))
    } catch {
      /* the stream ends on its own; nothing to do */
    }
  }, [client])

  const reset = useCallback(() => {
    setLast(null)
    setState({ ...EMPTY })
  }, [])

  return { ...state, start, stop, reset, last }
}
