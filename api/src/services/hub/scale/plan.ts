import { createHash } from 'node:crypto'
import type { AgentHealth, StackRoleName, StackScaleChange } from '../docker/agent-types.js'
import type { DockerDriverRow } from '../drivers.js'
import { type ConnMath, connectionMath } from './connections.js'
import { type Pause, type PauseDeps, scalePauses } from './pause.js'
import {
  DEFAULT_CAPS,
  FIXED_ROLES,
  figuresOf,
  isRoleName,
  isScalable,
  processCount,
  ROLE_MIN,
  type RoleFigures,
  SCALE_AGENT_MIN_VERSION,
  type ScaleCaps,
  scaleAgentOk
} from './shape.js'
import { readRoles } from './store.js'
import { healthReader, type LoadCache, otherLoads, type ScaleTarget } from './target.js'

/**
 * Nivaro Hub scaling: the plan of one change to a stack's replicas and limits. Reads only: never
 * applies anything, never writes a row. A manual start is bound to the plan's `plan_hash`; an
 * automatic change plans the same way and starts only when the plan has no blocker.
 *
 * Blockers: the target's own (NOT_DOCKER, NOT_DEPLOYED, SHARED_RETIRED …); the change itself
 * (ROLE_NOT_RUNNING, REPLICAS_FIXED — the worker stays at 1, BELOW_MIN — never below 1 web /
 * realtime / importer / exporter, OVER_CAP, LIMIT_BAD, NO_CHANGE); SQLITE_ONE_PROCESS (a SQLite
 * app never runs past one process); AGENT_UNREACHABLE / AGENT_TOO_OLD (scaling needs Hub agent
 * 0.2.4); DB_CONNECTIONS (connections.ts); and what holds the stack now (pause.ts).
 *
 * Steps: one, except that a realtime scale-in goes one replica at a time — each step waits for
 * swarm to settle and for the closed sockets to reconnect elsewhere before the next.
 */

export interface RoleChangeInput {
  role: StackRoleName
  replicas?: number
  cpus?: number
  memory_mb?: number
}

export interface ScalePlan {
  kind: ScaleTarget['kind']
  id: number
  key: string
  label: string
  stack: string | null
  production: boolean
  from: RoleFigures[]
  to: RoleFigures[]
  /** What the agent is asked to change (only the changed numbers). */
  changes: StackScaleChange[]
  /** The shape after each step (the last = `to`). */
  steps: RoleFigures[][]
  connections: ConnMath
  blockers: Pause[]
  warnings: Pause[]
  /** Type this to start (production environment or a shared deployment); null = no typing. */
  confirm: string | null
  agent: { version: string | null; ok: boolean }
  caps: ScaleCaps
  plan_hash: string
}

export class ScaleError extends Error {
  code: string
  statusCode: number
  constructor(code: string, message: string, statusCode = 409) {
    super(message)
    this.name = 'ScaleError'
    this.code = code
    this.statusCode = statusCode
  }
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

/** A request body's `roles` list, shape-checked (values are judged by the plan). */
export function parseRoleChanges(raw: unknown): RoleChangeInput[] | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 6)
    return { error: 'roles is a list of {role, replicas?, cpus?, memory_mb?}.' }
  const out: RoleChangeInput[] = []
  for (const r of raw) {
    if (!isObj(r) || !isRoleName(r.role)) return { error: 'Each change names a role.' }
    if (out.some((x) => x.role === r.role)) return { error: `${r.role} is named twice.` }
    const c: RoleChangeInput = { role: r.role }
    for (const k of ['replicas', 'cpus', 'memory_mb'] as const) {
      const v = r[k]
      if (v === undefined || v === null) continue
      if (typeof v !== 'number' || !Number.isFinite(v))
        return { error: `${r.role}: ${k} is a number.` }
      c[k] = v
    }
    out.push(c)
  }
  return out
}

function capsOf(h: AgentHealth | null): ScaleCaps {
  const c = h?.scale
  if (!c) return DEFAULT_CAPS
  const pair = (v: unknown, d: [number, number]): [number, number] =>
    Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === 'number') ? [v[0], v[1]] : d
  return {
    max_replicas: Number.isInteger(c.max_replicas) ? c.max_replicas : DEFAULT_CAPS.max_replicas,
    max_total_replicas: Number.isInteger(c.max_total_replicas)
      ? c.max_total_replicas
      : DEFAULT_CAPS.max_total_replicas,
    cpus: pair(c.cpus, DEFAULT_CAPS.cpus),
    memory_mb: pair(c.memory_mb, DEFAULT_CAPS.memory_mb)
  }
}

/** The steps from `from` to `to`: everything at once, a realtime scale-in one replica a step. */
export function stepsBetween(from: RoleFigures[], to: RoleFigures[]): RoleFigures[][] {
  const rtFrom = from.find((r) => r.role === 'realtime')?.replicas ?? 0
  const rtTo = to.find((r) => r.role === 'realtime')?.replicas ?? 0
  if (rtTo >= rtFrom - 1) return [to.map((r) => ({ ...r }))]
  const steps: RoleFigures[][] = []
  for (let n = rtFrom - 1; n >= rtTo; n--)
    steps.push(to.map((r) => (r.role === 'realtime' ? { ...r, replicas: n } : { ...r })))
  return steps
}

/** The agent's change list from one shape to the next (only the numbers that differ). */
export function changesBetween(from: RoleFigures[], to: RoleFigures[]): StackScaleChange[] {
  const out: StackScaleChange[] = []
  for (const t of to) {
    const f = from.find((x) => x.role === t.role)
    if (!f) continue
    const c: StackScaleChange = { role: t.role }
    if (f.replicas !== t.replicas) c.replicas = t.replicas
    if (t.cpus !== null && f.cpus !== t.cpus) c.cpus = t.cpus
    if (t.memory_mb !== null && f.memory_mb !== t.memory_mb) c.memory_mb = t.memory_mb
    if (Object.keys(c).length > 1) out.push(c)
  }
  return out
}

function hashOf(v: unknown): string {
  return createHash('sha256').update(JSON.stringify(v)).digest('hex')
}

export interface PlanDeps extends PauseDeps {
  health?: (d: DockerDriverRow | null) => Promise<AgentHealth | null>
  otherLoads?: typeof otherLoads
  /** One tick's (or plan's) reads of other stacks (target.ts LoadCache). */
  loadCache?: LoadCache
}

/** Plans `changes` on `t` (a fresh read of the target). Throws ScaleError only for bad input. */
export async function planScale(
  t: ScaleTarget,
  changes: RoleChangeInput[],
  mode: 'manual' | 'auto',
  deps: PlanDeps = {}
): Promise<ScalePlan> {
  const blockers: Pause[] = []
  const warnings: Pause[] = []
  const block = (code: string, text: string) => {
    if (!blockers.some((b) => b.code === code && b.text === text)) blockers.push({ code, text })
  }
  if (t.unusable) block(t.unusable.code, t.unusable.text)

  const health = await (deps.health ?? healthReader())(t.driver)
  const caps = capsOf(health)
  if (t.driver && !health)
    block('AGENT_UNREACHABLE', 'The Hub agent does not answer: the Hub cannot scale the stack now.')
  else if (health && !scaleAgentOk(health.agent_version))
    block(
      'AGENT_TOO_OLD',
      `The Hub agent is ${String(health.agent_version ?? 'unknown').slice(0, 32)}; scaling needs ${SCALE_AGENT_MIN_VERSION} or later.`
    )

  const from = figuresOf(t.roles)
  const to = from.map((r) => ({ ...r }))
  for (const c of changes) {
    const cur = to.find((r) => r.role === c.role)
    if (!cur) {
      block('ROLE_NOT_RUNNING', `The stack runs no ${c.role} role (size ${t.size}).`)
      continue
    }
    if (c.replicas !== undefined && c.replicas !== cur.replicas) {
      if (!Number.isInteger(c.replicas) || c.replicas < 0)
        block('OVER_CAP', `${c.role}: replicas is a whole number.`)
      else if (FIXED_ROLES.includes(c.role) || !isScalable(c.role))
        block(
          'REPLICAS_FIXED',
          c.role === 'worker'
            ? 'The worker stays at one replica: it ticks every scheduled job through one leader.'
            : `${c.role} runs the whole stack in one service: change the stack's size instead.`
        )
      else if (c.replicas < (ROLE_MIN[c.role] ?? 1))
        block('BELOW_MIN', `${c.role} never goes below ${ROLE_MIN[c.role] ?? 1} replica.`)
      else if (c.replicas > caps.max_replicas)
        block(
          'OVER_CAP',
          `${c.role}: the agent allows at most ${caps.max_replicas} replicas a role.`
        )
      else cur.replicas = c.replicas
    }
    if (c.cpus !== undefined) {
      if (c.cpus < caps.cpus[0] || c.cpus > caps.cpus[1])
        block('LIMIT_BAD', `${c.role}: CPUs are ${caps.cpus[0]}–${caps.cpus[1]}.`)
      else cur.cpus = Math.round(c.cpus * 100) / 100
    }
    if (c.memory_mb !== undefined) {
      if (
        !Number.isInteger(c.memory_mb) ||
        c.memory_mb < caps.memory_mb[0] ||
        c.memory_mb > caps.memory_mb[1]
      )
        block('LIMIT_BAD', `${c.role}: memory is ${caps.memory_mb[0]}–${caps.memory_mb[1]} MB.`)
      else cur.memory_mb = c.memory_mb
    }
  }
  const procFrom = processCount(from)
  const procTo = processCount(to)
  if (procTo > caps.max_total_replicas)
    block(
      'OVER_CAP',
      `The agent allows at most ${caps.max_total_replicas} replicas a stack (${procTo} asked).`
    )
  if (t.sqlite && procTo > 1)
    block(
      'SQLITE_ONE_PROCESS',
      t.kind === 'shared'
        ? 'An app on this deployment uses a SQLite database, which one process writes: the deployment never runs past one process.'
        : 'This environment’s database is a SQLite file, which one process writes: its stack never runs past one process.'
    )
  const agentChanges = changesBetween(from, to)
  if (!agentChanges.length && !blockers.some((b) => b.code === 'ROLE_NOT_RUNNING'))
    block('NO_CHANGE', 'Nothing changes: the stack already runs these numbers.')

  // The connection math, with every other Hub stack on the same database servers.
  const serverIds = (
    t.kind === 'shared' ? (t.apps ?? []).map((a) => a.server?.id) : [t.server?.id]
  ).filter((x): x is number => typeof x === 'number')
  const others = await (deps.otherLoads ?? otherLoads)(
    [...new Set(serverIds)],
    { kind: t.kind, id: t.id },
    deps.loadCache
  )
  const withOthers = <S extends { id: number; others: number } | null | undefined>(s: S): S =>
    s ? { ...s, others: others.get(s.id) ?? 0 } : s
  const connections =
    t.kind === 'shared'
      ? connectionMath({
          kind: 'shared',
          processes: { from: procFrom, to: procTo },
          budget: t.shared?.pool_budget ?? 60,
          apps: (t.apps ?? []).map((a) => ({ ...a, server: withOthers(a.server) }))
        })
      : connectionMath({
          kind: 'environment',
          processes: { from: procFrom, to: procTo },
          pools: t.pools ?? { main: 60, background: 10 },
          server: withOthers(t.server ?? null)
        })
  for (const r of connections.refusals) block(r.code, r.text)
  warnings.push(...connections.warnings)
  // No limit to judge by (a server without max_connections, or no database record): automatic
  // scaling never adds connections blind; a person may, with the typed key. Fewer always passes.
  const blindOut = connections.limit_unknown && connections.total.to > connections.total.from
  if (blindOut && mode === 'auto')
    block(
      'DB_LIMIT_UNKNOWN',
      'The database server’s connection limit is not known, so autoscaling does not add processes. Set the limit under Database server limits on the Scaling tab.'
    )
  else if (blindOut)
    warnings.push({
      code: 'DB_LIMIT_UNKNOWN',
      text: 'The database server’s connection limit is not known, so the Hub cannot check this change against it. Type the key to go ahead anyway.'
    })

  // A person's change outside an enabled rule's range is moved back by autoscaling.
  if (mode === 'manual')
    for (const row of await readRoles(t.kind, t.id)) {
      const r = row.auto
      const want = to.find((x) => x.role === row.role)
      const had = from.find((x) => x.role === row.role)
      if (!r?.enabled || row.pinned || !want || !had || want.replicas === had.replicas) continue
      if (want.replicas < r.min || want.replicas > r.max)
        warnings.push({
          code: 'AUTOSCALE_WILL_MOVE',
          text: `${want.role} ${want.replicas} is outside its autoscaling rule (${r.min}–${r.max}): the rule moves it back to ${want.replicas < r.min ? r.min : r.max}. Pin the role to manual to keep it.`
        })
    }

  const pauses = await scalePauses(t, mode, deps)
  for (const b of pauses.blockers) block(b.code, b.text)
  warnings.push(...pauses.warnings)

  const rtFrom = from.find((r) => r.role === 'realtime')?.replicas ?? 0
  const rtTo = to.find((r) => r.role === 'realtime')?.replicas ?? 0
  if (rtTo < rtFrom)
    warnings.push({
      code: 'REALTIME_DRAIN',
      text: `Realtime goes from ${rtFrom} to ${rtTo} one replica at a time: each stopped process closes its live connections and the browsers reconnect to the others before the next step.`
    })
  if (to.some((r, i) => r.cpus !== from[i].cpus || r.memory_mb !== from[i].memory_mb))
    warnings.push({
      code: 'ROLLING_RESTART',
      text: 'A limit changes: swarm replaces that role’s processes one at a time, each new one started before the old one stops.'
    })

  const steps = stepsBetween(from, to)
  const plan_hash = hashOf({
    kind: t.kind,
    id: t.id,
    stack: t.stack,
    version: t.version,
    from,
    to,
    blockers: blockers.map((b) => b.code)
  })
  return {
    kind: t.kind,
    id: t.id,
    key: t.key,
    label: t.label,
    stack: t.stack,
    production: t.production,
    from,
    to,
    changes: agentChanges,
    steps,
    connections,
    blockers,
    warnings,
    confirm: t.production || t.kind === 'shared' || blindOut ? t.confirm : null,
    agent: {
      version: typeof health?.agent_version === 'string' ? health.agent_version.slice(0, 32) : null,
      ok: !!health && scaleAgentOk(health.agent_version)
    },
    caps,
    plan_hash
  }
}
