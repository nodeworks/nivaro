import { ChaosError } from './gate.js'

/**
 * The fault catalog (#2827): every fault a drill can arm, with what it proves, where it acts
 * (its fault points), the targets it accepts and the caps on its parameters. Fault clusters add
 * entries in `faults/<area>.ts` (one `registerFault` call each) and import them from
 * `faults/index.ts`; the console's Faults tab, the start form and the server-side validation
 * all read this one list.
 */

/** Who a fault reaches. `all` = everything passing its points on this instance. */
export type FaultTarget = (
  | { kind: 'all' }
  /** A route pattern: a path prefix, or a glob with `*` (`/api/items/*`). */
  | { kind: 'route'; pattern: string }
  | { kind: 'table'; table: string }
  | { kind: 'user'; user_id: string; name?: string | null }
  /** A share of what passes the point (0–100), picked by a stable hash of the context key. */
  | { kind: 'share'; share_pct: number }
  /** One replica, by its node id (ChaosStatus.nodes). */
  | { kind: 'node'; node: string }
  /** A socket room (socket drills, #2463). */
  | { kind: 'room'; room: string }
) & {
  /**
   * #2862 — a share cap sampled ON TOP of the target match (0–100, stable hash of the context
   * key), set by the caps on every non-share target so a wide pattern cannot reach everything.
   */
  sample_pct?: number
}

export type TargetKind = FaultTarget['kind']

export type ParamSpec =
  | {
      type: 'number'
      label: string
      min: number
      max: number
      default: number
      unit?: string
      step?: number
    }
  | { type: 'boolean'; label: string; default: boolean }
  | { type: 'string'; label: string; default?: string; max_length?: number; pattern?: string }
  | { type: 'enum'; label: string; options: string[]; default: string }

export type FaultParams = Record<string, number | string | boolean>

/** A line of a steady-state hypothesis (#2828): `sampler op limit`, tolerance in the same unit. */
export interface HypothesisRule {
  sampler: string
  op: '<' | '<=' | '>' | '>='
  limit: number
  tolerance?: number
}

export interface ArmedFault {
  id: string
  fault_key: string
  label: string
  target: FaultTarget
  params: FaultParams
  started_at: number
  ends_at: number
  started_by: string | null
  started_by_name: string | null
  run_id: string | null
  /** The replica that armed it. */
  node: string
}

/** What a fault's `apply` gets: the armed fault plus the Fastify app (may be null in tests). */
export interface ApplyContext {
  app: unknown | null
  /** True on the replica that armed the fault. */
  origin: boolean
}

export type Release = () => void | Promise<void>

export interface FaultDefinition {
  key: string
  label: string
  /** The degradation claim this fault proves, as a sentence. */
  proves: string
  /** Resilience scorecard claim keys (#2830) this fault proves. */
  claim_keys: string[]
  targets: TargetKind[]
  params: Record<string, ParamSpec>
  /** Hard cap on one run; the start form and the server clamp to it. */
  max_seconds: number
  default_seconds?: number
  /** Fault point names this fault acts at (`chaosPoint(name)` returns it there). */
  points: string[]
  /** How much it can hurt; the console colours accordingly. */
  danger?: 'low' | 'medium' | 'high'
  /**
   * Side effects beyond the fault points (disconnect Redis, start a socket drill…). Runs on
   * every replica that arms the fault, or only where it was started (`apply_scope: 'origin'`).
   * Returns the undo, called on disarm, expiry and Stop all.
   */
  apply?: (
    fault: ArmedFault,
    ctx: ApplyContext
  ) => Promise<Release | undefined> | Release | undefined
  apply_scope?: 'origin' | 'every'
  /** Hypothesis lines the start form offers by default (#2828). */
  hypothesis_defaults?: HypothesisRule[]
  /** Where the console sends people instead of its own start form (socket drills → /realtime). */
  console_href?: string
  /** The area that registered it (`http`, `socket`, `db`…), for grouping cards. */
  area?: string
}

const faults = new Map<string, FaultDefinition>()

const KEY_RE = /^[a-z][a-z0-9_]{1,60}$/

/** Add a fault to the catalog (idempotent by key: a re-register replaces). */
export function registerFault(def: FaultDefinition): FaultDefinition {
  if (!KEY_RE.test(def.key)) throw new Error(`chaos: bad fault key "${def.key}"`)
  if (!(def.max_seconds > 0)) throw new Error(`chaos: ${def.key} needs max_seconds`)
  if (!def.points.length && !def.apply) throw new Error(`chaos: ${def.key} does nothing`)
  faults.set(def.key, def)
  return def
}

export function getFault(key: string): FaultDefinition | null {
  return faults.get(key) ?? null
}

export function listFaults(): FaultDefinition[] {
  return [...faults.values()]
}

/** The point → fault keys index the registry's hot path uses. */
export function faultsAtPoint(point: string): FaultDefinition[] {
  const out: FaultDefinition[] = []
  for (const f of faults.values()) if (f.points.includes(point)) out.push(f)
  return out
}

/** Seconds clamped to [5, max] (default when missing). */
export function clampSeconds(def: FaultDefinition, raw: unknown): number {
  const d = def.default_seconds ?? Math.min(60, def.max_seconds)
  const n = raw == null || raw === '' ? d : Number(raw)
  if (!Number.isFinite(n)) return d
  return Math.round(Math.min(def.max_seconds, Math.max(5, n)))
}

/**
 * Checked params: unknown keys dropped, numbers clamped into the spec's range, enums checked,
 * defaults filled. Throws a ChaosError naming every bad field (a wrong type, an unknown enum
 * value) — clamping is silent because the server caps are the contract, not the form.
 */
export function validateParams(def: FaultDefinition, raw: unknown): FaultParams {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const out: FaultParams = {}
  const bad: string[] = []
  for (const [name, spec] of Object.entries(def.params)) {
    const v = r[name]
    if (spec.type === 'number') {
      if (v == null || v === '') out[name] = spec.default
      else {
        const n = Number(v)
        if (!Number.isFinite(n)) bad.push(`${name} must be a number`)
        else out[name] = Math.min(spec.max, Math.max(spec.min, n))
      }
    } else if (spec.type === 'boolean') {
      out[name] = v == null ? spec.default : v === true || v === 'true' || v === 1
    } else if (spec.type === 'enum') {
      const s = v == null || v === '' ? spec.default : String(v)
      if (!spec.options.includes(s)) bad.push(`${name} must be one of ${spec.options.join(', ')}`)
      else out[name] = s
    } else {
      const s = v == null ? (spec.default ?? '') : String(v)
      if (spec.max_length && s.length > spec.max_length) bad.push(`${name} is too long`)
      else if (spec.pattern && s && !new RegExp(spec.pattern).test(s))
        bad.push(`${name} has the wrong shape`)
      else out[name] = s
    }
  }
  if (bad.length) throw new ChaosError(bad.join('; '), 400, 'CHAOS_PARAMS')
  return out
}

const UUID_RE = /^[0-9a-f-]{36}$/i
const ROUTE_RE = /^\/[\w./*:-]{0,200}$/
const TABLE_RE = /^[\w.]{1,128}$/
const NODE_RE = /^[\w .·:-]{1,120}$/
const ROOM_RE = /^[\w.:@/-]{1,200}$/

/** A checked target the fault accepts (throws ChaosError), keeping a valid `sample_pct`. */
export function validateTarget(def: FaultDefinition, raw: unknown): FaultTarget {
  const t = validateTargetKind(def, raw)
  const sample = Number((raw as { sample_pct?: unknown } | null)?.sample_pct)
  if (t.kind !== 'share' && Number.isFinite(sample) && sample > 0 && sample < 100)
    return { ...t, sample_pct: sample }
  return t
}

function validateTargetKind(def: FaultDefinition, raw: unknown): FaultTarget {
  const t = (raw && typeof raw === 'object' ? raw : { kind: 'all' }) as Record<string, unknown>
  const kind = String(t.kind ?? 'all') as TargetKind
  if (!def.targets.includes(kind))
    throw new ChaosError(`${def.key} cannot target ${kind}; choose ${def.targets.join(', ')}`)
  switch (kind) {
    case 'all':
      return { kind: 'all' }
    case 'route': {
      const pattern = String(t.pattern ?? '').trim()
      if (!ROUTE_RE.test(pattern))
        throw new ChaosError('target.pattern must be a path like /api/items/*')
      if (pattern.split('*').length > 5)
        throw new ChaosError('target.pattern may hold at most four *')
      return { kind: 'route', pattern }
    }
    case 'table': {
      const table = String(t.table ?? '').trim()
      if (!TABLE_RE.test(table)) throw new ChaosError('target.table must be a table name')
      return { kind: 'table', table }
    }
    case 'user': {
      const id = String(t.user_id ?? '')
      if (!UUID_RE.test(id)) throw new ChaosError('target.user_id must be a user id')
      return { kind: 'user', user_id: id.toLowerCase(), name: t.name ? String(t.name) : null }
    }
    case 'share': {
      const pct = Number(t.share_pct)
      if (!Number.isFinite(pct) || pct <= 0 || pct > 100)
        throw new ChaosError('target.share_pct must be above 0 and at most 100')
      return { kind: 'share', share_pct: pct }
    }
    case 'node': {
      const node = String(t.node ?? '').trim()
      if (!NODE_RE.test(node)) throw new ChaosError('target.node must be a replica node id')
      return { kind: 'node', node }
    }
    case 'room': {
      const room = String(t.room ?? '').trim()
      if (!ROOM_RE.test(room)) throw new ChaosError('target.room must be a room name')
      if (/^(session|masq):/.test(room)) throw new ChaosError('sign-in rooms cannot be targeted')
      return { kind: 'room', room }
    }
    default:
      throw new ChaosError(`unknown target kind ${String(kind)}`)
  }
}

/** A target as the banner may show it: never a person id or a raw pattern. */
export function describeTarget(t: FaultTarget): string {
  const base = describeTargetKind(t)
  return t.sample_pct != null && t.kind !== 'share' ? `${t.sample_pct}% of ${base}` : base
}

function describeTargetKind(t: FaultTarget): string {
  switch (t.kind) {
    case 'all':
      return 'everything'
    case 'route':
      return 'some routes'
    case 'table':
      return 'one table'
    case 'user':
      return 'one person'
    case 'share':
      return `${t.share_pct}% of traffic`
    case 'node':
      return 'one replica'
    case 'room':
      return 'one room'
  }
}

/** Tests only. */
export function _resetCatalogForTests(): void {
  faults.clear()
}
