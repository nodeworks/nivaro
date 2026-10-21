import { createHash } from 'node:crypto'
import type { Redis } from 'ioredis'
import { onConfigWrite } from '../db/config-epoch.js'
import { onOwnersChanged } from '../db/owner-signal.js'
import { registerCache } from './cache-registry.js'
import { onCollectionTouched, onItemEvent } from './item-events.js'
import { currentTenantKey } from './tenant-rooms.js'

/**
 * Reuse tool results within a conversation (#2737). Ask AI keeps what each
 * read tool returned, keyed by tool + normalized arguments + asker, for the
 * life of the conversation, so a follow-up that needs the same rows reuses
 * them instead of querying again ("reused" in Show the steps).
 *
 * An entry is reused only while it is provably current:
 *  - no record event (this replica's own writes or another's, relayed over
 *    Redis) for its collection since it was fetched — a write in between,
 *    including an approved proposal, makes the collection's data newer;
 *  - no configuration or owner-seat write since (who sees what may differ);
 *  - this process was already listening when it was fetched (a replica that
 *    booted later cannot know what changed before it started);
 *  - at most REUSE_MAX_AGE_MS old: raw writes outside the items service send
 *    no event, so age bounds what they could leave stale.
 * Rows are the asker's own (the key carries the user id), so nothing crosses
 * people.
 */

/** Read tools whose rows depend only on their arguments, the asker and the collection's data. */
export const REUSABLE_TOOLS = new Set([
  'query_items',
  'aggregate',
  'list_collections',
  'semantic_search'
])

export const REUSE_MAX_AGE_MS = 30 * 60_000
const ENTRY_CAP_BYTES = 256 * 1024
const FIELDS_CAP = 60

/** When this process started listening for changes; nothing older is trusted. */
let listeningSince = Number.POSITIVE_INFINITY
/** `${tenant}|${collection}` → when it last changed; `${tenant}|*` = any collection. */
const changedAt = new Map<string, number>()
let everythingChangedAt = 0
let wired = false

function noteChanged(collection: string, tenant: string): void {
  const now = Date.now()
  // A system table (roles, scopes, owner seats…) may change who sees what.
  if (/^(nivaro_|directus_)/.test(collection)) {
    everythingChangedAt = now
    return
  }
  changedAt.set(`${tenant}|${collection}`, now)
  changedAt.set(`${tenant}|*`, now)
  if (changedAt.size > 5000) {
    changedAt.clear()
    everythingChangedAt = now
  }
}

function noteEverythingChanged(): void {
  everythingChangedAt = Date.now()
}

/** Start listening (once per process): record events, touches, config + owner writes. */
export function wireToolReuse(): void {
  if (wired) return
  wired = true
  listeningSince = Date.now()
  onItemEvent((ev) => noteChanged(ev.collection, ev.tenant ?? ''))
  onCollectionTouched((collection, tenant) => noteChanged(collection, tenant))
  onConfigWrite(noteEverythingChanged)
  onOwnersChanged(noteEverythingChanged)
  // Another process's configuration write reaches every registered cache.
  registerCache(
    'ai-tool-reuse',
    'Ask AI tool results kept per conversation (#2737)',
    noteEverythingChanged
  )
}

/** Stable JSON: object keys sorted, strings trimmed, empty values dropped. */
export function normalizeArgs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeArgs)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      const v = normalizeArgs((value as Record<string, unknown>)[k])
      if (v === undefined || v === null || v === '') continue
      out[k] = v
    }
    return out
  }
  if (typeof value === 'string') return value.trim()
  return value
}

export function reuseField(tool: string, input: Record<string, unknown>): string {
  return createHash('sha1')
    .update(`${tool}|${JSON.stringify(normalizeArgs(input))}`)
    .digest('hex')
}

function collectionOf(input: Record<string, unknown>): string {
  return typeof input.collection === 'string' && input.collection ? input.collection : '*'
}

interface Entry {
  at: number
  tenant: string
  collection: string
  result: unknown
  summary: string
}

/** Whether a stored entry is still current (see the module comment). */
export function entryIsCurrent(e: Entry, now = Date.now()): boolean {
  if (e.at <= listeningSince) return false
  if (now - e.at > REUSE_MAX_AGE_MS) return false
  if (everythingChangedAt >= e.at) return false
  const key = e.collection === '*' ? `${e.tenant}|*` : `${e.tenant}|${e.collection}`
  return (changedAt.get(key) ?? 0) < e.at
}

export interface ToolReuse {
  get(
    tool: string,
    input: Record<string, unknown>
  ): Promise<{ result: unknown; summary: string } | null>
  /** `startedAt` = when the tool began reading: a write during the read makes it stale. */
  put(
    tool: string,
    input: Record<string, unknown>,
    out: { result: unknown; summary: string },
    startedAt: number
  ): void
}

const memory = new Map<string, { expires: number; fields: Map<string, string> }>()

/**
 * The store for one conversation of one asker. Redis when there is one (any
 * replica may serve the follow-up), else this process's memory.
 */
export function toolReuseFor(
  userId: string,
  conversationKey: string,
  redis?: Redis | null
): ToolReuse {
  wireToolReuse()
  const tenant = currentTenantKey()
  const key = `nvr:aitool:${tenant || '-'}:${userId}:${conversationKey}`
  const ttl = Math.ceil(REUSE_MAX_AGE_MS / 1000)
  const read = async (field: string): Promise<string | null> => {
    if (redis) return redis.hget(key, field).catch(() => null)
    const m = memory.get(key)
    if (!m || m.expires < Date.now()) return null
    return m.fields.get(field) ?? null
  }
  const write = (field: string, value: string) => {
    if (redis) {
      void (async () => {
        if ((await redis.hlen(key)) >= FIELDS_CAP) await redis.del(key)
        await redis.multi().hset(key, field, value).expire(key, ttl).exec()
      })().catch(() => {})
      return
    }
    let m = memory.get(key)
    if (!m || m.expires < Date.now()) {
      m = { expires: 0, fields: new Map() }
      memory.set(key, m)
    }
    if (m.fields.size >= FIELDS_CAP) m.fields.clear()
    m.fields.set(field, value)
    m.expires = Date.now() + REUSE_MAX_AGE_MS
    if (memory.size > 2000) {
      for (const [k, v] of memory) if (v.expires < Date.now()) memory.delete(k)
    }
  }
  return {
    async get(tool, input) {
      if (!REUSABLE_TOOLS.has(tool)) return null
      const raw = await read(reuseField(tool, input))
      if (!raw) return null
      try {
        const e = JSON.parse(raw) as Entry
        if (!entryIsCurrent(e)) return null
        return { result: e.result, summary: e.summary }
      } catch {
        return null
      }
    },
    put(tool, input, out, startedAt) {
      if (!REUSABLE_TOOLS.has(tool)) return
      const entry: Entry = {
        at: startedAt,
        tenant,
        collection: collectionOf(input),
        result: out.result,
        summary: out.summary
      }
      const value = JSON.stringify(entry)
      if (value.length > ENTRY_CAP_BYTES) return
      write(reuseField(tool, input), value)
    }
  }
}

/** The conversation a question belongs to: the stored one, else its first question. */
export function conversationKeyFor(opts: {
  conversationId?: string | null
  firstQuestion: string
}): string {
  if (opts.conversationId) return `c:${opts.conversationId}`
  return `q:${createHash('sha1')
    .update(opts.firstQuestion.trim().toLowerCase().replace(/\s+/g, ' '))
    .digest('hex')}`
}

/** Tests only. */
export function resetToolReuseState(): void {
  if (wired) listeningSince = 0
  changedAt.clear()
  everythingChangedAt = 0
  memory.clear()
}
