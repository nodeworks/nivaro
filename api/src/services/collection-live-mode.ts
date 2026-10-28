import { journaledEmit } from './event-journal.js'
import { mergeUpdates } from './socket-transport.js'
import { currentTenantKey, tenantScopedRoom } from './tenant-rooms.js'

/**
 * Per-collection realtime switch (#2490). `nivaro_collections.browser_config.live_events`:
 *
 * - `on` (default): every write is one `collection:update` (journaled, replayable) — until a
 *   burst passes REALTIME_AUTO_BATCH_PER_S writes a second (auto-batch, below).
 * - `batched`: writes are gathered for BATCH_WINDOW_MS and go out as ONE message listing the
 *   ids (the coalesced shape clients already read — `items`, or `many` past the cap), for
 *   high-churn collections where nobody needs each row the moment it lands.
 * - `off`: no live record events at all (no socket fan-out, no journal, no Redis stream) —
 *   for import staging tables and the like. Lists on such a collection poll instead.
 *
 * GraphQL `itemMutated` subscriptions are explicit, so `batched` keeps them per write; `off`
 * stops them too. The mode is read through the collection metadata cache and kept here for
 * 30 s per tenant (another replica sees a change within that); the first write to a collection
 * in a process goes out live while its mode loads, never waiting on the metadata read.
 */

export type LiveMode = 'on' | 'batched' | 'off'

export const BATCH_WINDOW_MS = 2000
const TTL_MS = 30_000

export function parseLiveMode(browserConfig: unknown): LiveMode {
  let bc = browserConfig
  if (typeof bc === 'string') {
    try {
      bc = JSON.parse(bc)
    } catch {
      return 'on'
    }
  }
  const v = bc && typeof bc === 'object' ? (bc as { live_events?: unknown }).live_events : null
  return v === 'off' || v === 'batched' ? v : 'on'
}

const cache = new Map<string, { mode: LiveMode; at: number }>()
const loading = new Map<string, Promise<LiveMode>>()
const keyOf = (collection: string, tenant = currentTenantKey()) => `${tenant}\u0000${collection}`

function load(collection: string): Promise<LiveMode> {
  const key = keyOf(collection)
  const inflight = loading.get(key)
  if (inflight) return inflight
  // Loaded lazily: the broadcast path stays free of the metadata module until it needs it.
  const p = import('./collections.js')
    .then(({ getCollection }) => getCollection(collection))
    .then((c) => parseLiveMode((c as { browser_config?: unknown } | undefined)?.browser_config))
    .catch(() => cache.get(key)?.mode ?? ('on' as LiveMode))
    .then((mode) => {
      cache.set(key, { mode, at: Date.now() })
      if (cache.size > 5000) cache.delete(cache.keys().next().value as string)
      return mode
    })
    .finally(() => loading.delete(key))
  loading.set(key, p)
  return p
}

/** The mode now, without waiting: null when this process has not read it yet. */
export function liveModeNow(collection: string): LiveMode | null {
  const hit = cache.get(keyOf(collection))
  if (!hit) return null
  // Stale-while-revalidate: the known mode answers while a fresh read runs.
  if (Date.now() - hit.at > TTL_MS) void load(collection)
  return hit.mode
}

export function liveModeOf(collection: string): Promise<LiveMode> {
  const now = liveModeNow(collection)
  return now ? Promise.resolve(now) : load(collection)
}

/** A collection's settings changed in this process: read the mode again on the next write. */
export function forgetLiveMode(collection?: string): void {
  if (!collection) {
    cache.clear()
    return
  }
  for (const k of cache.keys()) if (k.endsWith(`\u0000${collection}`)) cache.delete(k)
}

// ── Presence heartbeats ─────────────────────────────────────────────────────

/**
 * `user_presence` rows are rewritten by every open tab's heartbeat (PATCH /items/user_presence
 * every ~25 s, idle flips, page changes). Each write went out as a `collection:update` to every
 * browser holding the collection room, and every one of those browsers re-read the online list —
 * staging 2026-10-23: 95 broadcasts/min x 25 members, the main amplifier of a refetch storm.
 * Who is online is announced by the socket server's own coalesced `presence:changed`
 * (plugins/socketio.ts), so heartbeat writes send nothing live. Changes a reader still needs
 * the moment they land — `typing_room` (chat typing indicators) — and deletes still go out.
 */
const PRESENCE_COLLECTION = 'user_presence'
const PRESENCE_LIVE_FIELDS = new Set(['typing_room'])

export function isQuietPresenceWrite(
  collection: string,
  extra?: { action?: 'create' | 'update' | 'delete'; changed_fields?: string[] }
): boolean {
  if (collection !== PRESENCE_COLLECTION) return false
  if (extra?.action === 'delete') return false
  return !extra?.changed_fields?.some((f) => PRESENCE_LIVE_FIELDS.has(f))
}

// ── Batched mode ────────────────────────────────────────────────────────────

interface Batch {
  list: Array<Record<string, unknown>>
  timer: ReturnType<typeof setTimeout>
}
const batches = new Map<string, Batch>()
const stats = { batches: 0, writes: 0, suppressed: 0, autoBatched: 0 }

/** Gather one write of a `batched` collection; the window's writes go out as one message. */
export function queueBatched(
  collection: string,
  payload: Record<string, unknown>,
  windowMs = BATCH_WINDOW_MS
): void {
  const tenant = currentTenantKey()
  const key = keyOf(collection, tenant)
  stats.writes++
  const cur = batches.get(key)
  if (cur) {
    cur.list.push(payload)
    return
  }
  const timer = setTimeout(() => {
    const b = batches.get(key)
    batches.delete(key)
    if (!b?.list.length) return
    stats.batches++
    const merged = { ...mergeUpdates(collection, b.list), batched: true }
    void journaledEmit(
      tenantScopedRoom(`collection:${collection}`, tenant),
      'collection:update',
      merged as unknown as Record<string, unknown>,
      { roomScoped: true }
    ).catch(() => {})
  }, windowMs)
  ;(timer as { unref?: () => void }).unref?.()
  batches.set(key, { list: [payload], timer })
}

// ── Auto-batch (review 2026-10-27) ──────────────────────────────────────────

/**
 * A collection left `on` still gets a bulk write (an import, a script, a bulk edit through the
 * items service) as one journaled event per row: every socket in the room hears each one, and
 * the journal window fills, so reconnecting tabs reload instead of replaying. Above
 * REALTIME_AUTO_BATCH_PER_S writes in one second to one collection (default 20; 0 = off), this
 * process sends the rest of that burst batched (AUTO_BATCH_WINDOW_MS windows, the `batched`
 * message shape clients already read) until a second passes under the rate. Per process and per
 * tenant; a person editing one record at a time never reaches it.
 */
export const AUTO_BATCH_WINDOW_MS = 1000

export function autoBatchPerSecond(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.REALTIME_AUTO_BATCH_PER_S
  if (raw == null || raw === '') return 20
  const n = Math.floor(Number(raw))
  return Number.isFinite(n) && n >= 0 ? n : 20
}

interface Rate {
  second: number
  count: number
  /** Batching until this second has passed under the rate. */
  hot: boolean
}
const rates = new Map<string, Rate>()

/**
 * Count one write to `collection` and say whether it should go out batched. The write that
 * crosses the rate and every later one in a hot burst are batched; the first second back
 * under the rate goes live again.
 */
export function autoBatchDue(collection: string, now: number = Date.now()): boolean {
  const limit = autoBatchPerSecond()
  if (limit <= 0) return false
  const key = keyOf(collection)
  const second = Math.floor(now / 1000)
  let r = rates.get(key)
  if (!r) {
    if (rates.size > 5000) rates.clear()
    r = { second, count: 0, hot: false }
    rates.set(key, r)
  }
  if (r.second !== second) {
    // The previous second decides: still over the rate stays batched, a quiet one goes live.
    r.hot = r.second === second - 1 && r.count > limit
    r.second = second
    r.count = 0
  }
  r.count++
  if (r.count > limit) r.hot = true
  if (r.hot) stats.autoBatched++
  return r.hot
}

/** A write of an `off` collection sent nothing live. */
export function noteLiveSuppressed(): void {
  stats.suppressed++
}

export function liveModeStats(): {
  batches: number
  writes_batched: number
  suppressed: number
  auto_batched: number
} {
  return {
    batches: stats.batches,
    writes_batched: stats.writes,
    suppressed: stats.suppressed,
    auto_batched: stats.autoBatched
  }
}

/** Tests: drop pending windows and the cache. */
export function resetLiveMode(): void {
  for (const b of batches.values()) clearTimeout(b.timer)
  batches.clear()
  cache.clear()
  loading.clear()
  rates.clear()
}
