import { CHAOS_KEY_PREFIX, shareBucket } from './registry.js'

/**
 * Key-loss and eviction drills on the app's own Redis database (#2832). Only this instance's
 * database is touched (the client's db index), only under the chosen family's prefix, never
 * `nvr:chaos:*` (the armed-fault hash Stop all relies on), and never more than the cap.
 *
 * Loss can come back: with `restore` on, the keys are snapshotted (DUMP + PTTL) before they are
 * deleted and put back at the end of the window — only where nothing was written since — the way
 * a failover to a lagging replica brings old keys back. That is the case "sign-out must hold"
 * is about: a session signed out during the window returns from the snapshot, and its
 * revocation marker must still win.
 */

export interface KeyFamily {
  key: string
  label: string
  /** SCAN MATCH prefix. */
  prefix: string
  /** Sessions — refused on a shared development Redis (see sessionLossRefusal). */
  sessions?: boolean
}

export const KEY_FAMILIES: KeyFamily[] = [
  {
    key: 'sessions',
    label: 'Sessions and sign-out markers (sess:*)',
    prefix: 'sess:',
    sessions: true
  },
  { key: 'query_cache', label: 'Custom-query cache (cq:*)', prefix: 'cq:' },
  { key: 'metadata_cache', label: 'Shared metadata cache (nvr:mdl2:*)', prefix: 'nvr:mdl2:' },
  { key: 'cron_lease', label: 'Scheduler lease and job locks (nvr:cron:*)', prefix: 'nvr:cron:' },
  { key: 'event_journal', label: 'Realtime event journal and stream (nvr:ev*)', prefix: 'nvr:ev' },
  { key: 'idempotency', label: 'Idempotency keys (nvr:idem*)', prefix: 'nvr:idem' },
  { key: 'nvr', label: 'Every nvr:* key', prefix: 'nvr:' }
]

const PROTECTED_PREFIX = CHAOS_KEY_PREFIX

export function keyFamily(key: string): KeyFamily | null {
  return KEY_FAMILIES.find((f) => f.key === key) ?? null
}

/** The Redis database index a client talks to (0 when it does not say). */
export function redisDbIndex(client: unknown): number {
  const db = Number((client as { options?: { db?: unknown } } | null)?.options?.db ?? 0)
  return Number.isFinite(db) ? db : 0
}

/**
 * Why the sessions family may not be dropped here, or null. A development Redis is shared:
 * db 0 holds everyone's sign-ins, and REDIS_CHANNEL_PREFIX separates channels, not keys — so
 * on development only a non-zero database counts. A deployed stack (its own Redis) may also
 * drop them when it sets REDIS_CHANNEL_PREFIX.
 */
export function sessionLossRefusal(
  dbIndex: number,
  env: NodeJS.ProcessEnv = process.env
): string | null {
  if (dbIndex !== 0) return null
  if ((env.REDIS_CHANNEL_PREFIX ?? '') !== '' && env.NODE_ENV !== 'development') return null
  return 'Sessions are dropped only on a Redis database other than 0 (or a deployed stack that sets REDIS_CHANNEL_PREFIX): on a shared development Redis, db 0 holds everyone’s sign-ins.'
}

/** The slice of ioredis these drills use (tests pass an in-memory fake). */
export interface KeyClient {
  scan(
    cursor: string | number,
    matchToken: 'MATCH',
    pattern: string,
    countToken: 'COUNT',
    count: number
  ): Promise<[cursor: string, elements: string[]]>
  dumpBuffer(key: string): Promise<Buffer | null>
  pttl(key: string): Promise<number>
  unlink(...keys: string[]): Promise<number>
  restore(key: string, ttl: number, value: Buffer): Promise<unknown>
}

function escapeGlob(s: string): string {
  return s.replace(/[*?[\]\\]/g, '\\$&')
}

/** Keys under a prefix (SCAN, never KEYS), protected keys left out, at most `cap`. */
export async function scanPrefix(
  client: KeyClient,
  prefix: string,
  cap: number
): Promise<string[]> {
  const out: string[] = []
  let cursor = '0'
  do {
    const [next, keys] = await client.scan(cursor, 'MATCH', `${escapeGlob(prefix)}*`, 'COUNT', 500)
    cursor = next
    for (const k of keys) {
      if (k.startsWith(PROTECTED_PREFIX)) continue
      out.push(k)
      if (out.length >= cap) return out
    }
  } while (cursor !== '0')
  return out
}

export interface Snapshot {
  key: string
  ttl: number
  value: Buffer
}

export interface LossResult {
  deleted: number
  snapshot: Snapshot[]
}

/** Delete up to `cap` keys of a family, keeping a snapshot when `keep` is on. */
export async function dropFamily(
  client: KeyClient,
  family: KeyFamily,
  cap: number,
  keep: boolean
): Promise<LossResult> {
  const keys = await scanPrefix(client, family.prefix, cap)
  const snapshot: Snapshot[] = []
  if (keep) {
    for (const key of keys) {
      const [value, ttl] = await Promise.all([client.dumpBuffer(key), client.pttl(key)])
      if (value) snapshot.push({ key, value, ttl: ttl > 0 ? ttl : 0 })
    }
  }
  let deleted = 0
  for (let i = 0; i < keys.length; i += 200)
    deleted += await client.unlink(...keys.slice(i, i + 200))
  return { deleted, snapshot }
}

/**
 * Put a snapshot back where nothing was written since (RESTORE without REPLACE refuses an
 * existing key), with the TTL each key had when it was taken. Returns how many came back.
 */
export async function restoreSnapshot(client: KeyClient, snapshot: Snapshot[]): Promise<number> {
  let back = 0
  for (const s of snapshot) {
    try {
      await client.restore(s.key, s.ttl, s.value)
      back++
    } catch {
      /* BUSYKEY — written during the window; the newer value wins */
    }
  }
  return back
}

/**
 * One eviction sweep: a stable `share_pct` of the `nvr:*` keys (by hash of key + round), at
 * most `cap`, the way an allkeys eviction policy drops keys under memory pressure.
 */
export async function evictShare(
  client: KeyClient,
  sharePct: number,
  cap: number,
  seed: string
): Promise<number> {
  const keys = await scanPrefix(client, 'nvr:', cap * 20)
  const pick = keys.filter((k) => shareBucket(k, seed) < sharePct).slice(0, cap)
  let n = 0
  for (let i = 0; i < pick.length; i += 200) n += await client.unlink(...pick.slice(i, i + 200))
  return n
}
