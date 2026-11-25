import { db } from '../../../db/index.js'
import type { CapacityUsage } from '../../capacity/app-usage.js'
import { readLinkedUsage, readSharedUsage, type UsageRead } from '../capacity/client.js'
import type { StackRole, StackRoleName } from '../docker/agent-types.js'
import type { RoleFigureMap } from './rules.js'
import type { ScaleTarget } from './target.js'

/**
 * Nivaro Hub autoscaling: the figures a rule judges, per role, read live from the app over its
 * link (the capacity usage answer, services/capacity/app-usage.ts + scale-figures.ts): the shared
 * deployment's link, or a dedicated environment's hub link. Never throws; a figure the app does
 * not answer (an older app, a read that failed) is absent, never zero.
 *
 *   cpu_pct           mean CPU of the role's processes as % of its CPU limit (100 = the limit)
 *   memory_pct        mean memory of the role's processes as % of its memory limit
 *   requests_per_min  requests per minute per web replica (every request reaches web)
 *   p95_ms            p95 answer time of the role's processes, last 5 minutes
 *   heavy_queue       heavy reads waiting in the role's read gates, summed
 *   import_queue      imports waiting in the hand-off queue (importer)
 *   export_queue      exports waiting in the hand-off queue (exporter)
 */

export interface ScaleFigures {
  ok: boolean
  /** Why no figures (LINK_REFUSED, UNREACHABLE, NO_USAGE_ROUTE …). */
  code: string | null
  at: string | null
  partial: boolean
  byRole: Partial<Record<StackRoleName, RoleFigureMap>>
}

export type UsageReader = (t: ScaleTarget) => Promise<UsageRead>

/** The live usage answer of a target. */
export const readUsageOf: UsageReader = async (t) => {
  if (t.kind === 'shared') {
    if (!t.shared) return { ok: false, code: 'NOT_FOUND' }
    return readSharedUsage(t.shared)
  }
  const env = (await db('nivaro_hub_environments')
    .where({ id: t.id })
    .first('base_url', 'hub_token')) as { base_url: string; hub_token: string | null } | undefined
  if (!env) return { ok: false, code: 'NOT_FOUND' }
  return readLinkedUsage(env)
}

const round1 = (v: number) => Math.round(v * 10) / 10
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)

/** NIVARO_ROLE a process reports for a stack role (`all` runs without one). */
const reported = (role: StackRoleName): string | null => (role === 'all' ? null : role)

/** Per-role figures from one usage answer and the roles the stack runs (their limits). Pure. */
export function figuresFromUsage(
  usage: CapacityUsage,
  roles: readonly StackRole[]
): Partial<Record<StackRoleName, RoleFigureMap>> {
  const out: Partial<Record<StackRoleName, RoleFigureMap>> = {}
  const web = roles.find((r) => r.role === 'web' || r.role === 'all')
  for (const r of roles) {
    const procs = usage.processes.filter((p) => (p.role ?? null) === reported(r.role))
    const cpu = mean(procs.map((p) => p.cpu_pct).filter((x): x is number => typeof x === 'number'))
    const mem = mean(procs.map((p) => p.memory_mb).filter((x) => Number.isFinite(x) && x > 0))
    const fig: RoleFigureMap = {}
    if (cpu !== null && r.cpus) fig.cpu_pct = round1(cpu / r.cpus)
    if (mem !== null && r.memory_mb) fig.memory_pct = round1((mem / r.memory_mb) * 100)
    const extra = usage.roles?.find((x) => (x.role ?? null) === reported(r.role))
    if (extra && typeof extra.p95_ms === 'number') fig.p95_ms = extra.p95_ms
    if (extra && typeof extra.heavy_queued === 'number') fig.heavy_queue = extra.heavy_queued
    if (r === web && web.replicas > 0)
      fig.requests_per_min = round1(usage.totals.requests_per_min / web.replicas)
    if (r.role === 'importer' && typeof usage.queues?.imports === 'number')
      fig.import_queue = usage.queues.imports
    if (r.role === 'exporter' && typeof usage.queues?.exports === 'number')
      fig.export_queue = usage.queues.exports
    out[r.role] = fig
  }
  return out
}

export async function readScaleFigures(
  t: ScaleTarget,
  read: UsageReader = readUsageOf
): Promise<ScaleFigures> {
  let r: UsageRead
  try {
    r = await read(t)
  } catch {
    r = { ok: false, code: 'UNREACHABLE' }
  }
  if (!r.ok) return { ok: false, code: r.code, at: null, partial: false, byRole: {} }
  return {
    ok: true,
    code: null,
    at: r.usage.at,
    partial: r.usage.partial,
    byRole: figuresFromUsage(r.usage, t.roles)
  }
}
