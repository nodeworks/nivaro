import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { registerStream, requestStreamStop, type StreamStopper } from './ai-stream-delivery.js'
import { parseRoom } from './chat.js'
import { tenantScopedRoom } from './tenant-rooms.js'

/**
 * The assistant's answer, token by token, in the room it was asked in
 * (#1810). One socket event, `chat:bot-stream`:
 *
 *   {stream_id, seq, room, asker, audience: 'room'|'private', phase, ...}
 *   phase start | delta {text, round} | status {text} | private | end | error
 *
 * Where it goes is decided BEFORE anything is sent: while every call behind
 * the answer is readable by the whole room (chat-bot-audience.ts) the events
 * go to the room's tenant-scoped socket room (and both DM participants);
 * once one is not, `private` tells the room the answer moved and every later
 * event goes to the asker's own sockets only. `seq` orders events and lets a
 * client that hears one twice drop the copy.
 *
 * Only the asker may stop it: POST /chat/bot/streams/:id/stop checks the
 * owner here (this node) or in Redis (another node), then raises the shared
 * stop flag the loop polls.
 */

const FLUSH_MS = 60
const OWNER_KEY = (id: string) => `nvr:chatbot:stream:${id}`
const OWNER_TTL_S = 900

type RedisLike = {
  get(k: string): Promise<string | null>
  set(...a: unknown[]): Promise<unknown>
  del(k: string): Promise<unknown>
}

const owners = new Map<string, string>()

export class BotStream {
  readonly id = randomUUID()
  private seq = 0
  private buffer = ''
  private bufferRound = 0
  private timer: NodeJS.Timeout | null = null
  private audience: 'room' | 'private' = 'room'
  private closed = false
  private readonly stopper: StreamStopper

  constructor(
    private readonly app: FastifyInstance,
    readonly room: string,
    readonly askerId: string
  ) {
    this.stopper = registerStream(app, this.id, askerId)
    owners.set(this.id, askerId.toUpperCase())
    const redis = (app as unknown as { redis?: RedisLike }).redis
    void redis?.set(OWNER_KEY(this.id), askerId.toUpperCase(), 'EX', OWNER_TTL_S).catch(() => {})
  }

  get isPrivate(): boolean {
    return this.audience === 'private'
  }

  stopped(): boolean {
    return this.stopper.stopped()
  }

  start(): void {
    this.send({ phase: 'start' })
  }

  delta(text: string, round: number): void {
    if (!text || this.closed) return
    if (round !== this.bufferRound) this.flush()
    this.bufferRound = round
    this.buffer += text
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), FLUSH_MS)
      this.timer.unref?.()
    }
  }

  status(text: string): void {
    this.flush()
    this.send({ phase: 'status', text })
  }

  /** From here on only the asker hears the answer; the room is told it moved. */
  goPrivate(): void {
    if (this.audience === 'private') return
    this.flush()
    // Said to the room (the asker's open tab is in it too); everything after
    // goes to the asker's sockets alone.
    this.send({ phase: 'private' })
    this.audience = 'private'
  }

  end(extra: Record<string, unknown> = {}): void {
    this.flush()
    this.send({ phase: 'end', ...extra })
    this.dispose()
  }

  error(message: string): void {
    this.flush()
    this.send({ phase: 'error', message })
    this.dispose()
  }

  private flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (!this.buffer) return
    const text = this.buffer
    this.buffer = ''
    this.send({ phase: 'delta', text, round: this.bufferRound })
  }

  private send(payload: Record<string, unknown>): void {
    if (this.closed) return
    const io = this.app.io
    if (!io) return
    const body = {
      stream_id: this.id,
      seq: ++this.seq,
      room: this.room,
      asker: this.askerId,
      audience: this.audience,
      ...payload
    }
    if (this.audience === 'private') {
      io.to(`user:${this.askerId}`).emit('chat:bot-stream', body)
      return
    }
    // One emit over every target room — socket.io sends a socket in several
    // of them the event once.
    let op = io.to(tenantScopedRoom(`chat:${this.room}`))
    const parsed = parseRoom(this.room)
    if (parsed.kind === 'dm') for (const p of parsed.participants ?? []) op = op.to(`user:${p}`)
    op.emit('chat:bot-stream', body)
  }

  private dispose(): void {
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.stopper.dispose()
    owners.delete(this.id)
    const redis = (this.app as unknown as { redis?: RedisLike }).redis
    void redis?.del(OWNER_KEY(this.id)).catch(() => {})
  }
}

/**
 * Stop a running answer for `userId`. 'forbidden' unless they asked it;
 * 'gone' when no node is running it any more.
 */
export async function stopBotStream(
  app: FastifyInstance,
  id: string,
  userId: string
): Promise<'stopped' | 'queued' | 'forbidden' | 'gone'> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return 'gone'
  let owner = owners.get(id) ?? null
  if (!owner) {
    const redis = (app as unknown as { redis?: RedisLike }).redis
    owner = redis ? await redis.get(OWNER_KEY(id)).catch(() => null) : null
  }
  if (!owner) return 'gone'
  if (owner !== userId.toUpperCase()) return 'forbidden'
  // Ownership is settled above (case-insensitively); the registry's own
  // check would compare raw id strings.
  return requestStreamStop(app, id, { id: userId, admin: true })
}

/** Test seam. */
export function activeBotStreams(): number {
  return owners.size
}
