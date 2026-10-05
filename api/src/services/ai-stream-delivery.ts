import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Server as SocketIOServer } from 'socket.io'

/**
 * How a streamed AI answer reaches the caller (#688). Two transports carry
 * the same four events — `ai:delta {stream_id, text, round}`, `ai:status
 * {stream_id, text, round, tool}`, `ai:done {stream_id, ...body}` and
 * `ai:error {stream_id, message}`:
 *
 *   socket  the route answers 202 {data: {stream_id}} at once and emits the
 *           events to the caller's `user:<id>` room (every tab of theirs)
 *   sse     the route holds the request open as text/event-stream (widgets
 *           and hosts without the socket; `Accept: text/event-stream`)
 *
 * A stream is registered while it runs so `POST /ai/chat/:stream_id/stop`
 * can halt it: locally by the registered abort, from another node through a
 * Redis flag the loop polls.
 */

export type StreamEvent = 'ai:delta' | 'ai:status'

export interface StreamDelivery {
  id: string
  mode: 'socket' | 'sse'
  emit(event: StreamEvent, payload: Record<string, unknown>): void
  done(body: Record<string, unknown>): void
  error(message: string): void
}

export function pickStreamMode(req: FastifyRequest): 'socket' | 'sse' | null {
  const body = (req.body ?? {}) as { stream?: unknown }
  if (body.stream !== true) return null
  const accept = String(req.headers.accept ?? '')
  return /text\/event-stream/i.test(accept) ? 'sse' : 'socket'
}

/** Is any socket of this user connected (this node first, then the
 *  cluster through the adapter)? False means the caller cannot hear the
 *  events and the route should answer the plain way. */
export async function userHasSocket(
  io: SocketIOServer | undefined,
  userId: string
): Promise<boolean> {
  if (!io) return false
  const room = `user:${userId}`
  if ((io.sockets.adapter.rooms.get(room)?.size ?? 0) > 0) return true
  try {
    const sockets = await Promise.race([
      io.in(room).fetchSockets(),
      new Promise<never[]>((resolve) => setTimeout(() => resolve([]), 1500))
    ])
    return sockets.length > 0
  } catch {
    return false
  }
}

export function socketDelivery(
  io: SocketIOServer,
  userId: string,
  id = randomUUID()
): StreamDelivery {
  const room = `user:${userId}`
  return {
    id,
    mode: 'socket',
    emit: (event, payload) => io.to(room).emit(event, { stream_id: id, ...payload }),
    done: (body) => io.to(room).emit('ai:done', { stream_id: id, ...body }),
    error: (message) => io.to(room).emit('ai:error', { stream_id: id, message })
  }
}

/** Hijack the reply as an SSE response; `done`/`error` end it. */
export function sseDelivery(
  req: FastifyRequest,
  reply: FastifyReply,
  id = randomUUID()
): StreamDelivery {
  reply.hijack()
  const raw = reply.raw
  raw.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
  })
  raw.write(`: stream ${id}\n\n`)
  let closed = false
  const write = (event: string, payload: Record<string, unknown>) => {
    if (closed) return
    try {
      raw.write(`event: ${event}\ndata: ${JSON.stringify({ stream_id: id, ...payload })}\n\n`)
    } catch {
      closed = true
    }
  }
  const end = () => {
    if (closed) return
    closed = true
    try {
      raw.end()
    } catch {
      /* already gone */
    }
  }
  req.raw.on('close', () => {
    closed = true
  })
  return {
    id,
    mode: 'sse',
    emit: write,
    done: (body) => {
      write('ai:done', body)
      end()
    },
    error: (message) => {
      write('ai:error', { message })
      end()
    }
  }
}

// ─── stop registry ───────────────────────────────────────────────────────────

const active = new Map<string, { userId: string; stop: () => void }>()
const STOP_KEY = (id: string) => `nvr:aistop:${id}`
const STOP_TTL_S = 600
const POLL_MS = 1000

type RedisLike = { get(k: string): Promise<string | null>; set(...a: unknown[]): Promise<unknown> }

export interface StreamStopper {
  stopped(): boolean
  dispose(): void
}

/** Register a running stream; the returned stopper is what the loop polls.
 *  Redis is polled once a second so a stop issued on another node lands. */
export function registerStream(app: FastifyInstance, id: string, userId: string): StreamStopper {
  let flag = false
  const redis = (app as unknown as { redis?: RedisLike }).redis
  active.set(id, {
    userId,
    stop: () => {
      flag = true
    }
  })
  let timer: NodeJS.Timeout | null = null
  if (redis) {
    timer = setInterval(() => {
      if (flag) return
      redis
        .get(STOP_KEY(id))
        .then((v) => {
          if (v) flag = true
        })
        .catch(() => undefined)
    }, POLL_MS)
    timer.unref()
  }
  return {
    stopped: () => flag,
    dispose: () => {
      active.delete(id)
      if (timer) clearInterval(timer)
    }
  }
}

/** Stop a stream by id — the caller's own, or anyone's for an admin.
 *  'queued' = not on this node; the Redis flag reaches it within a second. */
export async function requestStreamStop(
  app: FastifyInstance,
  id: string,
  user: { id: string; admin: boolean }
): Promise<'stopped' | 'queued' | 'forbidden'> {
  const local = active.get(id)
  if (local) {
    if (local.userId !== user.id && !user.admin) return 'forbidden'
    local.stop()
    return 'stopped'
  }
  const redis = (app as unknown as { redis?: RedisLike }).redis
  if (redis) {
    // the owner is not knowable from here; the flag only halts a stream that
    // is still running, and an id is a uuid nobody can guess
    await redis.set(STOP_KEY(id), user.id, 'EX', STOP_TTL_S).catch(() => undefined)
  }
  return 'queued'
}

/** For tests and the ops view: how many streams this node is running. */
export function activeStreamCount(): number {
  return active.size
}
