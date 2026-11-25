import { db } from '../../../db/index.js'
import { agentStack } from '../docker/agent-client.js'
import type { StackRoleName, StackStatus } from '../docker/agent-types.js'
import { deployedStack } from '../docker/stack-guards.js'
import type { DockerDriverRow } from '../drivers.js'
import { listShared } from '../shared/store.js'
import { maxedRoles } from './auto.js'
import { type PlanDeps, planScale } from './plan.js'
import { MAX_HITS_WARN, maxHits24h, ROLE_METRICS } from './rules.js'
import { FIXED_ROLES, isScalable, ROLE_MIN } from './shape.js'
import {
  listRuns,
  openRunOf,
  type RoleRow,
  readRoles,
  type ScaleRun,
  type TargetKind
} from './store.js'
import {
  environmentTarget,
  healthReader,
  readTarget,
  type ScaleTarget,
  sharedTarget
} from './target.js'

/**
 * Nivaro Hub scaling view (the Scaling tab): every Docker stack with, per role, the replicas and
 * limits the Hub keeps (template + shape), whether it is pinned to manual and its rule; one stack
 * in detail with what swarm runs now, the connections now, the recent runs and skipped decisions.
 * Reads only.
 */

export interface RoleView {
  role: StackRoleName
  /** What the Hub renders (template + kept shape). */
  replicas: number
  cpus: number | null
  memory_mb: number | null
  /** The size template's numbers (no shape). */
  template: { replicas: number; cpus: number | null; memory_mb: number | null }
  /** The replica count may change (web, realtime, importer, exporter). */
  scalable: boolean
  min: number
  pinned: boolean
  auto: RoleRow['auto']
  /** Metrics a rule of this role may use. */
  metrics: readonly string[]
  /** Times the rule wanted more than its max in 24 h (≥ 3 = warning). */
  max_hits: number
  last_change_at: string | null
  /** The rule paused itself after repeated failed runs (Resume rule lifts it). */
  paused_at: string | null
  paused_reason: string | null
  /** What swarm runs now (detail only; null = unknown). */
  running?: { desired: number; running: number } | null
}

export interface TargetView {
  kind: TargetKind
  id: number
  key: string
  label: string
  production: boolean
  stack: string | null
  size: string
  version: string | null
  sqlite: boolean
  unusable: ScaleTarget['unusable']
  roles: RoleView[]
  autoscaling: boolean
  maxed: boolean
  open_run: { id: number; source: string; reason: string | null } | null
  last_run: Pick<
    ScaleRun,
    'id' | 'source' | 'status' | 'reason' | 'created_at' | 'error_code'
  > | null
}

function rolesOf(t: ScaleTarget, rows: RoleRow[], now: number): RoleView[] {
  return t.roles.map((r) => {
    const row = rows.find((x) => x.role === r.role)
    const tpl = t.template.find((x) => x.role === r.role)
    return {
      role: r.role,
      replicas: r.replicas,
      cpus: r.cpus ?? null,
      memory_mb: r.memory_mb ?? null,
      template: {
        replicas: tpl?.replicas ?? r.replicas,
        cpus: tpl?.cpus ?? null,
        memory_mb: tpl?.memory_mb ?? null
      },
      scalable: isScalable(r.role) && !FIXED_ROLES.includes(r.role) && !t.sqlite,
      min: ROLE_MIN[r.role] ?? 1,
      pinned: row?.pinned ?? false,
      auto: row?.auto ?? null,
      metrics: ROLE_METRICS[r.role] ?? [],
      max_hits: row ? maxHits24h(row.state, now) : 0,
      last_change_at: row?.state.last_change_at ?? null,
      paused_at: row?.state.paused_at ?? null,
      paused_reason: row?.state.paused_reason ?? null
    }
  })
}

async function viewOf(t: ScaleTarget, now: number): Promise<TargetView> {
  const rows = await readRoles(t.kind, t.id)
  const roles = rolesOf(t, rows, now)
  const open = await openRunOf(t.kind, t.id)
  const last = (await listRuns(t.kind, t.id, 1))[0] ?? null
  return {
    kind: t.kind,
    id: t.id,
    key: t.key,
    label: t.label,
    production: t.production,
    stack: t.stack,
    size: t.size,
    version: t.version,
    sqlite: t.sqlite,
    unusable: t.unusable,
    roles,
    autoscaling: roles.some((r) => r.auto?.enabled && !r.pinned),
    maxed: roles.some((r) => r.max_hits >= MAX_HITS_WARN),
    open_run: open ? { id: open.id, source: open.source, reason: open.reason } : null,
    last_run: last
      ? {
          id: last.id,
          source: last.source,
          status: last.status,
          reason: last.reason,
          created_at: last.created_at,
          error_code: last.error_code
        }
      : null
  }
}

/** Every environment on a Hub Docker stack and every Docker shared deployment. */
export async function scaleOverview(now = Date.now()): Promise<{
  targets: TargetView[]
  maxed: Awaited<ReturnType<typeof maxedRoles>>
}> {
  const health = healthReader()
  const envRows = (await db('nivaro_hub_environments as e')
    .join('nivaro_hub_placements as p', 'p.id', 'e.placement_id')
    .join('nivaro_hub_drivers as d', 'd.id', 'p.driver_id')
    .whereNot('p.kind', 'shared')
    .where('d.kind', 'docker')
    .whereNot('e.status', 'archived')
    .orderBy('e.app_id', 'asc')
    .orderBy('e.position', 'asc')
    .select('e.id')) as Array<{ id: number }>
  const targets: TargetView[] = []
  for (const r of envRows.slice(0, 500)) {
    const t = await environmentTarget(Number(r.id), health)
    if (t) targets.push(await viewOf(t, now))
  }
  for (const s of await listShared()) {
    if (s.mode !== 'docker' || s.status === 'retired') continue
    const t = await sharedTarget(s.id)
    if (t) targets.push(await viewOf(t, now))
  }
  return { targets, maxed: await maxedRoles(now) }
}

export interface TargetDetail extends TargetView {
  /** What swarm says now; null = the agent did not answer. */
  status: { state: string; spec_hash: string | null } | null
  now: {
    connections: Awaited<ReturnType<typeof planScale>>['connections']
    blockers: Awaited<ReturnType<typeof planScale>>['blockers']
    warnings: Awaited<ReturnType<typeof planScale>>['warnings']
    agent: Awaited<ReturnType<typeof planScale>>['agent']
    caps: Awaited<ReturnType<typeof planScale>>['caps']
    confirm: string | null
  }
  runs: ScaleRun[]
}

export async function scaleDetail(
  kind: TargetKind,
  id: number,
  deps: PlanDeps & {
    agentStack?: (d: DockerDriverRow, name: string, expect?: string) => Promise<StackStatus | null>
    now?: number
  } = {}
): Promise<TargetDetail | null> {
  const t = await readTarget(kind, id, deps.health)
  if (!t) return null
  const now = deps.now ?? Date.now()
  const view = await viewOf(t, now)
  let status: TargetDetail['status'] = null
  if (t.driver && t.stack) {
    try {
      const expect =
        t.kind === 'environment'
          ? await deployedStack(t.id, t.stack).then((d) => (d.state === 'ok' ? d.specHash : null))
          : null
      const st = await (deps.agentStack ?? agentStack)(t.driver, t.stack, expect ?? undefined)
      if (st) {
        status = { state: st.state, spec_hash: st.spec_hash }
        for (const r of view.roles) {
          const svc = st.services.find((s) => s.role === r.role)
          r.running = svc ? { desired: svc.replicas.desired, running: svc.replicas.running } : null
        }
      }
    } catch {
      status = null
    }
  }
  const plan = await planScale(t, [], 'manual', deps)
  return {
    ...view,
    status,
    now: {
      connections: plan.connections,
      blockers: plan.blockers.filter((b) => b.code !== 'NO_CHANGE'),
      warnings: plan.warnings,
      agent: plan.agent,
      caps: plan.caps,
      confirm: plan.confirm
    },
    runs: await listRuns(kind, id, 30)
  }
}
