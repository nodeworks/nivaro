import type { FastifyInstance } from 'fastify'
import type { Redis } from 'ioredis'
import type { DocumentProposal } from './document-autofill.js'

/**
 * Where a document proposal lives between the extraction and the form that
 * reviews it: Redis for 24 hours (a background run finishes after the tab
 * moved on; "New from document" in a list opens the form by id), with an
 * in-process map behind it so a dev box without Redis still works.
 */

const TTL_SECONDS = 24 * 60 * 60
const memory = new Map<string, { at: number; value: StoredProposal }>()

export type StoredProposal = {
  proposal: DocumentProposal | null
  status: 'running' | 'ready' | 'error'
  error?: string | null
  /** The asker left the page: tell them when the run lands (#760). */
  notify?: boolean
  user: string
  collection: string
  document_name: string
  created_at: string
}

function redisOf(app: FastifyInstance): Redis | null {
  return ((app as FastifyInstance & { redis?: Redis }).redis ?? null) as Redis | null
}

export async function saveProposal(
  app: FastifyInstance,
  id: string,
  value: StoredProposal
): Promise<void> {
  memory.set(id, { at: Date.now(), value })
  for (const [k, v] of memory) if (Date.now() - v.at > TTL_SECONDS * 1000) memory.delete(k)
  const redis = redisOf(app)
  if (!redis) return
  try {
    await redis.set(`nvr:autofill:${id}`, JSON.stringify(value), 'EX', TTL_SECONDS)
  } catch {
    // memory copy stands
  }
}

export async function loadProposal(
  app: FastifyInstance,
  id: string
): Promise<StoredProposal | null> {
  const redis = redisOf(app)
  if (redis) {
    try {
      const raw = await redis.get(`nvr:autofill:${id}`)
      if (raw) return JSON.parse(raw) as StoredProposal
    } catch {
      // fall through
    }
  }
  return memory.get(id)?.value ?? null
}
