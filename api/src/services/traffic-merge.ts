// api/src/services/traffic-merge.ts
/**
 * Merge several API processes' Traffic Map snapshots into one (#1098). Pure: counts add up,
 * latency takes the request-weighted mean (p50) or the worst node (p95), recent lists interleave
 * by time. A tap's figures cannot be merged generically, so the busiest node's win.
 */
import type { SnapshotEntity, TrafficSnapshot } from './traffic-map.js'

const RECENT = 12
const TOP = 5

function mergeTop<K extends string>(
  lists: Array<Array<{ n: number } & Record<string, unknown>>>,
  key: K
): Array<Record<K, string> & { n: number }> {
  const sums = new Map<string, number>()
  for (const l of lists)
    for (const r of l) sums.set(String(r[key]), (sums.get(String(r[key])) ?? 0) + r.n)
  return [...sums]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP)
    .map(([k, n]) => ({ [key]: k, n }) as Record<K, string> & { n: number })
}

function newestFirst<T extends { at: string }>(lists: T[][]): T[] {
  return lists
    .flat()
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, RECENT)
}

function mergeEntity(rows: SnapshotEntity[]): SnapshotEntity {
  const busiest = rows.reduce((a, b) => (b.req > a.req ? b : a))
  const req = rows.reduce((a, r) => a + r.req, 0)
  const len = Math.max(...rows.map((r) => r.series.length))
  const series = new Array<number>(len).fill(0)
  for (const r of rows)
    r.series.forEach((v, i) => {
      series[i] += v
    })
  const down: Record<string, number> = {}
  for (const r of rows) for (const [k, n] of Object.entries(r.down)) down[k] = (down[k] ?? 0) + n
  const out: SnapshotEntity = {
    key: busiest.key,
    lane: busiest.lane,
    entity: busiest.entity,
    label: busiest.label,
    system: busiest.system,
    req,
    read: rows.reduce((a, r) => a + r.read, 0),
    create: rows.reduce((a, r) => a + r.create, 0),
    update: rows.reduce((a, r) => a + r.update, 0),
    delete: rows.reduce((a, r) => a + r.delete, 0),
    error: rows.reduce((a, r) => a + r.error, 0),
    p50: req ? Math.round(rows.reduce((a, r) => a + r.p50 * r.req, 0) / req) : busiest.p50,
    p95: Math.max(...rows.map((r) => r.p95)),
    series,
    routes: mergeTop(rows.map((r) => r.routes) as never, 'route') as SnapshotEntity['routes'],
    callers: mergeTop(rows.map((r) => r.callers) as never, 'key') as SnapshotEntity['callers'],
    down,
    recent_errors: newestFirst(rows.map((r) => r.recent_errors)),
    recent_writes: newestFirst(rows.map((r) => r.recent_writes))
  }
  if (busiest.ext) out.ext = busiest.ext
  return out
}

/** One snapshot covering every node given (in any order); one node in = that node out. */
export function mergeSnapshots(snaps: TrafficSnapshot[]): TrafficSnapshot {
  if (snaps.length === 0) throw new Error('mergeSnapshots needs at least one snapshot')
  if (snaps.length === 1) return snaps[0]
  const busiest = snaps.reduce((a, b) => (b.totals.req > a.totals.req ? b : a))
  const byKey = new Map<string, SnapshotEntity[]>()
  for (const s of snaps)
    for (const e of s.entities) {
      const l = byKey.get(e.key)
      if (l) l.push(e)
      else byKey.set(e.key, [e])
    }
  const entities = [...byKey.values()].map(mergeEntity).sort((a, b) => b.req - a.req)

  const callers = new Map<string, { key: string; req: number; error: number }>()
  for (const s of snaps)
    for (const c of s.callers) {
      const cur = callers.get(c.key) ?? { key: c.key, req: 0, error: 0 }
      cur.req += c.req
      cur.error += c.error
      callers.set(c.key, cur)
    }
  const downs = new Map<string, TrafficSnapshot['down'][number]>()
  for (const s of snaps)
    for (const d of s.down) {
      const cur = downs.get(d.id)
      if (!cur) downs.set(d.id, { ...d })
      else {
        cur.req += d.req
        cur.error += d.error
        cur.p95 = Math.max(cur.p95, d.p95)
      }
    }
  const sources = new Map<string, NonNullable<TrafficSnapshot['sources']>[number]>()
  for (const s of snaps)
    for (const x of s.sources ?? []) {
      const cur = sources.get(x.id)
      if (!cur) sources.set(x.id, { ...x })
      else {
        cur.req += x.req
        cur.error += x.error
      }
    }
  const sum = (f: (t: TrafficSnapshot['totals']) => number) =>
    snaps.reduce((a, s) => a + f(s.totals), 0)
  const req = sum((t) => t.req)
  const out: TrafficSnapshot = {
    instance: busiest.instance,
    node_scope: `all ${snaps.length} API processes`,
    at: snaps.map((s) => s.at).sort()[snaps.length - 1],
    window_s: busiest.window_s,
    uptime_s: Math.max(...snaps.map((s) => s.uptime_s)),
    frame: Math.max(...snaps.map((s) => s.frame)),
    lanes: busiest.lanes,
    entities,
    callers: [...callers.values()].sort((a, b) => b.req - a.req),
    down: [...downs.values()],
    totals: {
      req,
      read: sum((t) => t.read),
      create: sum((t) => t.create),
      update: sum((t) => t.update),
      delete: sum((t) => t.delete),
      error: sum((t) => t.error),
      p50: req
        ? Math.round(snaps.reduce((a, s) => a + s.totals.p50 * s.totals.req, 0) / req)
        : busiest.totals.p50,
      p95: Math.max(...snaps.map((s) => s.totals.p95)),
      outbound_req: sum((t) => t.outbound_req),
      outbound_error: sum((t) => t.outbound_error)
    },
    // A person may hold sockets on several nodes: the busiest node's users is a floor.
    sockets: {
      count: snaps.reduce((a, s) => a + s.sockets.count, 0),
      users: Math.max(...snaps.map((s) => s.sockets.users))
    },
    journal_seq: snaps.reduce<number | null>(
      (a, s) => (s.journal_seq == null ? a : Math.max(a ?? 0, s.journal_seq)),
      null
    )
  }
  if (sources.size) out.sources = [...sources.values()].sort((a, b) => b.req - a.req)
  const ext = snaps.find((s) => s.ext)?.ext ? busiest.ext : undefined
  if (ext) out.ext = ext
  return out
}

export interface InstanceDiffRow {
  key: string
  label: string
  here: { req: number; error: number; p95: number }
  there: { req: number; error: number; p95: number }
  only: 'here' | 'there' | null
}
/** Entity by entity, this deployment against another (pure). */
export function diffInstances(here: TrafficSnapshot, there: TrafficSnapshot): InstanceDiffRow[] {
  const h = new Map(here.entities.map((e) => [e.key, e]))
  const t = new Map(there.entities.map((e) => [e.key, e]))
  const keys = new Set([...h.keys(), ...t.keys()])
  const pick = (e?: { req: number; error: number; p95: number }) => ({
    req: e?.req ?? 0,
    error: e?.error ?? 0,
    p95: e?.p95 ?? 0
  })
  const out: InstanceDiffRow[] = []
  for (const key of keys) {
    const a = h.get(key)
    const b = t.get(key)
    out.push({
      key,
      label: (a ?? b)?.label ?? key,
      here: pick(a),
      there: pick(b),
      only: a && !b ? 'here' : b && !a ? 'there' : null
    })
  }
  return out.sort((x, y) => Math.abs(y.here.req - y.there.req) - Math.abs(x.here.req - x.there.req))
}
