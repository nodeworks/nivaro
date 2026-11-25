import { withTenant } from '../../db/tenant-context.js'
import { registerAppKeyed } from '../app-forget.js'
import { getApp } from '../io-holder.js'
import type { TenantRecord } from '../tenancy/types.js'
import { currentTenantKey } from '../tenant-rooms.js'

/**
 * The figures Hub autoscaling reads on top of the capacity answer (services/capacity/app-usage.ts),
 * app side. Aggregate figures only, never a record, a name or a URL:
 *   - answer times: a histogram per app and minute (LAT_BOUNDS_MS buckets) fed by the same onSend
 *     count as the capacity buckets; each process snapshot carries its last 5 complete minutes
 *     summed over its apps (`lat`), and the answer the p95 per ROLE over every fresh replica;
 *   - heavy reads waiting in this process's read gate (`heavy_queued`, every app);
 *   - imports and exports waiting in the hand-off queues (Redis list lengths, per app keys, summed).
 * An app before this answers none of these; the Hub then reads no figure (never a zero).
 */

/** Upper bounds (ms) of the answer-time buckets; the last bucket is everything above. */
export const LAT_BOUNDS_MS: readonly number[] = [
  25, 50, 100, 200, 300, 500, 750, 1000, 1500, 2000, 3000, 5000, 8000, 13000, 20000
]
const BUCKETS = LAT_BOUNDS_MS.length + 1
const WINDOW_MIN = 5
const KEEP_MIN = 7

interface LatMinute {
  minute: number
  h: number[]
}

/** Per app (currentTenantKey(); '' on a dedicated app): the newest minutes' histograms. */
const latency = registerAppKeyed(new Map<string, LatMinute[]>())

function bucketOf(ms: number): number {
  for (let i = 0; i < LAT_BOUNDS_MS.length; i++) if (ms <= LAT_BOUNDS_MS[i]) return i
  return LAT_BOUNDS_MS.length
}

/** Counts one answer time for the current app. */
export function noteLatency(ms: number, now = Date.now()): void {
  if (!Number.isFinite(ms) || ms < 0) return
  const minute = Math.floor(now / 60_000)
  let ring = latency.get(currentTenantKey())
  if (!ring) {
    ring = []
    latency.set(currentTenantKey(), ring)
  }
  let m = ring[ring.length - 1]
  if (!m || m.minute !== minute) {
    m = { minute, h: new Array(BUCKETS).fill(0) }
    ring.push(m)
    if (ring.length > KEEP_MIN) ring.splice(0, ring.length - KEEP_MIN)
  }
  m.h[bucketOf(ms)]++
}

/** Element-wise sum of histograms (missing / damaged ones count as empty). */
export function addHistograms(list: ReadonlyArray<readonly number[] | null | undefined>): number[] {
  const out = new Array(BUCKETS).fill(0)
  for (const h of list) {
    if (!Array.isArray(h) || h.length !== BUCKETS) continue
    for (let i = 0; i < BUCKETS; i++) out[i] += Number.isFinite(h[i]) && h[i] > 0 ? h[i] : 0
  }
  return out
}

/** The p95 of a histogram: the upper bound of the bucket the 95th percentile falls in (null = no answers). */
export function p95Of(h: readonly number[]): number | null {
  const total = h.reduce((n, x) => n + x, 0)
  if (total === 0) return null
  const want = Math.ceil(total * 0.95)
  let seen = 0
  for (let i = 0; i < h.length; i++) {
    seen += h[i]
    if (seen >= want) return LAT_BOUNDS_MS[i] ?? LAT_BOUNDS_MS[LAT_BOUNDS_MS.length - 1] * 2
  }
  return null
}

/** This process's last WINDOW_MIN complete minutes, summed over every app it serves. */
export function processLatency(now = Date.now()): number[] {
  const cur = Math.floor(now / 60_000)
  const list: number[][] = []
  for (const ring of latency.values())
    for (const m of ring) if (m.minute < cur && m.minute >= cur - WINDOW_MIN) list.push(m.h)
  return addHistograms(list)
}

/** Heavy reads waiting in this process's read gate now (every app); null when unreadable. */
export async function heavyQueued(): Promise<number | null> {
  try {
    const { readGateProcessFigures } = await import('../read-gate.js')
    return readGateProcessFigures().queued
  } catch {
    return null
  }
}

/** The extra fields of a process snapshot. */
export async function snapshotExtras(now = Date.now()): Promise<{
  lat: number[]
  heavy_queued: number | null
}> {
  return { lat: processLatency(now), heavy_queued: await heavyQueued() }
}

export interface RoleScaleFigures {
  /** NIVARO_ROLE of the processes; null = a process that runs every role (`all`). */
  role: string | null
  processes: number
  /** p95 answer time over their last 5 complete minutes (ms; bucket bound); null = no answers. */
  p95_ms: number | null
  /** Heavy reads waiting, summed. */
  heavy_queued: number | null
}

/** Per role, from every fresh snapshot (each carries `role`, `lat` and `heavy_queued`). */
export function roleFigures(
  snaps: ReadonlyArray<{ role: string | null; lat?: number[]; heavy_queued?: number | null }>
): RoleScaleFigures[] {
  const by = new Map<
    string,
    { role: string | null; lat: number[][]; heavy: number | null; n: number }
  >()
  for (const s of snaps) {
    const k = s.role ?? ''
    const cur = by.get(k) ?? { role: s.role, lat: [], heavy: null, n: 0 }
    cur.n++
    if (Array.isArray(s.lat)) cur.lat.push(s.lat)
    if (typeof s.heavy_queued === 'number') cur.heavy = (cur.heavy ?? 0) + s.heavy_queued
    by.set(k, cur)
  }
  return [...by.values()]
    .map((v) => ({
      role: v.role,
      processes: v.n,
      p95_ms: v.lat.length ? p95Of(addHistograms(v.lat)) : null,
      heavy_queued: v.heavy
    }))
    .sort((a, b) => String(a.role ?? '').localeCompare(String(b.role ?? '')))
}

interface ListRedis {
  llen(key: string): Promise<number>
}

/** The hand-off queue keys of the current app (imports: runs + jobs; exports). */
async function queueKeys(): Promise<{ imports: string[]; exports: string[] }> {
  const imp = await import('../import-handoff.js')
  const exp = await import('../export-handoff.js')
  return {
    imports: [imp.importQueueKey(), imp.importJobQueueKey()],
    exports: [exp.exportQueueKey()]
  }
}

let redisOverride: ListRedis | null | undefined
/** Test seam: the Redis the queue lengths are read from (null = none). */
export function _setQueueRedisForTests(r: ListRedis | null | undefined): void {
  redisOverride = r
}

/**
 * Imports and exports waiting in the hand-off queues: every listed app on a shared deployment
 * (keys built inside each app's context), the one app on a dedicated process. null when Redis
 * cannot be read.
 */
export async function queueDepths(
  tenants: readonly TenantRecord[] | null
): Promise<{ imports: number | null; exports: number | null }> {
  const r =
    redisOverride !== undefined
      ? redisOverride
      : ((getApp()?.redis as ListRedis | undefined) ?? null)
  if (!r) return { imports: null, exports: null }
  try {
    const keys: Array<{ imports: string[]; exports: string[] }> = []
    if (tenants)
      for (const t of tenants.slice(0, 500))
        keys.push(await withTenant(t, () => queueKeys(), t.origin))
    else keys.push(await queueKeys())
    let imports = 0
    let exports = 0
    for (const k of keys) {
      for (const key of k.imports) imports += Number(await r.llen(key)) || 0
      for (const key of k.exports) exports += Number(await r.llen(key)) || 0
    }
    return { imports, exports }
  } catch {
    return { imports: null, exports: null }
  }
}

/** Test seam: forget every count. */
export function _resetScaleFiguresForTests(): void {
  latency.clear()
}
