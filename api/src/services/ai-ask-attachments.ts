import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { Redis } from 'ioredis'
import { currentTenantKey } from './tenant-rooms.js'

/**
 * A file dropped on Ask AI (#1842): its extracted TEXT, kept for a day so
 * every question in the conversation can read it again by id. The file
 * itself is never stored — no nivaro_files row, nothing another person can
 * list or open — and only the person who attached it can name the id in a
 * question. Redis when there is one; an in-process map (capped by entries
 * and characters) only when there is not.
 */

const TTL_SECONDS = 24 * 60 * 60
const MEMORY_MAX_ENTRIES = 200
const MEMORY_MAX_CHARS = 20_000_000
const memory = new Map<string, { at: number; value: AskAttachment }>()

/** Uploads per person per window (#1842 S2). */
export const UPLOADS_PER_WINDOW = 10
export const UPLOAD_WINDOW_SECONDS = 5 * 60
const uploadHits = new Map<string, { start: number; count: number }>()

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

/** Keep the memory fallback inside its caps: expired first, then oldest. */
function pruneMemory(): void {
  const now = Date.now()
  for (const [k, v] of memory) if (now - v.at > TTL_SECONDS * 1000) memory.delete(k)
  let chars = 0
  for (const v of memory.values()) chars += v.value.text.length
  for (const [k, v] of memory) {
    if (memory.size <= MEMORY_MAX_ENTRIES && chars <= MEMORY_MAX_CHARS) break
    chars -= v.value.text.length
    memory.delete(k)
  }
}

/** Test seam. */
export function clearAskAttachmentMemory(): void {
  memory.clear()
  uploadHits.clear()
}

/**
 * Count one upload for `userId`; false once they used UPLOADS_PER_WINDOW in
 * the current window. Redis-backed (shared by every instance) with an
 * in-process fallback keyed by tenant.
 */
export async function takeUploadSlot(app: FastifyInstance, userId: string): Promise<boolean> {
  const key = `${currentTenantKey()}:${String(userId).toUpperCase()}`
  const redis = redisOf(app)
  if (redis) {
    try {
      const rk = `nvr:askdoc:rate:${key}`
      const n = await redis.incr(rk)
      if (n === 1) await redis.expire(rk, UPLOAD_WINDOW_SECONDS)
      return n <= UPLOADS_PER_WINDOW
    } catch {
      // fall through to the in-process count
    }
  }
  const now = Date.now()
  const hit = uploadHits.get(key)
  if (!hit || now - hit.start > UPLOAD_WINDOW_SECONDS * 1000) {
    uploadHits.set(key, { start: now, count: 1 })
    return true
  }
  hit.count++
  return hit.count <= UPLOADS_PER_WINDOW
}

export async function saveAskAttachment(
  app: FastifyInstance,
  input: Omit<AskAttachment, 'id' | 'created_at'>
): Promise<AskAttachment> {
  const value: AskAttachment = { ...input, id: randomUUID(), created_at: new Date().toISOString() }
  const redis = redisOf(app)
  if (redis) {
    try {
      await redis.set(`nvr:askdoc:${value.id}`, JSON.stringify(value), 'EX', TTL_SECONDS)
      return value
    } catch {
      // Redis is down: the memory copy stands in
    }
  }
  memory.set(value.id, { at: Date.now(), value })
  pruneMemory()
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
