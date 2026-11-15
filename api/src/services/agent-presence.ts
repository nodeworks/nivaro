import { createHash } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Redis } from 'ioredis'
import { instanceKey } from './instance-key.js'
import { appNameOf } from './mcp-attribution.js'
import { agentDisplayName, mcpConnOf, readMcpSettings } from './mcp-calls.js'
import { currentTenantKey, tenantScopedRoom } from './tenant-rooms.js'

/**
 * Agent presence on a record (rt8 #21): "Claude (for Rob) is updating this record".
 *
 * An agent has no socket, so it never sits in a record room. Instead every tool call the hosted
 * MCP endpoint makes back into the API (`req.mcpInner`, routes/mcp.ts) that read or wrote ONE
 * record — and succeeded, so the agent's person may see it — leaves a short-lived mark on that
 * record:
 *
 *   nvr:agentp:<slot>:<record room>   hash, field = a hash of the connection, value = the entry;
 *                                     the key lapses 30 s after the last mark
 *
 * and the record room hears `record:agents` with the current list. The room admits only people
 * who may open the record (record:join's read gate), so a viewer only ever learns about an agent
 * on a record they can open; a socket that joins later is told the list once on join
 * (`agentSnapshot`). The payload names the agent (the name its connection goes by — owner- or
 * admin-set, services/mcp-calls.ts `connection_names`) and the person it acts for, like
 * `record:viewers` names co-viewers: no values, no connection ids.
 *
 * Cheap: nothing for a person's own clicks; one pipelined Redis write per mark, at most one mark
 * per agent + record + mode every 5 s (an agent paging through 500 records marks each once), and
 * no emit when nobody has the record open.
 */

export type AgentMode = 'reading' | 'updating'

export interface AgentTouch {
  collection: string
  item: string
  mode: AgentMode
}

export interface AgentPresenceEntry {
  /** Stable per connection, not the connection id itself. */
  key: string
  /** The name the agent goes by. */
  name: string
  /** The person it acts for. */
  for: { id: string; name: string }
  mode: AgentMode
  /** Server clock (ms) the mark lapses at. */
  until: number
}

/** What the record room hears: relative lifetimes, so a client's clock never matters. */
export interface AgentPresenceWire {
  key: string
  name: string
  for: { id: string; name: string }
  mode: AgentMode
  ttl_ms: number
}

/** How long a mark lasts: a write is followed by more writes, a read is over quickly. */
export const AGENT_TTL_MS: Record<AgentMode, number> = { reading: 15_000, updating: 25_000 }
const KEY_TTL_MS = 30_000
/** One mark per agent + record + mode this often at most. */
const THROTTLE_MS = 5_000
const THROTTLE_MAX = 5_000

const COLLECTION_RE = /^[A-Za-z0-9_]{1,64}$/
const SYSTEM_RE = /^(nivaro_|directus_)/i
/** Collection-level routes that sit where a record id would. */
const NOT_AN_ID = new Set([
  'aggregate',
  'filter-check',
  'batch-read',
  'batch',
  'bulk',
  'export',
  'import',
  'count',
  'search',
  'new'
])

function pathOf(url: string): string {
  const p = String(url ?? '').split('?')[0]
  try {
    return decodeURIComponent(p)
  } catch {
    return p
  }
}

function cleanId(raw: unknown): string | null {
  const s = raw == null ? '' : String(raw).trim()
  if (!s || s.length > 64 || NOT_AN_ID.has(s.toLowerCase()) || /[/\s]/.test(s)) return null
  return s
}

function cleanCollection(raw: unknown): string | null {
  const c = typeof raw === 'string' ? raw : ''
  return COLLECTION_RE.test(c) && !SYSTEM_RE.test(c) ? c : null
}

/**
 * The record one in-process tool call read or wrote, and how (pure). Only calls that name ONE
 * record of a business collection count: list reads, aggregates, creates (no one has the new
 * record open yet) and system tables never mark anything.
 */
export function agentTouchOf(method: string, url: string, body?: unknown): AgentTouch | null {
  const m = String(method ?? '').toUpperCase()
  const path = pathOf(url)
  let hit = /^\/api\/items\/([^/]+)\/([^/]+)\/?$/.exec(path)
  if (hit) {
    const collection = cleanCollection(hit[1])
    const item = cleanId(hit[2])
    if (!collection || !item) return null
    if (m === 'GET') return { collection, item, mode: 'reading' }
    if (m === 'PATCH' || m === 'PUT' || m === 'DELETE')
      return { collection, item, mode: 'updating' }
    return null
  }
  hit = /^\/api\/pipelines\/instance\/([^/]+)\/([^/]+)(\/transition)?\/?$/.exec(path)
  if (hit) {
    const collection = cleanCollection(hit[1])
    const item = cleanId(hit[2])
    if (!collection || !item) return null
    if (hit[3] && m === 'POST') return { collection, item, mode: 'updating' }
    if (!hit[3] && m === 'GET') return { collection, item, mode: 'reading' }
    return null
  }
  if (path === '/api/comments' && m === 'POST' && body && typeof body === 'object') {
    const b = body as { collection?: unknown; item?: unknown }
    const collection = cleanCollection(b.collection)
    const item = cleanId(b.item)
    return collection && item ? { collection, item, mode: 'updating' } : null
  }
  return null
}

/** The entries still alive at `now`, one per agent (updating beats reading), stable order. */
export function liveAgentEntries(
  raw: Record<string, string> | null | undefined,
  now: number
): AgentPresenceEntry[] {
  const out: AgentPresenceEntry[] = []
  for (const v of Object.values(raw ?? {})) {
    try {
      const e = JSON.parse(v) as AgentPresenceEntry
      if (e && typeof e.key === 'string' && typeof e.name === 'string' && e.until > now) out.push(e)
    } catch {
      // a torn entry is skipped
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key))
}

export function toWire(entries: AgentPresenceEntry[], now: number): AgentPresenceWire[] {
  return entries.map((e) => ({
    key: e.key,
    name: e.name,
    for: e.for,
    mode: e.mode,
    ttl_ms: Math.max(0, e.until - now)
  }))
}

/** Same deployment slot as the realtime board: a laptop's APIs on other ports never mix. */
const slot = () =>
  process.env.NODE_ENV === 'development'
    ? `${instanceKey()}-${process.env.PORT ?? ''}`
    : instanceKey()
export const agentPresenceKey = (room: string) => `nvr:agentp:${slot()}:${room}`

const connKey = (conn: string) => createHash('sha256').update(conn).digest('hex').slice(0, 12)

const personName = (u: {
  first_name?: string | null
  last_name?: string | null
  email?: string | null
}) =>
  (
    [u.first_name, u.last_name].filter(Boolean).join(' ') ||
    String(u.email ?? '').split('@')[0] ||
    'someone'
  )
    .replace(/[<>]/g, '')
    .slice(0, 80)

const lastMark = new Map<string, number>()

/** Exported for tests: true when this agent + record + mode was marked within the window. */
export function throttled(key: string, now: number, map = lastMark): boolean {
  const last = map.get(key)
  if (last != null && now - last < THROTTLE_MS) return true
  if (map.size >= THROTTLE_MAX) {
    for (const [k, at] of map) if (now - at >= THROTTLE_MS) map.delete(k)
    if (map.size >= THROTTLE_MAX) map.clear()
  }
  map.set(key, now)
  return false
}

type Emitter = { to(room: string): { emit(event: string, payload: unknown): void } }

/** Mark one agent on one record and tell the record room (fire and forget). */
export async function noteAgentTouch(
  deps: { redis: Redis; io?: Emitter | null; hasViewers?: (room: string) => boolean },
  req: Pick<
    FastifyRequest,
    'mcpInner' | 'authMethod' | 'oauthGrantId' | 'oauthClientId' | 'oauthClientName' | 'user'
  > & { apiKeyId?: number | null; apiKeySimulatedId?: number | null; apiKeyName?: string },
  touch: AgentTouch,
  tenant: string,
  now = Date.now()
): Promise<void> {
  const conn = mcpConnOf(req)
  const user = req.user
  if (!conn || !user?.id) return
  const room = tenantScopedRoom(`record:${touch.collection}:${touch.item}`, tenant)
  if (throttled(`${room}|${conn}|${touch.mode}`, now)) return
  const settings = await readMcpSettings().catch(() => null)
  const key = connKey(conn)
  const entry: AgentPresenceEntry = {
    key,
    name: agentDisplayName(conn, appNameOf(req), settings),
    for: { id: String(user.id), name: personName(user as never) },
    mode: touch.mode,
    until: now + AGENT_TTL_MS[touch.mode]
  }
  const rk = agentPresenceKey(room)
  // An updating mark is not replaced by the same agent's read a moment later.
  if (touch.mode === 'reading') {
    const prev = liveAgentEntries({ k: (await deps.redis.hget(rk, key)) ?? '' }, now)[0]
    if (prev && prev.mode === 'updating') return
  }
  const res = await deps.redis
    .multi()
    .hset(rk, key, JSON.stringify(entry))
    .pexpire(rk, KEY_TTL_MS)
    .hgetall(rk)
    .exec()
  const all = (res?.[2]?.[1] ?? {}) as Record<string, string>
  const live = liveAgentEntries(all, now)
  if (!deps.io || (deps.hasViewers && !deps.hasViewers(room))) return
  deps.io.to(room).emit('record:agents', {
    collection: touch.collection,
    item: touch.item,
    agents: toWire(live, now)
  })
}

/** The agents on a record right now, for a socket that just joined its room. */
export async function agentSnapshot(redis: Redis, room: string): Promise<AgentPresenceWire[]> {
  const now = Date.now()
  const raw = (await redis.hgetall(agentPresenceKey(room)).catch(() => ({}))) as Record<
    string,
    string
  >
  return toWire(liveAgentEntries(raw, now), now)
}

/**
 * The hook: every successful in-process tool call that named one record marks it. Registered
 * once at the root (server.ts), after the routes have answered.
 */
export function registerAgentPresence(
  app: FastifyInstance,
  hasViewers?: (room: string) => boolean
): void {
  app.addHook('onResponse', async (req, reply) => {
    if (!req.mcpInner || reply.statusCode >= 400) return
    const touch = agentTouchOf(req.method, req.url, req.body)
    if (!touch) return
    const redis = (app as { redis?: Redis }).redis
    if (!redis) return
    const io = (app as unknown as { io?: Emitter }).io ?? null
    void noteAgentTouch({ redis, io, hasViewers }, req as never, touch, currentTenantKey()).catch(
      () => {}
    )
  })
}
