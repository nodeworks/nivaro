import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { Redis } from 'ioredis'

/**
 * A file dropped on Ask AI (#1842): its extracted TEXT, kept for a day so
 * every question in the conversation can read it again by id. The file
 * itself is never stored — no nivaro_files row, nothing another person can
 * list or open — and only the person who attached it can name the id in a
 * question. Redis with an in-process map behind it, like the autofill store.
 */

const TTL_SECONDS = 24 * 60 * 60
const memory = new Map<string, { at: number; value: AskAttachment }>()

export interface AskAttachment {
  id: string
  user: string
  name: string
  text: string
  method: string
  pages: number | null
  truncated: boolean
  created_at: string
}

const sameId = (a: unknown, b: unknown) =>
  String(a ?? '').toUpperCase() === String(b ?? '').toUpperCase()

function redisOf(app: FastifyInstance): Redis | null {
  return ((app as FastifyInstance & { redis?: Redis }).redis ?? null) as Redis | null
}

export async function saveAskAttachment(
  app: FastifyInstance,
  input: Omit<AskAttachment, 'id' | 'created_at'>
): Promise<AskAttachment> {
  const value: AskAttachment = { ...input, id: randomUUID(), created_at: new Date().toISOString() }
  memory.set(value.id, { at: Date.now(), value })
  for (const [k, v] of memory) if (Date.now() - v.at > TTL_SECONDS * 1000) memory.delete(k)
  const redis = redisOf(app)
  if (redis) {
    try {
      await redis.set(`nvr:askdoc:${value.id}`, JSON.stringify(value), 'EX', TTL_SECONDS)
    } catch {
      // the memory copy stands
    }
  }
  return value
}

/** The attachment, only for the person who attached it (null otherwise). */
export async function loadAskAttachment(
  app: FastifyInstance,
  id: string,
  userId: string
): Promise<AskAttachment | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null
  let value: AskAttachment | null = null
  const redis = redisOf(app)
  if (redis) {
    try {
      const raw = await redis.get(`nvr:askdoc:${id}`)
      if (raw) value = JSON.parse(raw) as AskAttachment
    } catch {
      // fall through to memory
    }
  }
  value ??= memory.get(id)?.value ?? null
  return value && sameId(value.user, userId) ? value : null
}
