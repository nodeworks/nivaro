// api/src/services/traffic-snapshots.ts
/**
 * Snapshot storage helpers shared by the snapshot routes and the scheduler (#2173, #2174,
 * #2177, #2181): the kind of a snapshot, storing one, the difference between two, the small
 * picture of one, how much room map data takes, and pruning by the retention settings.
 *
 * A snapshot's kind rides inside its existing `filters` JSON column — `{"kind":"peak"}` or
 * `{"kind":"schedule"}` for the ones the server takes by itself (created_by NULL); a person's
 * snapshot has no kind. No migration: nivaro_traffic_snapshots stays as migration 386 made it.
 */
import { randomUUID } from 'node:crypto'
import { isMssql } from '../db/dialect.js'
import { db } from '../db/index.js'
import { getRealtimeStats } from '../plugins/socketio.js'
import { INSTANCE_ID } from './instance-roster.js'
import { trafficClusterRelay } from './traffic-cluster.js'
import { type MapEnvironment, mapEnvironment } from './traffic-environment.js'
import { buildSnapshot, type TrafficSnapshot } from './traffic-map.js'
import { mergeSnapshots } from './traffic-merge.js'

export const SNAPSHOT_TABLE = 'nivaro_traffic_snapshots'
export const INVESTIGATIONS_TABLE = 'nivaro_traffic_investigations'
export type SnapshotKind = 'manual' | 'peak' | 'schedule'
export const AUTO_KINDS: SnapshotKind[] = ['peak', 'schedule']

/** SQL fragment per auto kind, matched against the stored `filters` text (no user input). */
export const KIND_LIKE: Record<'peak' | 'schedule', string> = {
  peak: '%"kind":"peak"%',
  schedule: '%"kind":"schedule"%'
}

/** The kind a stored `filters` JSON names (pure): manual when it names none. */
export function kindOf(filters: unknown): SnapshotKind {
  if (typeof filters !== 'string' || !filters) return 'manual'
  try {
    const k = (JSON.parse(filters) as { kind?: unknown } | null)?.kind
    return k === 'peak' || k === 'schedule' ? k : 'manual'
  } catch {
    return 'manual'
  }
}

export function socketCounts(): { sockets: number; users: number } {
  const stats = getRealtimeStats()
  const users = new Set<string>()
  for (const s of stats.sockets) {
    const u = s.user as { id?: string } | string | null
    const id = typeof u === 'string' ? u : u?.id
    if (id) users.add(id)
  }
  return { sockets: stats.sockets.length, users: users.size }
}

/** The snapshot as stored: the map's own figures plus the environment it came from (#2242). */
export type StoredSnapshot = TrafficSnapshot & {
  environment?: Pick<MapEnvironment, 'name' | 'tier'>
}

export async function withEnvironment(snap: TrafficSnapshot): Promise<StoredSnapshot> {
  const env = await mapEnvironment()
  return { ...snap, environment: { name: env.name, tier: env.tier } }
}

/** Build the current map's snapshot for `store` (every node merged when a relay is up). */
export async function buildForStore(
  store: string,
  window: 60 | 300 | 900
): Promise<{ snap: TrafficSnapshot; scope: 'node' | 'cluster'; node: string | null }> {
  const relay = trafficClusterRelay()
  if (relay) {
    const all = await relay.collect(store, window)
    if (all.size > 1)
      return { snap: mergeSnapshots([...all.values()]), scope: 'cluster', node: null }
  }
  const { sockets, users } = socketCounts()
  return {
    snap: buildSnapshot(window, { sockets, users, journalSeq: null }),
    scope: 'node',
    node: INSTANCE_ID
  }
}

/** Insert a snapshot the server took by itself (no person, kind in `filters`). */
export async function storeAutoSnapshot(opts: {
  store: string
  kind: 'peak' | 'schedule'
  name: string
  note?: string | null
  window: 60 | 300 | 900
  at?: Date
}): Promise<{ id: string; name: string }> {
  const { snap, scope, node } = await buildForStore(opts.store, opts.window)
  const id = randomUUID()
  await db(SNAPSHOT_TABLE).insert({
    id,
    store: opts.store,
    name: opts.name.slice(0, 200),
    note: opts.note ? opts.note.slice(0, 2000) : null,
    window_s: opts.window,
    scope,
    node,
    instance: snap.instance,
    filters: JSON.stringify({ kind: opts.kind, win: opts.window }),
    selection: null,
    snapshot: JSON.stringify(await withEnvironment(snap)),
    catalog: null,
    created_by: null,
    created_at: opts.at ?? new Date()
  })
  return { id, name: opts.name }
}

// ── compare two snapshots (#2174) ────────────────────────────────────────────

export interface DiffSide {
  rpm: number
  error_rpm: number
  p95: number
}
export interface DiffNode {
  key: string
  label: string
  kind: 'entity' | 'caller' | 'partner' | 'service' | 'source'
  a: DiffSide
  b: DiffSide
  delta_rpm: number
  delta_pct: number | null
  /** Error-rate change in points (b minus a, on errors per request). */
  delta_error_pts: number
  delta_p95: number
  only: 'a' | 'b' | null
}
export interface DiffEdge {
  key: string
  from: string
  to: string
  label: string
  a_rpm: number
  b_rpm: number
  delta_rpm: number
  delta_pct: number | null
  only: 'a' | 'b' | null
}
export interface SnapshotDiff {
  a: { at: string; window_s: number; totals: TrafficSnapshot['totals']; environment?: string }
  b: { at: string; window_s: number; totals: TrafficSnapshot['totals']; environment?: string }
  /** The windows differ: figures are per minute so they still compare. */
  per_minute: true
  nodes: DiffNode[]
  edges: DiffEdge[]
  truncated: boolean
}
const DIFF_CAP = 150
const rpmOf = (n: number, windowS: number) =>
  Math.round((n / Math.max(1, windowS / 60)) * 100) / 100
const pctOf = (a: number, b: number) => (a > 0 ? Math.round(((b - a) / a) * 1000) / 10 : null)

interface Flat {
  key: string
  label: string
  kind: DiffNode['kind']
  req: number
  error: number
  p95: number
}
function flatNodes(s: TrafficSnapshot): Map<string, Flat> {
  const out = new Map<string, Flat>()
  for (const e of s.entities)
    out.set(`n:${e.key}`, {
      key: e.key,
      label: e.label,
      kind: 'entity',
      req: e.req,
      error: e.error,
      p95: e.p95
    })
  for (const c of s.callers)
    out.set(`c:${c.key}`, {
      key: c.key,
      label: c.key,
      kind: 'caller',
      req: c.req,
      error: c.error,
      p95: 0
    })
  for (const d of s.down)
    out.set(`d:${d.id}`, {
      key: d.id,
      label: d.label,
      kind: d.kind === 'partner' ? 'partner' : 'service',
      req: d.req,
      error: d.error,
      p95: d.p95
    })
  for (const x of s.sources ?? [])
    out.set(`s:${x.id}`, {
      key: x.id,
      label: x.label,
      kind: 'source',
      req: x.req,
      error: x.error,
      p95: 0
    })
  return out
}
function flatEdges(s: TrafficSnapshot): Map<string, { from: string; to: string; n: number }> {
  const out = new Map<string, { from: string; to: string; n: number }>()
  for (const e of s.entities) {
    for (const c of e.callers) out.set(`${c.key}>${e.key}`, { from: c.key, to: e.key, n: c.n })
    for (const [d, n] of Object.entries(e.down)) out.set(`${e.key}>${d}`, { from: e.key, to: d, n })
  }
  return out
}

/** Node by node and edge by edge, snapshot `a` against snapshot `b` (pure). */
export function diffSnapshots(a: StoredSnapshot, b: StoredSnapshot): SnapshotDiff {
  const na = flatNodes(a)
  const nb = flatNodes(b)
  const side = (f: Flat | undefined, w: number): DiffSide => ({
    rpm: f ? rpmOf(f.req, w) : 0,
    error_rpm: f ? rpmOf(f.error, w) : 0,
    p95: f?.p95 ?? 0
  })
  const nodes: DiffNode[] = []
  for (const k of new Set([...na.keys(), ...nb.keys()])) {
    const x = na.get(k)
    const y = nb.get(k)
    const sa = side(x, a.window_s)
    const sb = side(y, b.window_s)
    const errA = x && x.req ? x.error / x.req : 0
    const errB = y && y.req ? y.error / y.req : 0
    nodes.push({
      key: (x ?? y)!.key,
      label: (y ?? x)!.label,
      kind: (x ?? y)!.kind,
      a: sa,
      b: sb,
      delta_rpm: Math.round((sb.rpm - sa.rpm) * 100) / 100,
      delta_pct: pctOf(sa.rpm, sb.rpm),
      delta_error_pts: Math.round((errB - errA) * 1000) / 10,
      delta_p95: sb.p95 - sa.p95,
      only: x && !y ? 'a' : y && !x ? 'b' : null
    })
  }
  const ea = flatEdges(a)
  const eb = flatEdges(b)
  const edges: DiffEdge[] = []
  for (const k of new Set([...ea.keys(), ...eb.keys()])) {
    const x = ea.get(k)
    const y = eb.get(k)
    const ra = x ? rpmOf(x.n, a.window_s) : 0
    const rb = y ? rpmOf(y.n, b.window_s) : 0
    const e = (x ?? y)!
    edges.push({
      key: k,
      from: e.from,
      to: e.to,
      label: `${e.from} → ${e.to}`,
      a_rpm: ra,
      b_rpm: rb,
      delta_rpm: Math.round((rb - ra) * 100) / 100,
      delta_pct: pctOf(ra, rb),
      only: x && !y ? 'a' : y && !x ? 'b' : null
    })
  }
  const weight = (n: { delta_rpm: number }) => Math.abs(n.delta_rpm)
  nodes.sort((p, q) => weight(q) - weight(p) || p.key.localeCompare(q.key))
  edges.sort((p, q) => weight(q) - weight(p) || p.key.localeCompare(q.key))
  return {
    a: { at: a.at, window_s: a.window_s, totals: a.totals, environment: a.environment?.name },
    b: { at: b.at, window_s: b.window_s, totals: b.totals, environment: b.environment?.name },
    per_minute: true,
    nodes: nodes.slice(0, DIFF_CAP),
    edges: edges.slice(0, DIFF_CAP),
    truncated: nodes.length > DIFF_CAP || edges.length > DIFF_CAP
  }
}

// ── the small picture of a snapshot (#2181) ──────────────────────────────────

export interface SnapshotThumb {
  at: string
  window_s: number
  req: number
  error: number
  p95: number
  /** The busiest nodes: label, requests and errors in the window. */
  bars: Array<{ label: string; req: number; error: number }>
  environment: string | null
}
/** The few figures a thumbnail draws (pure). */
export function thumbOf(s: StoredSnapshot, bars = 7): SnapshotThumb {
  return {
    at: s.at,
    window_s: s.window_s,
    req: s.totals.req,
    error: s.totals.error,
    p95: s.totals.p95,
    bars: s.entities.slice(0, bars).map((e) => ({ label: e.label, req: e.req, error: e.error })),
    environment: s.environment?.name ?? null
  }
}

/**
 * The stored snapshot closest in time to `at` (within `withinMs`), from the rows between the two
 * bounds (pure): `rows` are id + created_at. Null when none is close enough.
 */
export function nearestSnapshot<T extends { created_at: Date | string }>(
  rows: T[],
  at: number,
  withinMs: number
): T | null {
  let best: T | null = null
  let bestGap = Number.POSITIVE_INFINITY
  for (const r of rows) {
    const t = new Date(r.created_at).getTime()
    if (Number.isNaN(t)) continue
    const gap = Math.abs(t - at)
    if (gap <= withinMs && gap < bestGap) {
      best = r
      bestGap = gap
    }
  }
  return best
}

// ── storage and retention (#2177) ────────────────────────────────────────────

export interface MapDataUsage {
  snapshots: { n: number; bytes: number; oldest: string | null }
  scheduled: { n: number; bytes: number; oldest: string | null }
  notebooks: { n: number; bytes: number; oldest: string | null }
}
const bytesOf = (cols: string[]): string => {
  const fn = isMssql(db) ? 'DATALENGTH' : 'LENGTH'
  return cols.map((c) => `COALESCE(${fn}(${c}), 0)`).join(' + ')
}

function num(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
function isoOrNull(v: unknown): string | null {
  if (!v) return null
  const d = new Date(v as string)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/** Rows and approximate bytes per kind of map data in `store`. */
export async function mapDataUsage(store: string): Promise<MapDataUsage> {
  const snapBytes = bytesOf(['snapshot', 'catalog', 'filters', 'selection', 'note', 'name'])
  const autoLike = `(filters LIKE '${KIND_LIKE.peak}' OR filters LIKE '${KIND_LIKE.schedule}')`
  const one = async (where: string) => {
    const row = (await db(SNAPSHOT_TABLE)
      .where('store', store)
      .whereRaw(where)
      .select(
        db.raw('COUNT(*) as n'),
        db.raw(`COALESCE(SUM(${snapBytes}), 0) as b`),
        db.raw('MIN(created_at) as oldest')
      )
      .first()) as Record<string, unknown> | undefined
    return { n: num(row?.n), bytes: num(row?.b), oldest: isoOrNull(row?.oldest) }
  }
  const manualLike = `(COALESCE(filters, '') NOT LIKE '${KIND_LIKE.peak}' AND COALESCE(filters, '') NOT LIKE '${KIND_LIKE.schedule}')`
  const snapshots = await one(manualLike)
  const scheduled = await one(autoLike)
  let notebooks: MapDataUsage['notebooks'] = { n: 0, bytes: 0, oldest: null }
  try {
    const nb = (await db(INVESTIGATIONS_TABLE)
      .where('store', store)
      .select(
        db.raw('COUNT(*) as n'),
        db.raw(`COALESCE(SUM(${bytesOf(['stack', 'notes', 'context', 'title'])}), 0) as b`),
        db.raw('MIN(updated_at) as oldest')
      )
      .first()) as Record<string, unknown> | undefined
    notebooks = { n: num(nb?.n), bytes: num(nb?.b), oldest: isoOrNull(nb?.oldest) }
  } catch {
    /* migration 390 not run here */
  }
  return { snapshots, scheduled, notebooks }
}

/** Cut-off timestamps for the retention days (pure); null = keep for ever. */
export function cutoffs(
  ret: { snapshots_days: number; scheduled_days: number; notebooks_days: number },
  now = Date.now()
): { snapshots: Date | null; scheduled: Date | null; notebooks: Date | null } {
  const at = (days: number) => (days > 0 ? new Date(now - days * 86_400_000) : null)
  return {
    snapshots: at(ret.snapshots_days),
    scheduled: at(ret.scheduled_days),
    notebooks: at(ret.notebooks_days)
  }
}

export interface PruneResult {
  snapshots: number
  scheduled: number
  notebooks: number
}

/** Delete what the retention settings say is old, in `store`. */
export async function pruneMapData(
  store: string,
  ret: { snapshots_days: number; scheduled_days: number; notebooks_days: number },
  now = Date.now()
): Promise<PruneResult> {
  const cut = cutoffs(ret, now)
  const out: PruneResult = { snapshots: 0, scheduled: 0, notebooks: 0 }
  if (cut.scheduled) {
    out.scheduled = Number(
      (await db(SNAPSHOT_TABLE)
        .where('store', store)
        .where('created_at', '<', cut.scheduled)
        .where((q) =>
          q.where('filters', 'like', KIND_LIKE.peak).orWhere('filters', 'like', KIND_LIKE.schedule)
        )
        .del()) ?? 0
    )
  }
  if (cut.snapshots) {
    out.snapshots = Number(
      (await db(SNAPSHOT_TABLE)
        .where('store', store)
        .where('created_at', '<', cut.snapshots)
        .where((q) =>
          q
            .whereNull('filters')
            .orWhere((n) =>
              n
                .where('filters', 'not like', KIND_LIKE.peak)
                .andWhere('filters', 'not like', KIND_LIKE.schedule)
            )
        )
        .del()) ?? 0
    )
  }
  if (cut.notebooks) {
    try {
      out.notebooks = Number(
        (await db(INVESTIGATIONS_TABLE)
          .where('store', store)
          .where('updated_at', '<', cut.notebooks)
          .del()) ?? 0
      )
    } catch {
      /* migration 390 not run here */
    }
  }
  return out
}
