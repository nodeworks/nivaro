// The scale request (agent 0.2.4): the ONLY change POST /v1/stacks/:name/scale may make is the
// replica count and the CPU / memory limits of roles the stack already runs. Pure: no I/O.
//
// The body carries the StackSpec the stack runs now (validated like an apply, then compared with
// the live stack hash, exactly as a restart does) and the roles to change. The agent builds the
// new spec itself — the old one with only those numbers replaced — and validates that again, so a
// scale can never add a role, remove one, touch an image, an env value, a secret, a hostname, an
// extension or a volume, and never leaves the apply allow-lists.
import type { FieldError, Role, RoleSpec, SpecConfig, StackSpec } from './spec.js'
import { ROLES, validateStackSpec } from './spec.js'

/** The bounds the spec validator holds every role to; answered by GET /v1/health (`scale`). */
export const SCALE_CAPS = {
  max_replicas: 10,
  max_total_replicas: 30,
  cpus: [0.1, 16] as const,
  memory_mb: [128, 65536] as const
} as const

/**
 * Roles whose replica count a scale never changes: the worker ticks every cron through one
 * leader (a second one only waits), and `all` is a whole stack in one process (small, or a SQLite
 * app's one writer). Their limits may change.
 */
export const FIXED_REPLICA_ROLES: readonly Role[] = ['worker', 'all']

export type ScaleChange = {
  role: Role
  replicas?: number
  cpus?: number
  memory_mb?: number
}

export type ScaleRequest = { spec: StackSpec; changes: ScaleChange[] }

export type ScaleCode =
  | 'UNKNOWN_FIELD'
  | 'REQUIRED'
  | 'ROLE_BAD'
  | 'ROLE_NOT_IN_STACK'
  | 'REPLICAS_BAD'
  | 'REPLICAS_FIXED'
  | 'LAST_WEB'
  | 'REALTIME_NEEDED'
  | 'LIMIT_BAD'
  | 'NOTHING_TO_CHANGE'

export type ScaleField = { field: string; code: ScaleCode | FieldError['code'] }

export type ScaleResult =
  | { ok: true; request: ScaleRequest; next: StackSpec }
  | { ok: false; status: 400; code: 'SPEC_INVALID' | 'SCALE_INVALID'; fields: ScaleField[] }

const TOP = new Set(['spec', 'roles'])
const CHANGE = new Set(['role', 'replicas', 'cpus', 'memory_mb'])

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

const capKey = (k: string) => (k.length > 64 ? `${k.slice(0, 64)}…` : k)

/** Some role keeps the stack's live connections off the web role (SOCKETS=off). */
function socketsOffSomewhere(roles: readonly RoleSpec[]): boolean {
  return roles.some((r) => r.env?.SOCKETS === 'off')
}

/**
 * Validates a scale body against the agent's own rules and answers the request plus the spec it
 * leads to. Refusals carry field paths and codes only (never a value).
 */
export function validateScaleRequest(body: unknown, cfg: SpecConfig): ScaleResult {
  const fields: ScaleField[] = []
  const bad = (field: string, code: ScaleField['code']) => {
    if (fields.length < 100) fields.push({ field, code })
  }
  if (!isPlainObject(body))
    return {
      ok: false,
      status: 400,
      code: 'SCALE_INVALID',
      fields: [{ field: '', code: 'REQUIRED' }]
    }
  for (const k of Object.keys(body)) if (!TOP.has(k)) bad(capKey(k), 'UNKNOWN_FIELD')

  const v = validateStackSpec(body.spec, cfg)
  if (!v.ok)
    return {
      ok: false,
      status: 400,
      code: 'SPEC_INVALID',
      fields: v.fields.map((f) => ({ field: `spec.${f.field}`, code: f.code }))
    }
  const spec = v.spec

  const changes: ScaleChange[] = []
  if (!Array.isArray(body.roles) || body.roles.length === 0) bad('roles', 'REQUIRED')
  else {
    const seen = new Set<string>()
    body.roles.forEach((raw: unknown, i: number) => {
      const p = `roles[${i}]`
      if (!isPlainObject(raw)) {
        bad(p, 'REQUIRED')
        return
      }
      for (const k of Object.keys(raw))
        if (!CHANGE.has(k)) bad(`${p}.${capKey(k)}`, 'UNKNOWN_FIELD')
      const role = raw.role
      if (
        typeof role !== 'string' ||
        !(ROLES as readonly string[]).includes(role) ||
        seen.has(role)
      ) {
        bad(`${p}.role`, 'ROLE_BAD')
        return
      }
      seen.add(role)
      const current = spec.roles.find((r) => r.role === role)
      if (!current) {
        bad(`${p}.role`, 'ROLE_NOT_IN_STACK')
        return
      }
      const out: ScaleChange = { role: role as Role }
      if (Object.hasOwn(raw, 'replicas')) {
        const n = raw.replicas
        if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > SCALE_CAPS.max_replicas)
          bad(`${p}.replicas`, 'REPLICAS_BAD')
        else if (FIXED_REPLICA_ROLES.includes(role as Role) && n !== current.replicas)
          bad(`${p}.replicas`, 'REPLICAS_FIXED')
        else if (role === 'web' && n < 1) bad(`${p}.replicas`, 'LAST_WEB')
        else if (role === 'realtime' && n < 1 && socketsOffSomewhere(spec.roles))
          bad(`${p}.replicas`, 'REALTIME_NEEDED')
        else out.replicas = n
      }
      if (Object.hasOwn(raw, 'cpus')) {
        const c = raw.cpus
        if (
          typeof c !== 'number' ||
          !Number.isFinite(c) ||
          c < SCALE_CAPS.cpus[0] ||
          c > SCALE_CAPS.cpus[1]
        )
          bad(`${p}.cpus`, 'LIMIT_BAD')
        else out.cpus = c
      }
      if (Object.hasOwn(raw, 'memory_mb')) {
        const m = raw.memory_mb
        if (
          typeof m !== 'number' ||
          !Number.isInteger(m) ||
          m < SCALE_CAPS.memory_mb[0] ||
          m > SCALE_CAPS.memory_mb[1]
        )
          bad(`${p}.memory_mb`, 'LIMIT_BAD')
        else out.memory_mb = m
      }
      if (!['replicas', 'cpus', 'memory_mb'].some((k) => Object.hasOwn(raw, k)))
        bad(p, 'NOTHING_TO_CHANGE')
      changes.push(out)
    })
  }
  if (fields.length) return { ok: false, status: 400, code: 'SCALE_INVALID', fields }

  const next = scaledSpec(spec, changes)
  // The new spec is held to every apply rule again (total replicas ≤ 30 included).
  const again = validateStackSpec(next, cfg)
  if (!again.ok)
    return {
      ok: false,
      status: 400,
      code: 'SCALE_INVALID',
      fields: again.fields.map((f) => ({ field: f.field, code: f.code }))
    }
  return { ok: true, request: { spec, changes }, next: again.spec }
}

/** The spec with only the named roles' replicas and limits replaced (a fresh object). */
export function scaledSpec(spec: StackSpec, changes: readonly ScaleChange[]): StackSpec {
  const next = structuredClone(spec)
  for (const c of changes) {
    const r = next.roles.find((x) => x.role === c.role)
    if (!r) continue
    if (c.replicas !== undefined) r.replicas = c.replicas
    if (c.cpus !== undefined) r.cpus = c.cpus
    if (c.memory_mb !== undefined) r.memory_mb = c.memory_mb
  }
  return next
}
