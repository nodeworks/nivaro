import type { StackRole, StackRoleName } from '../docker/agent-types.js'
import { agentVersionAtLeast } from '../docker/templates.js'

/**
 * Nivaro Hub scaling (manual + automatic): the shape a Docker stack runs — per role, the replica
 * count and CPU / memory limits the Hub keeps on top of the size template. Pure.
 *
 * The size templates (docker/templates.ts for dedicated stacks, shared/stack-render.ts for shared
 * deployments) say which roles a stack runs and their defaults. A scale changes only those
 * numbers, for roles the stack already runs; the shape is stored per target
 * (nivaro_hub_scale_roles) and laid over the template by BOTH renderers (applyScaleShape), so a
 * promotion, an Apply now, an upgrade, a move or a restart renders the scaled stack, never the
 * template's numbers again. A role the template no longer has (a size change) keeps its stored
 * numbers but they apply to nothing.
 *
 * Rules (also held by the agent, packages/hub-agent/src/scale.ts):
 *   - replicas change only for web, realtime, importer and exporter (SCALABLE_ROLES); the worker
 *     stays at 1 (cron leader + per-app jobs) and `all` is a whole stack in one process;
 *   - never below 1 web, 1 realtime, 1 importer or 1 exporter where the stack runs one (ROLE_MIN);
 *   - limits (cpus, memory_mb) for every role, inside the agent's caps.
 */

/** Roles whose replica count the Hub changes. */
export const SCALABLE_ROLES: readonly StackRoleName[] = ['web', 'realtime', 'importer', 'exporter']

/** Roles whose replica count never changes (the agent refuses REPLICAS_FIXED). */
export const FIXED_ROLES: readonly StackRoleName[] = ['worker', 'all']

/** The lowest replica count of a scalable role the stack runs. */
export const ROLE_MIN: Readonly<Record<string, number>> = {
  web: 1,
  realtime: 1,
  importer: 1,
  exporter: 1
}

/** Hub agents from this version answer POST /v1/stacks/:name/scale. */
export const SCALE_AGENT_MIN_VERSION = '0.2.4'

export const scaleAgentOk = (v: unknown) => agentVersionAtLeast(v, SCALE_AGENT_MIN_VERSION)

/** The caps an agent 0.2.4 answers (and the spec validator holds every agent to). */
export const DEFAULT_CAPS = {
  max_replicas: 10,
  max_total_replicas: 30,
  cpus: [0.1, 16] as [number, number],
  memory_mb: [128, 65536] as [number, number]
}

export type ScaleCaps = typeof DEFAULT_CAPS

export interface RoleScale {
  replicas?: number
  cpus?: number
  memory_mb?: number
}

/** Role → the numbers the Hub keeps for it. */
export type ScaleShape = Partial<Record<StackRoleName, RoleScale>>

/** One role of a stack as the Hub shows it: replicas and limits. */
export interface RoleFigures {
  role: StackRoleName
  replicas: number
  cpus: number | null
  memory_mb: number | null
}

const ROLE_NAMES: readonly StackRoleName[] = [
  'all',
  'web',
  'worker',
  'realtime',
  'importer',
  'exporter'
]

export const isRoleName = (v: unknown): v is StackRoleName =>
  typeof v === 'string' && (ROLE_NAMES as readonly string[]).includes(v)

export const isScalable = (role: StackRoleName) => SCALABLE_ROLES.includes(role)

const int = (v: unknown, lo: number, hi: number): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : undefined
const num = (v: unknown, lo: number, hi: number): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : undefined

/** One stored role's numbers, each kept only when it is one the agent takes. */
export function roleScaleOf(raw: {
  replicas?: unknown
  cpus?: unknown
  memory_mb?: unknown
}): RoleScale {
  const out: RoleScale = {}
  const r = int(raw.replicas, 0, DEFAULT_CAPS.max_replicas)
  const c = num(raw.cpus, DEFAULT_CAPS.cpus[0], DEFAULT_CAPS.cpus[1])
  const m = int(raw.memory_mb, DEFAULT_CAPS.memory_mb[0], DEFAULT_CAPS.memory_mb[1])
  if (r !== undefined) out.replicas = r
  if (c !== undefined) out.cpus = c
  if (m !== undefined) out.memory_mb = m
  return out
}

/**
 * The template's roles with the stored shape laid over them (a fresh copy): replicas only for
 * scalable roles (never below ROLE_MIN), limits for any role. A null / empty shape answers the
 * roles unchanged, so a stack never scaled renders exactly the spec (and hash) it had.
 */
export function applyScaleShape(
  roles: readonly StackRole[],
  shape: ScaleShape | null | undefined
): StackRole[] {
  const out = structuredClone(roles) as StackRole[]
  if (!shape) return out
  for (const r of out) {
    const s = shape[r.role]
    if (!s) continue
    if (s.replicas !== undefined && isScalable(r.role))
      r.replicas = Math.max(ROLE_MIN[r.role] ?? 1, s.replicas)
    if (s.cpus !== undefined) r.cpus = s.cpus
    if (s.memory_mb !== undefined) r.memory_mb = s.memory_mb
  }
  return out
}

/** What each role runs, in the order given. */
export function figuresOf(roles: readonly StackRole[]): RoleFigures[] {
  return roles.map((r) => ({
    role: r.role,
    replicas: r.replicas,
    cpus: r.cpus ?? null,
    memory_mb: r.memory_mb ?? null
  }))
}

/** Total processes of Nivaro roles (bundled Redis is not a Nivaro process). */
export function processCount(roles: readonly { replicas: number }[]): number {
  return roles.reduce((n, r) => n + r.replicas, 0)
}

/** "web 3 → 5, realtime 2" style text for logs, notices and run rows. */
export function shapeText(from: readonly RoleFigures[], to: readonly RoleFigures[]): string {
  const parts: string[] = []
  for (const t of to) {
    const f = from.find((x) => x.role === t.role)
    const bits: string[] = []
    if (!f || f.replicas !== t.replicas) bits.push(`${f ? `${f.replicas} → ` : ''}${t.replicas}`)
    if (f && f.cpus !== t.cpus) bits.push(`CPU ${f.cpus ?? 'none'} → ${t.cpus ?? 'none'}`)
    if (f && f.memory_mb !== t.memory_mb)
      bits.push(`memory ${f.memory_mb ?? 'none'} → ${t.memory_mb ?? 'none'} MB`)
    if (bits.length) parts.push(`${t.role} ${bits.join(', ')}`)
  }
  return parts.join('; ') || 'no change'
}
