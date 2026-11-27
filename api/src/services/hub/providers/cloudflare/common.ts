import { fieldWords, typedName } from '../plan-words.js'
import type {
  DesiredResource,
  FieldChange,
  HealthAnswer,
  ListPage,
  Observed,
  OpResult,
  PlannedOp,
  ProviderContext,
  ResourceTypeSpec,
  RiskFlag,
  SecretValue
} from '../types.js'

/**
 * What each Cloudflare resource type module exports (`TypeImpl`) and the shared pure planner they
 * build on. The adapter (index.ts) only dispatches by type key.
 */

export interface PermissionProbe {
  /** What the token needs ("read DNS records"), shown in the connection test. */
  need: string
  /** The permission-group name a token detail lists for it (write permission checks). */
  group?: string
  /** True when a read works (null = nothing to probe, e.g. no zone exists yet). */
  probe(ctx: ProviderContext): Promise<boolean | null>
}

export interface TypeImpl {
  spec: ResourceTypeSpec
  observe(ctx: ProviderContext, externalId: string): Promise<Observed | null>
  list(ctx: ProviderContext, cursor?: string | null): Promise<ListPage>
  plan(
    ctx: ProviderContext,
    desired: DesiredResource | null,
    observed: Observed | null
  ): PlannedOp[]
  apply(ctx: ProviderContext, op: PlannedOp, desired: DesiredResource | null): Promise<OpResult>
  findExisting?(ctx: ProviderContext, desired: DesiredResource): Promise<Observed | null>
  readOutputs?(ctx: ProviderContext, externalId: string): Promise<Record<string, string>>
  /** Task 43: a type that answers health (the registrar domain, for the domain watch). */
  health?(ctx: ProviderContext, externalId: string): Promise<HealthAnswer>
  permissions: PermissionProbe[]
}

export type Obj = Record<string, unknown>

export const asObj = (v: unknown): Obj =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {}
export const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
export const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).sort().join(',')}]`
  if (v && typeof v === 'object')
    return `{${Object.keys(v as Obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((v as Obj)[k])}`)
      .join(',')}}`
  return JSON.stringify(v ?? null)
}

/** A stable comparison form: lists and keys order-free, empty text and absent the same. */
export function norm(v: unknown): string {
  if (v === undefined || v === null || v === '') return 'null'
  return stable(v)
}
export const same = (a: unknown, b: unknown): boolean => norm(a) === norm(b)

export function ok(
  observed: Observed | null,
  externalId: string | null,
  status: number,
  outputs?: Record<string, string>
): OpResult {
  const out: OpResult = { ok: true, externalId, observed, answer: { status } }
  if (outputs && Object.keys(outputs).length) out.outputs = outputs
  return out
}

export const isSecret = (v: unknown): v is SecretValue =>
  !!v && typeof v === 'object' && 'fingerprint' in (v as Obj)

export interface PlanCfg {
  spec: ResourceTypeSpec
  /** Writable fields the diff compares, in order. */
  writable: string[]
  /** A change here replaces (delete + create). */
  replaceOn?: string[]
  nameOf(fields: Obj, observed: Observed | null): string
  /** Appended to the create reason ("a record with that name is refused: adopt it instead"). */
  createHint?: string
}

export function diffFields(
  cfg: PlanCfg,
  desired: DesiredResource,
  observed: Observed,
  keys = cfg.writable
): FieldChange[] {
  const changes: FieldChange[] = []
  for (const key of keys) {
    const f = cfg.spec.fields.find((x) => x.key === key)
    if (f?.kind === 'secret') {
      const v = desired.fields[key]
      if (isSecret(v) && v.changed) changes.push({ field: key, secret: true })
      continue
    }
    if (f?.kind === 'ref') {
      const want = desired.refs[key]
      if (typeof want === 'string' && want !== observed.fields[key])
        changes.push({ field: key, from: observed.fields[key], to: want })
      continue
    }
    const want = desired.fields[key]
    if (want === undefined) continue
    if (!same(want, observed.fields[key]))
      changes.push({ field: key, from: observed.fields[key], to: want })
  }
  return changes
}

/** The observed values an op depends on (secret fields have none). */
export function preconditionsOf(changes: FieldChange[], observed: Observed): Obj {
  const out: Obj = {}
  for (const c of changes) if (!c.secret) out[c.field] = observed.fields[c.field] ?? null
  return out
}

export function createChanges(cfg: PlanCfg, desired: DesiredResource): FieldChange[] {
  const changes: FieldChange[] = []
  for (const key of [...(cfg.replaceOn ?? []), ...cfg.writable]) {
    if (changes.some((c) => c.field === key)) continue
    const f = cfg.spec.fields.find((x) => x.key === key)
    if (f?.kind === 'secret') {
      const v = desired.fields[key]
      if (isSecret(v) && v.changed) changes.push({ field: key, secret: true })
      continue
    }
    if (f?.kind === 'ref') {
      const ref = desired.refs[key]
      if (ref !== undefined) changes.push({ field: key, to: ref })
      continue
    }
    if (desired.fields[key] !== undefined) changes.push({ field: key, to: desired.fields[key] })
  }
  return changes
}

/** The shared diff: create / delete / replace / update / noop with plain-sentence reasons. */
export function planGeneric(
  cfg: PlanCfg,
  desired: DesiredResource | null,
  observed: Observed | null
): PlannedOp[] {
  const label = cfg.spec.label
  const base = (
    kind: PlannedOp['kind'],
    externalId: string | null,
    reason: string,
    extra: Partial<PlannedOp> = {}
  ): PlannedOp => ({
    kind,
    type: cfg.spec.key,
    resourceId: desired?.resourceId ?? null,
    externalId,
    reason,
    changes: [],
    preconditions: {},
    risk: [] as RiskFlag[],
    ...extra
  })
  if (!desired) {
    if (!observed) return []
    return [
      base(
        'delete',
        observed.externalId,
        `Delete ${typedName(label, observed.name ?? observed.externalId)}.`,
        { preconditions: { name: observed.name } }
      )
    ]
  }
  const name = typedName(label, cfg.nameOf(desired.fields, observed))
  if (!observed)
    return [
      base('create', null, `Create ${name}${cfg.createHint ? ` (${cfg.createHint})` : ''}.`, {
        changes: createChanges(cfg, desired)
      })
    ]
  const replace = (cfg.replaceOn ?? []).filter((k) => {
    const f = cfg.spec.fields.find((x) => x.key === k)
    if (f?.kind === 'ref') {
      const want = desired.refs[k]
      return typeof want === 'string' && want !== observed.fields[k]
    }
    return desired.fields[k] !== undefined && !same(desired.fields[k], observed.fields[k])
  })
  if (replace.length)
    return [
      base(
        'replace',
        observed.externalId,
        `Replace ${name}: ${fieldWords(cfg.spec.fields, replace)} cannot change in place.`,
        {
          changes: replace.map((field) => ({
            field,
            from: observed.fields[field],
            to:
              cfg.spec.fields.find((x) => x.key === field)?.kind === 'ref'
                ? desired.refs[field]
                : desired.fields[field]
          })),
          preconditions: Object.fromEntries(replace.map((k) => [k, observed.fields[k] ?? null]))
        }
      )
    ]
  const changes = diffFields(
    cfg,
    desired,
    observed,
    cfg.writable.filter((k) => !(cfg.replaceOn ?? []).includes(k))
  )
  if (!changes.length) return [base('noop', observed.externalId, `${name} is up to date.`)]
  return [
    base(
      'update',
      observed.externalId,
      `Change ${fieldWords(cfg.spec.fields, changes)} on ${name}.`,
      {
        changes,
        preconditions: preconditionsOf(changes, observed)
      }
    )
  ]
}

export const FULL_CAPS = {
  create: true,
  update: true,
  delete: true,
  adopt: true,
  snapshot: false,
  tag: false
} as const
