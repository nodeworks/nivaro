// api/src/services/traffic-role-split.ts
/**
 * #2198 — web vs worker split: traffic, background jobs and pool use per process role. Every API
 * process puts NIVARO_ROLE on its instance-roster entry; the cluster snapshots (one per node)
 * are grouped by that role. A process with no NIVARO_ROLE counts as `unset`.
 *
 * Job runs come from the sources tap (one per cron tick / import run, whatever the job touched).
 * The core's `sources` rows are a different thing: browser sockets, live streams and MCP calls
 * land there too, and those always hit the web processes, so they never judge job placement.
 */
import type { TrafficSnapshot } from './traffic-map.js'
import type { SourceSnapshot } from './traffic-taps/sources.js'

/** Source kinds that are background jobs (flows ride the request or job that fired them). */
const JOB_KINDS = new Set(['cron', 'import'])
/** Source kinds that always arrive on the web processes (people's browsers and agents). */
const LIVE_KINDS = new Set(['socket', 'stream', 'mcp'])

export interface RoleGroup {
  role: string
  /** Processes answering in this role. */
  nodes: number
  /** Requests in the window (people, keys and anything else that hit the API). */
  req: number
  error: number
  /** Worst p95 latency among the role's processes. */
  p95: number
  /** Background job runs in the window: cron ticks and import runs (sources tap). */
  background: number
  /** Other non-request source calls: browser sockets, live streams, MCP tool calls. */
  live: number
  /** Busiest pool figure among the role's processes (null when none reported one). */
  pool: { peak_used: number; max: number; saturated_pct: number; wait_p95_ms: number } | null
}
export interface RoleSplit {
  window_s: number
  groups: RoleGroup[]
  /** Nodes that answered. */
  answered: number
  /** One plain sentence when the web processes run the jobs the workers should (null otherwise). */
  note: string | null
}

export const roleOf = (raw: unknown): string => {
  const r = typeof raw === 'string' ? raw.trim().toLowerCase().slice(0, 24) : ''
  return /^[a-z0-9_-]+$/.test(r) ? r : 'unset'
}

interface PoolFigure {
  peak_used?: number
  max?: number
  saturated_pct?: number
  wait_p95_ms?: number
}

/** Pure: group per-node snapshots by role (`roles` = node id to role, from the roster). */
export function splitByRole(
  snaps: Map<string, TrafficSnapshot>,
  roles: Map<string, string>,
  windowS: number
): RoleSplit {
  const groups = new Map<string, RoleGroup>()
  for (const [node, s] of snaps) {
    const role = roleOf(roles.get(node))
    let g = groups.get(role)
    if (!g) {
      g = { role, nodes: 0, req: 0, error: 0, p95: 0, background: 0, live: 0, pool: null }
      groups.set(role, g)
    }
    g.nodes++
    g.req += s.totals.req
    g.error += s.totals.error
    g.p95 = Math.max(g.p95, s.totals.p95)
    for (const x of s.sources ?? []) if (LIVE_KINDS.has(x.kind)) g.live += x.req
    const tap = s.ext?.sources as SourceSnapshot | undefined
    for (const x of Object.values(tap?.sources ?? {}))
      if (JOB_KINDS.has(x.kind)) g.background += Number(x.runs) || 0
    const p = s.ext?.pool as PoolFigure | undefined
    if (p && Number(p.max) > 0) {
      const next = {
        peak_used: Number(p.peak_used ?? 0),
        max: Number(p.max),
        saturated_pct: Number(p.saturated_pct ?? 0),
        wait_p95_ms: Number(p.wait_p95_ms ?? 0)
      }
      const cur = g.pool
      if (!cur || next.peak_used / next.max > cur.peak_used / cur.max) g.pool = next
    }
  }
  const list = [...groups.values()].sort((a, b) => a.role.localeCompare(b.role))
  return { window_s: windowS, groups: list, answered: snaps.size, note: roleNote(list) }
}

/** Workers should carry the background jobs; say so when the web processes do instead. */
export function roleNote(groups: RoleGroup[]): string | null {
  const web = groups.find((g) => g.role === 'web')
  const worker = groups.find((g) => g.role === 'worker')
  if (!web || !worker) return null
  if (web.background > 0 && worker.background === 0)
    return 'Scheduled jobs or imports ran on the web processes; the worker processes ran none.'
  if (worker.background > 0 && worker.background < web.background)
    return 'The web processes ran more scheduled jobs and imports than the workers.'
  return null
}
