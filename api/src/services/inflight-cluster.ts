// api/src/services/inflight-cluster.ts
/**
 * #2761 — every request running on every API replica, in one list.
 *
 * Each replica knows its own unfinished requests (traffic-inflight.ts). Replicas publish them to
 * Redis only while somebody is looking: a reader sets a short "watch" key, and every replica's
 * 2 s beat writes its snapshot (with the SQL wait type read from the database's own request view)
 * when that key exists. An idle cluster writes nothing. The first read after a quiet spell shows
 * this replica only; the next poll shows the rest.
 *
 * Memory + Redis only, admin routes only. Nothing here may throw into a request.
 */
import type { Redis } from 'ioredis'
import { db } from '../db/index.js'
import { INSTANCE_ID } from './instance-roster.js'
import {
  type InflightRow,
  listInflight,
  pickSession,
  processIdentity,
  type SessionCandidate
} from './traffic-inflight.js'

export const WATCH_KEY = 'nvr:inflight:watch'
export const NODE_KEY = (node: string) => `nvr:inflight:node:${node}`
const WATCH_TTL_S = 10
const NODE_TTL_S = 8
const BEAT_MS = 2000
const STALE_MS = 8000
const NODE_ROW_CAP = 100

export interface WaitInfo {
  session_id: number
  /** SQL Server wait type, or null when the session is running on CPU. */
  wait_type: string | null
  wait_ms: number
  blocked_by: number | null
}

export type ClusterInflightRow = InflightRow & { node: string; wait: WaitInfo | null }

export interface WaitCandidate extends SessionCandidate {
  wait_type: string | null
  wait_ms: number
  blocking_session_id: number
}

/** Pure: attach the wait of the session running each request's oldest statement. */
export function attachWaits(
  rows: InflightRow[],
  candidates: WaitCandidate[]
): Array<WaitInfo | null> {
  return rows.map((r) => {
    const stmt = r.running[0]
    if (!stmt) return null
    const pick = pickSession(candidates, stmt.sql, stmt.age_ms)
    if (pick.status !== 'found') return null
    const c = candidates.find((x) => x.session_id === pick.session_id)
    if (!c) return null
    return {
      session_id: c.session_id,
      wait_type: c.wait_type || null,
      wait_ms: Math.max(0, Math.round(c.wait_ms || 0)),
      blocked_by: c.blocking_session_id > 0 ? c.blocking_session_id : null
    }
  })
}

async function readWaitCandidates(): Promise<WaitCandidate[]> {
  const me = processIdentity()
  const res = (await db.raw(
    `SELECT r.session_id AS session_id,
            DATEDIFF(millisecond, r.start_time, GETDATE()) AS age_ms,
            SUBSTRING(t.text, 1, 4000) AS text,
            r.wait_type AS wait_type,
            r.wait_time AS wait_ms,
            r.blocking_session_id AS blocking_session_id
       FROM sys.dm_exec_requests r
       JOIN sys.dm_exec_sessions s ON s.session_id = r.session_id
      CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) t
      WHERE s.host_process_id = ? AND s.is_user_process = 1
        AND r.session_id <> @@SPID AND r.session_id > 50`,
    [me.pid]
  )) as WaitCandidate[]
  return Array.isArray(res) ? res : []
}

/** This replica's unfinished requests with their waits (best effort: no VIEW SERVER STATE = no waits). */
export async function localInflight(exclude?: string | null): Promise<{
  rows: ClusterInflightRow[]
  total: number
}> {
  const { rows, total } = listInflight({ exclude: exclude ?? null, limit: NODE_ROW_CAP })
  let waits: Array<WaitInfo | null> = rows.map(() => null)
  if (rows.some((r) => r.running.length)) {
    try {
      waits = attachWaits(rows, await readWaitCandidates())
    } catch {
      /* the DMVs are optional */
    }
  }
  return {
    rows: rows.map((r, i) => ({ ...r, node: INSTANCE_ID, wait: waits[i] })),
    total
  }
}

let redisRef: Redis | null = null
let timer: ReturnType<typeof setInterval> | null = null

async function beat(): Promise<void> {
  const redis = redisRef
  if (!redis) return
  try {
    if (!(await redis.exists(WATCH_KEY))) return
    const { rows, total } = await localInflight()
    await redis.set(
      NODE_KEY(INSTANCE_ID),
      JSON.stringify({ node: INSTANCE_ID, at: Date.now(), total, rows }),
      'EX',
      NODE_TTL_S
    )
  } catch {
    /* next beat retries */
  }
}

/** Start publishing this replica's list while a reader is watching. Safe to call twice. */
export function startInflightCluster(redis: Redis): () => void {
  redisRef = redis
  if (!timer) {
    timer = setInterval(() => void beat(), BEAT_MS)
    timer.unref()
  }
  return () => {
    if (timer) clearInterval(timer)
    timer = null
    redisRef = null
  }
}

export interface NodeInfo {
  node: string
  total: number
  self: boolean
}

/** Pure: merge node payloads, newest-age first, dropping stale and duplicate nodes. */
export function mergeInflight(
  payloads: Array<{ node: string; at: number; total: number; rows: ClusterInflightRow[] }>,
  now: number,
  limit = 200
): { rows: ClusterInflightRow[]; total: number; nodes: NodeInfo[] } {
  const seen = new Set<string>()
  const rows: ClusterInflightRow[] = []
  const nodes: NodeInfo[] = []
  let total = 0
  for (const p of payloads) {
    if (!p || seen.has(p.node) || now - p.at > STALE_MS) continue
    seen.add(p.node)
    total += p.total
    nodes.push({ node: p.node, total: p.total, self: p.node === INSTANCE_ID })
    rows.push(...p.rows)
  }
  rows.sort((a, b) => b.age_ms - a.age_ms)
  return { rows: rows.slice(0, limit), total, nodes }
}

async function scanNodeKeys(redis: Redis): Promise<string[]> {
  const keys: string[] = []
  let cursor = '0'
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', 'nvr:inflight:node:*', 'COUNT', 100)
    cursor = next
    keys.push(...batch)
  } while (cursor !== '0' && keys.length < 100)
  return keys
}

async function withPeople(
  rows: ClusterInflightRow[]
): Promise<Array<ClusterInflightRow & { person: string | null }>> {
  const ids = [...new Set(rows.map((r) => r.user_id).filter((x): x is string => !!x))]
  const names = new Map<string, string>()
  if (ids.length) {
    try {
      const users = (await db('nivaro_users')
        .whereIn('id', ids.slice(0, 500))
        .select('id', 'first_name', 'last_name', 'email')) as Array<{
        id: string
        first_name: string | null
        last_name: string | null
        email: string | null
      }>
      for (const u of users)
        names.set(
          u.id,
          `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || u.email || 'Unknown person'
        )
    } catch {
      /* names are a convenience */
    }
  }
  return rows.map((r) => ({ ...r, person: r.user_id ? (names.get(r.user_id) ?? null) : null }))
}

/**
 * Every replica's in-flight list. `exclude` = the asking request's own trace id. Without Redis,
 * this replica alone.
 */
export async function clusterInflight(exclude?: string | null) {
  const local = await localInflight(exclude)
  const now = Date.now()
  const payloads = [{ node: INSTANCE_ID, at: now, total: local.total, rows: local.rows }]
  const redis = redisRef
  if (redis) {
    try {
      await redis.set(WATCH_KEY, '1', 'EX', WATCH_TTL_S)
      const keys = (await scanNodeKeys(redis)).filter((k) => k !== NODE_KEY(INSTANCE_ID))
      if (keys.length) {
        for (const raw of await redis.mget(keys)) {
          if (!raw) continue
          try {
            payloads.push(JSON.parse(raw))
          } catch {
            /* skip a malformed entry */
          }
        }
      }
    } catch {
      /* Redis down: this replica alone */
    }
  }
  const merged = mergeInflight(payloads, now)
  return { ...merged, rows: await withPeople(merged.rows), at: new Date(now).toISOString() }
}
