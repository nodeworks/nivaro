// api/src/services/wait-reasons.ts
/**
 * #3231 — "This is taking a while" with a reason.
 *
 * A page whose read has been loading for a few seconds asks GET /api/background-runs/waiting
 * what that read is waiting on. The answer comes from what the server already tracks for every
 * unfinished request (services/traffic-inflight.ts): the read-gate queue position, an uncached
 * custom query or widget, an external call, a statement still running. Only slow paths note a
 * wait, so a normal request carries nothing extra, and nothing new rides on any response.
 *
 * Cross-replica, the same way the in-flight cluster list works (inflight-cluster.ts): replicas
 * publish their slow requests to Redis only while somebody is asking. The first status read after
 * a quiet spell sees this replica alone; the page polls, so the next read sees the rest.
 *
 * Only the caller's OWN requests are ever matched. Answers carry kinds, a query slug / widget
 * slug / partner name, counts and ages — never SQL, values or bindings. Off in cloud mode (the
 * in-flight list is). Nothing here may throw into a request.
 */
import type { Redis } from 'ioredis'
import { db } from '../db/index.js'
import { INSTANCE_ID } from './instance-roster.js'
import { inflightWaitFor, inflightWaitSnapshots, type WaitSnapshot } from './traffic-inflight.js'

export const WAIT_WATCH_KEY = 'nvr:wait:watch'
export const WAIT_NODE_KEY = (node: string) => `nvr:wait:node:${node}`
const WATCH_TTL_S = 10
const NODE_TTL_S = 6
const BEAT_MS = 2000
/** Only requests at least this old are published (the page asks after ~3 s). */
const PUBLISH_MIN_AGE_MS = 1500
const STALE_MS = 6000

export type WaitAnswerKind =
  | 'slot'
  | 'external'
  | 'query'
  | 'widget'
  | 'database'
  | 'auth'
  | 'working'

export interface WaitAnswer {
  found: boolean
  kind?: WaitAnswerKind
  /** Query / widget slug or partner name. */
  subject?: string | null
  /** Riding another person's identical run. */
  shared?: boolean
  /** Read-gate queue: 1 = next. */
  position?: number | null
  of?: number | null
  age_ms?: number
  /** Oldest statement still running, ms. */
  statement_ms?: number
  rows_so_far?: number
  /** Items list reads: the collection being read. */
  collection?: string | null
  /** About how many rows that table holds (administrators only). */
  table_rows?: number | null
  /** Answered from another replica's snapshot. */
  peer?: boolean
}

/** Client url (with or without /api, with a query string) → the in-flight path, or null. */
export function waitPath(url: string): string | null {
  if (typeof url !== 'string' || !url.startsWith('/') || url.length > 1000) return null
  let p = url.split('?')[0].split('#')[0]
  if (!p.startsWith('/api/')) p = `/api${p}`
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1)
  return /^\/api\/[A-Za-z0-9_\-./:%@~]+$/.test(p) ? p : null
}

/** The collection an items LIST path reads (`/api/items/:collection`), else null. */
export function listCollectionOf(path: string): string | null {
  const m = path.match(/^\/api\/items\/([A-Za-z0-9_]+)$/)
  return m && !/^(nivaro|directus)_/i.test(m[1]) ? m[1] : null
}

const PRIORITY: WaitAnswerKind[] = ['slot', 'external', 'query', 'widget']

/** Pure: the one reason worth telling the person about, most specific first. */
export function pickWait(s: WaitSnapshot | null): WaitAnswer {
  if (!s) return { found: false }
  const base = {
    found: true,
    age_ms: s.age_ms,
    statement_ms: s.statement_ms,
    rows_so_far: s.rows,
    collection: listCollectionOf(s.path)
  }
  for (const kind of PRIORITY) {
    const w = s.waits.find((x) => x.kind === kind)
    if (!w) continue
    return {
      ...base,
      kind,
      subject: w.subject,
      shared: w.shared || undefined,
      ...(kind === 'slot' ? { position: w.position, of: w.of } : {})
    }
  }
  if (s.phase === 'sql') return { ...base, kind: 'database' }
  if (s.phase === 'auth') return { ...base, kind: 'auth' }
  return { ...base, kind: 'working' }
}

// ── About how big a table is (administrators only; cached) ──────────────────

const rowCache = new Map<string, { n: number | null; at: number }>()
const ROW_CACHE_MS = 10 * 60_000

export async function approxTableRows(table: string): Promise<number | null> {
  if (!/^[A-Za-z0-9_]{1,128}$/.test(table)) return null
  const hit = rowCache.get(table)
  if (hit && Date.now() - hit.at < ROW_CACHE_MS) return hit.n
  let n: number | null = null
  try {
    const rows = (await db.raw(
      `SELECT SUM(p.rows) AS n FROM sys.partitions p
        WHERE p.object_id = OBJECT_ID(?) AND p.index_id IN (0, 1)`,
      [table]
    )) as Array<{ n: number | string | null }> | undefined
    const v = Array.isArray(rows) ? Number(rows[0]?.n) : Number.NaN
    n = Number.isFinite(v) ? v : null
  } catch {
    n = null
  }
  if (rowCache.size > 500) rowCache.clear()
  rowCache.set(table, { n, at: Date.now() })
  return n
}

// ── Cross-replica: publish slow requests while somebody is asking ───────────

let redisRef: Redis | null = null
let timer: ReturnType<typeof setInterval> | null = null

async function beat(): Promise<void> {
  const redis = redisRef
  if (!redis) return
  try {
    if (!(await redis.exists(WAIT_WATCH_KEY))) return
    const rows = inflightWaitSnapshots(PUBLISH_MIN_AGE_MS)
    if (rows.length === 0) return
    await redis.set(
      WAIT_NODE_KEY(INSTANCE_ID),
      JSON.stringify({ node: INSTANCE_ID, at: Date.now(), rows }),
      'EX',
      NODE_TTL_S
    )
  } catch {
    /* the next beat retries */
  }
}

/** Start the beat (idempotent). Returns the stopper — call it in the plugin's onClose. */
export function startWaitBeat(redis: Redis | null | undefined): () => void {
  if (!redis || process.env.CLOUD_META_DB_URL) return () => {}
  redisRef = redis
  if (!timer) {
    timer = setInterval(() => void beat(), BEAT_MS)
    timer.unref?.()
  }
  return () => {
    if (timer) clearInterval(timer)
    timer = null
    redisRef = null
  }
}

/** Pure: the caller's newest matching request across replica payloads. */
export function matchPeerSnapshot(
  payloads: Array<{ node?: string; at?: number; rows?: WaitSnapshot[] } | null>,
  userId: string,
  method: string,
  path: string,
  now: number
): WaitSnapshot | null {
  let best: WaitSnapshot | null = null
  for (const p of payloads) {
    if (!p || !Array.isArray(p.rows) || typeof p.at !== 'number' || now - p.at > STALE_MS) continue
    if (p.node === INSTANCE_ID) continue
    for (const r of p.rows) {
      if (r.user_id !== userId || r.method !== method || r.path !== path) continue
      // Snapshot ages were taken at `p.at`; age them to now.
      const aged = { ...r, age_ms: r.age_ms + (now - p.at) }
      if (!best || aged.age_ms < best.age_ms) best = aged
    }
  }
  return best
}

async function peerSnapshot(
  redis: Redis,
  userId: string,
  method: string,
  path: string
): Promise<WaitSnapshot | null> {
  await redis.set(WAIT_WATCH_KEY, '1', 'EX', WATCH_TTL_S)
  const keys: string[] = []
  let cursor = '0'
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', 'nvr:wait:node:*', 'COUNT', 100)
    cursor = next
    keys.push(...batch)
  } while (cursor !== '0' && keys.length < 50)
  if (keys.length === 0) return null
  const payloads = (await redis.mget(keys)).map((raw) => {
    if (!raw) return null
    try {
      return JSON.parse(raw)
    } catch {
      return null
    }
  })
  return matchPeerSnapshot(payloads, userId, method, path, Date.now())
}

/**
 * What the caller's own unfinished `method path` read is waiting on: this replica first, then
 * the other replicas' published snapshots. `exclude` = the asking request's own trace id.
 */
export async function findWait(opts: {
  redis: Redis | null | undefined
  userId: string
  method: string
  path: string
  exclude?: string | null
  isAdmin?: boolean
}): Promise<WaitAnswer> {
  if (process.env.CLOUD_META_DB_URL) return { found: false }
  const method = opts.method.toUpperCase()
  let snap = inflightWaitFor(opts.userId, method, opts.path, opts.exclude)
  let peer = false
  if (!snap && opts.redis) {
    try {
      snap = await peerSnapshot(opts.redis, opts.userId, method, opts.path)
      peer = !!snap
    } catch {
      snap = null
    }
  }
  const answer = pickWait(snap)
  if (peer) answer.peer = true
  if (answer.found && answer.collection && opts.isAdmin)
    answer.table_rows = await approxTableRows(answer.collection)
  return answer
}

/** Tests only. */
export function __resetWaitReasons(): void {
  rowCache.clear()
}
