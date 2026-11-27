import { createHash, createHmac } from 'node:crypto'
import { HUB_MASK, openSecret, sealSecret } from '../../secrets.js'
import { makeProviderContext } from '../context.js'
import { ensureCoreProviders } from '../index.js'
import { findType, getProvider } from '../registry.js'
import {
  type HubConnectionRow,
  type HubResourceRow,
  listResources,
  openConnectionSecrets,
  readConnection,
  type StoredSecretField
} from '../store.js'
import {
  type DesiredResource,
  type FieldChange,
  type FieldSpec,
  type Observed,
  type OpKind,
  type PlannedOp,
  type ProviderAdapter,
  type ProviderContext,
  ProviderError,
  type ResourceTypeSpec,
  type RiskFlag,
  type SecretValue
} from '../types.js'
import {
  type ChangeBlocker,
  type ChangeGate,
  type HubActor,
  type PlanAction,
  type PlanRequest,
  type PlanRequestOp,
  RESOURCE_CHANGE_CODES,
  type ResourceChangeCode,
  ResourceChangeError,
  type StoredChangePlan
} from './contract.js'
import { engineDeps } from './deps.js'
import { type AccessAnswer, judgeAccess, judgeChangeGates } from './gates.js'

/**
 * Hub provider changes, step 1 — the plan (spec "The change engine"). Reads the provider
 * (`observe`), asks the adapter to diff desired vs observed, fills in risk, orders the ops by
 * their references, and binds the result with a `plan_hash` over the ops AND a precondition
 * fingerprint of the observed values each op depends on. Nothing is written at the provider.
 *
 * Conventions the engine owns (adapters and the REST layer follow them):
 *
 *  - A `ref` field holds `{resourceId}`. A NEGATIVE id points at a create in the same request:
 *    `{resourceId: -1}` = request op 0, `-2` = op 1… (so a VPC and its subnet are planned in one
 *    change; apply runs the parent first and swaps in the new row id).
 *  - A `secret` field in a request is the plain new value, or HUB_MASK to keep the stored one.
 *    The STORED plan never holds a plain value: request ops keep `{fingerprint, changed}` and
 *    the new plain values travel in ONE sealed envelope `StoredChangePlan.sealed` (sealSecret,
 *    ENCRYPTION_KEY) that the run opens for `apply` only. Never answer `plan.sealed` (use
 *    `publicStoredPlan`).
 *  - Op `data` keys an adapter may set for the engine: `$blocker: {code, message}` (stops the
 *    start, e.g. BUCKET_NOT_EMPTY), `$confirm: string` (the exact text to type, e.g. "delete all
 *    objects in my-bucket"), `$adminOnly: true` (owners may not start it).
 *  - Op `preconditions` keys starting with `$` read the observed top level: `$version`,
 *    `$status`, `$name`, `$tags`, `$exists`; any other key reads `observed.fields[key]`. An
 *    update/replace/delete an adapter left without preconditions gets the observed values of
 *    the fields it changes (+ `$version` when the provider has one, + `$exists`).
 */

// ── Canonical JSON + hashes ──

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (isRecord(v))
    return `{${Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(',')}}`
  if (v === undefined) return 'null'
  return JSON.stringify(v)
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

/** A stable fingerprint of one plain secret field value (HMAC keyed by ENCRYPTION_KEY). */
export function secretFieldFingerprint(plain: string): string {
  const key = process.env.ENCRYPTION_KEY ?? ''
  const k = createHash('sha256').update(`hub-resource-secret-fp|${key}`).digest()
  return createHmac('sha256', k).update(plain).digest('hex').slice(0, 32)
}

export function preconditionFingerprint(ops: PlannedOp[]): string {
  return sha256(canonical(ops.map((o) => o.preconditions ?? {})))
}

/** The hash a start must send back: ops + precondition fingerprint + what the request applies. */
export function planHashOf(stored: StoredChangePlan): string {
  return sha256(
    canonical({
      v: 1,
      connectionId: stored.request.connectionId,
      scope: stored.request.scope,
      appId: stored.request.appId ?? null,
      environmentId: stored.request.environmentId ?? null,
      request: stored.request.ops,
      ops: stored.ops,
      resourceIds: stored.resourceIds,
      sources: stored.sources ?? null,
      preconditionFingerprint: stored.preconditionFingerprint,
      undoOf: stored.undoOf ?? null
    })
  )
}

/** The stored plan without its sealed envelope (what may be answered or logged). */
export function publicStoredPlan(plan: StoredChangePlan): Omit<StoredChangePlan, 'sealed'> {
  const { sealed: _sealed, ...rest } = plan as StoredChangePlan & { sealed?: unknown }
  return rest
}

// ── Sealed envelope of new secret values ──

/** `<request op index>:<field>` → plain. */
export type SealedSecrets = Record<string, string>

export function openSealedSecrets(sealed: string | null | undefined): SealedSecrets {
  if (!sealed) return {}
  const plain = openSecret(sealed)
  if (!plain) return {}
  try {
    const v = JSON.parse(plain) as unknown
    if (!isRecord(v)) return {}
    const out: SealedSecrets = {}
    for (const [k, x] of Object.entries(v)) if (typeof x === 'string') out[k] = x
    return out
  } catch {
    return {}
  }
}

const sealedKey = (index: number, field: string) => `${index}:${field}`

// ── Field specs ──

const isStoredSecret = (v: unknown): v is StoredSecretField =>
  isRecord(v) && typeof v.$sealed === 'string' && typeof v.fingerprint === 'string'
const isPlanSecret = (v: unknown): v is { fingerprint: string; changed: boolean } =>
  isRecord(v) && typeof v.fingerprint === 'string' && typeof v.changed === 'boolean'

export function refTypeOf(spec: FieldSpec): string | null {
  if (spec.kind === 'ref') return spec.refType ?? null
  if (spec.kind === 'list' && spec.items?.kind === 'ref') return spec.items.refType ?? null
  return null
}

const isRefField = (spec: FieldSpec) =>
  spec.kind === 'ref' || (spec.kind === 'list' && spec.items?.kind === 'ref')

/** Every `{resourceId}` a fields object points at, per ref field. */
export function refsIn(
  type: ResourceTypeSpec,
  fields: Record<string, unknown> | null
): Array<{ field: string; resourceId: number }> {
  const out: Array<{ field: string; resourceId: number }> = []
  if (!fields) return out
  for (const spec of type.fields) {
    if (!isRefField(spec)) continue
    const v = fields[spec.key]
    for (const x of Array.isArray(v) ? v : v == null ? [] : [v])
      if (isRecord(x) && Number.isInteger(Number(x.resourceId)))
        out.push({ field: spec.key, resourceId: Number(x.resourceId) })
  }
  return out
}

interface Problem {
  field: string
  message: string
}

function checkValue(spec: FieldSpec, v: unknown, path: string, problems: Problem[]): void {
  if (v == null) return
  const bad = (message: string): void => {
    problems.push({ field: path, message })
  }
  switch (spec.kind) {
    case 'string': {
      if (typeof v !== 'string') {
        bad('must be text')
        return
      }
      if (spec.pattern) {
        let re: RegExp | null = null
        try {
          re = new RegExp(spec.pattern)
        } catch {
          re = null
        }
        if (re && !re.test(v)) bad('is not in the expected form')
      }
      if (spec.min != null && v.length < spec.min) bad(`must be at least ${spec.min} characters`)
      if (spec.max != null && v.length > spec.max) bad(`must be at most ${spec.max} characters`)
      return
    }
    case 'number': {
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        bad('must be a number')
        return
      }
      if (spec.min != null && v < spec.min) bad(`must be at least ${spec.min}`)
      if (spec.max != null && v > spec.max) bad(`must be at most ${spec.max}`)
      return
    }
    case 'boolean':
      if (typeof v !== 'boolean') bad('must be true or false')
      return
    case 'enum':
      if (!(spec.options ?? []).some((o) => o.value === v)) bad('is not one of the choices')
      return
    case 'list': {
      if (!Array.isArray(v)) {
        bad('must be a list')
        return
      }
      if (spec.min != null && v.length < spec.min) bad(`needs at least ${spec.min} items`)
      if (spec.max != null && v.length > spec.max) bad(`takes at most ${spec.max} items`)
      if (spec.items)
        v.forEach((x, i) => {
          checkValue(spec.items as FieldSpec, x, `${path}[${i}]`, problems)
        })
      return
    }
    case 'object': {
      if (!isRecord(v)) {
        bad('must be an object')
        return
      }
      if (!spec.fields) return
      for (const k of Object.keys(v))
        if (!spec.fields.some((f) => f.key === k)) bad(`has an unknown part ${k}`)
      for (const sub of spec.fields) {
        if (sub.required && (v[sub.key] == null || v[sub.key] === ''))
          problems.push({ field: `${path}.${sub.key}`, message: 'is required' })
        checkValue(sub, v[sub.key], `${path}.${sub.key}`, problems)
      }
      return
    }
    case 'ref':
      if (!isRecord(v) || !Number.isInteger(v.resourceId) || v.resourceId === 0)
        bad('must name a managed resource')
      return
    case 'secret':
      if (typeof v !== 'string') bad('must be text')
      return
  }
}

const invalid = (problems: Problem[]) =>
  new ResourceChangeError(
    'INVALID_FIELDS',
    `Check these fields: ${problems
      .slice(0, 8)
      .map((p) => `${p.field} ${p.message}`)
      .join('; ')}.`,
    { problems }
  )

/** Row-form desired (secrets sealed) → stored-plan form (secrets as {fingerprint, changed:false}). */
export function planFormOf(type: ResourceTypeSpec, desired: Record<string, unknown> | null) {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(desired ?? {})) {
    const spec = type.fields.find((f) => f.key === k)
    if (spec?.kind === 'secret')
      out[k] = isStoredSecret(v) ? { fingerprint: v.fingerprint, changed: false } : undefined
    else out[k] = v
  }
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k]
  return out
}

/**
 * The readable observed values as desired fields (an adopted resource nobody edited): refs from
 * provider ids to managed rows (`unresolved` = a ref the Hub does not manage), secrets left out.
 */
export function desiredFromObservedFields(
  type: ResourceTypeSpec,
  o: Observed | null,
  rowOf: (refType: string, externalId: string) => number | null
): { fields: Record<string, unknown>; unresolved: string[] } {
  const fields: Record<string, unknown> = {}
  const unresolved: string[] = []
  if (!o) return { fields, unresolved }
  for (const spec of type.fields) {
    if (spec.readOnly || spec.kind === 'secret' || !(spec.key in o.fields)) continue
    const v = o.fields[spec.key]
    if (isRefField(spec)) {
      const ids = (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]).map(String)
      const rows = ids.map((id) => rowOf(refTypeOf(spec) ?? '', id))
      if (rows.some((r) => r == null)) {
        unresolved.push(spec.key)
        continue
      }
      const refs = rows.map((resourceId) => ({ resourceId: resourceId as number }))
      fields[spec.key] = spec.kind === 'ref' ? (refs[0] ?? null) : refs
      continue
    }
    fields[spec.key] = v
  }
  return { fields, unresolved }
}

// ── Plan inputs ──

export interface PlanOptions {
  /** 'request' = a person's request (plain / HUB_MASK secrets); 'stored' = a stored plan's
   *  request (secrets as {fingerprint, changed}, new values in `sealed`); 'internal' = an engine
   *  request (undo: secrets may be StoredSecretField). */
  mode: 'request' | 'stored' | 'internal'
  sealed?: string | null
  undoOf?: number | null
}

export interface ComputedPlan {
  stored: StoredChangePlan
  planHash: string
  /** The first change gate that stops a start now (freeze, window, open move…), or null. */
  gateRefusal: ResourceChangeError | null
  access: AccessAnswer
  connection: HubConnectionRow
  adapter: ProviderAdapter
}

interface Work {
  index: number
  action: PlanAction
  type: ResourceTypeSpec
  row: HubResourceRow | null
  /** Plan-form fields (refs RefValue, secrets {fingerprint, changed}); null = delete / engine op. */
  fields: Record<string, unknown> | null
  externalId: string | null
  /** A delete an admin asked to take everything inside with it (`deleteAllObjects`). */
  deleteAll?: boolean
}

const refuse = (code: ResourceChangeCode, message: string, details?: Record<string, unknown>) =>
  new ResourceChangeError(code, message, details)

function scopeKind(req: PlanRequest): 'app' | 'shared' {
  if (req.scope !== 'app' && req.scope !== 'shared')
    throw refuse('INVALID_FIELDS', 'scope must be app or shared.')
  return req.scope
}

/** The region an adapter call is for: the resource's own, else the connection's first. */
export function regionFor(
  config: Record<string, unknown>,
  fields: Record<string, unknown> | null,
  observed: Observed | null
): string | null {
  const own = fields?.region ?? observed?.fields?.region
  if (typeof own === 'string' && own) return own
  if (typeof config.region === 'string' && config.region) return config.region
  const list = config.regions
  if (Array.isArray(list) && typeof list[0] === 'string') return list[0]
  return null
}

export interface OpenConnection {
  row: HubConnectionRow
  adapter: ProviderAdapter
  secrets: Record<string, string>
}

export async function openConnection(connectionId: number): Promise<OpenConnection> {
  const row = await readConnection(connectionId)
  if (!row) throw refuse('CONNECTION_NOT_FOUND', 'Connection not found.')
  ensureCoreProviders()
  const adapter = getProvider(row.provider)
  if (!adapter)
    throw refuse('UNKNOWN_TYPE', `The ${row.provider} provider is not available on this Hub.`)
  return { row, adapter, secrets: await openConnectionSecrets(row) }
}

export function contextFor(
  c: OpenConnection,
  region: string | null,
  o: { signal?: AbortSignal; scrubExtra?: string[] } = {}
): ProviderContext {
  const deps = engineDeps()
  return makeProviderContext({
    adapter: c.adapter,
    connectionId: c.row.id,
    config: c.row.config,
    secrets: c.secrets,
    region,
    ...(o.signal ? { signal: o.signal } : {}),
    ...(o.scrubExtra?.length ? { scrubExtra: o.scrubExtra } : {}),
    now: () => new Date(deps.now()),
    ...(deps.fetch ? { fetch: deps.fetch } : {})
  })
}

/** A provider failure as the engine's error: message scrubbed, retryable kept. */
export function providerFailure(ctx: ProviderContext, e: unknown): ResourceChangeError {
  if (e instanceof ResourceChangeError) return e
  const raw = e instanceof Error ? e.message : String(e)
  const code =
    e instanceof ProviderError && e.code in RESOURCE_CHANGE_CODES
      ? (e.code as ResourceChangeCode)
      : 'PROVIDER_ERROR'
  return refuse(code, ctx.scrub(raw).slice(0, 1000), {
    retryable: e instanceof ProviderError ? e.retryable : false,
    ...(e instanceof ProviderError ? { provider_code: e.code } : {}),
    ...(e instanceof ProviderError && e.status !== undefined ? { status: e.status } : {})
  })
}

// ── Request → work ──

function normalizeSecret(
  spec: FieldSpec,
  value: unknown,
  index: number,
  opts: PlanOptions,
  current: Record<string, unknown> | null,
  sealedOut: SealedSecrets,
  sealedIn: SealedSecrets,
  problems: Problem[]
): unknown {
  const stored = current?.[spec.key]
  const storedFp = isStoredSecret(stored) ? stored.fingerprint : null
  if (value == null || value === '') return null
  if (value === HUB_MASK) {
    if (!storedFp) {
      problems.push({ field: spec.key, message: 'has no stored value to keep' })
      return undefined
    }
    return { fingerprint: storedFp, changed: false }
  }
  if (opts.mode === 'stored' && isPlanSecret(value)) {
    const plain = sealedIn[sealedKey(index, spec.key)]
    if (plain !== undefined) sealedOut[sealedKey(index, spec.key)] = plain
    return { fingerprint: value.fingerprint, changed: value.fingerprint !== storedFp }
  }
  let plain: string | null = null
  if (typeof value === 'string') plain = value
  else if (opts.mode === 'internal' && isStoredSecret(value)) plain = openSecret(value.$sealed)
  if (plain == null) {
    problems.push({ field: spec.key, message: 'must be text' })
    return undefined
  }
  const fingerprint = secretFieldFingerprint(plain)
  sealedOut[sealedKey(index, spec.key)] = plain
  return { fingerprint, changed: fingerprint !== storedFp }
}

/** One request op's fields, checked and in plan form. `current` = the row's desired (row form). */
function normalizeFields(
  type: ResourceTypeSpec,
  input: Record<string, unknown>,
  index: number,
  opts: PlanOptions,
  current: Record<string, unknown> | null,
  sealedOut: SealedSecrets,
  sealedIn: SealedSecrets,
  problems: Problem[]
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(input)) {
    const spec = type.fields.find((f) => f.key === k)
    if (!spec) {
      problems.push({ field: k, message: 'is not a field of this type' })
      continue
    }
    if (spec.readOnly) continue
    if (spec.kind === 'secret') {
      const s = normalizeSecret(spec, v, index, opts, current, sealedOut, sealedIn, problems)
      if (s !== undefined) out[k] = s
      continue
    }
    checkValue(spec, v, k, problems)
    out[k] = v === undefined ? null : v
  }
  return out
}

function checkRequired(
  type: ResourceTypeSpec,
  fields: Record<string, unknown>,
  problems: Problem[]
) {
  for (const spec of type.fields)
    if (spec.required && !spec.readOnly && (fields[spec.key] == null || fields[spec.key] === ''))
      problems.push({ field: spec.key, message: 'is required' })
}

/** Defaults for a create (fields not sent). */
export function withDefaults(type: ResourceTypeSpec, fields: Record<string, unknown>) {
  const out = { ...fields }
  for (const spec of type.fields)
    if (!(spec.key in out) && spec.default !== undefined && spec.kind !== 'secret')
      out[spec.key] = spec.default
  return out
}

/** Dependency order: creates/updates parents first, then deletes children first. */
function orderWork(work: Work[]): Work[] {
  const byRow = new Map<number, Work>()
  for (const w of work) if (w.row) byRow.set(w.row.id, w)
  const after = new Map<number, Set<number>>()
  for (const w of work) after.set(w.index, new Set())
  for (const w of work) {
    if (w.action === 'delete') continue
    for (const r of refsIn(w.type, w.fields)) {
      if (r.resourceId < 0) after.get(w.index)?.add(-r.resourceId - 1)
      else {
        const parent = byRow.get(r.resourceId)
        if (parent && parent.action !== 'delete' && parent !== w)
          after.get(w.index)?.add(parent.index)
      }
    }
  }
  // Deletes: a delete of a resource runs before the delete of anything it points at.
  for (const w of work) {
    if (w.action !== 'delete' || !w.row) continue
    for (const r of w.row.refs) {
      const parent = byRow.get(r.resourceId)
      if (parent?.action === 'delete') after.get(parent.index)?.add(w.index)
    }
    for (const other of work) if (other.action !== 'delete') after.get(w.index)?.add(other.index)
  }
  const out: Work[] = []
  const state = new Map<number, 'visiting' | 'done'>()
  const byIndex = new Map(work.map((w) => [w.index, w]))
  const visit = (i: number) => {
    const s = state.get(i)
    if (s === 'done') return
    if (s === 'visiting')
      throw refuse(
        'INVALID_FIELDS',
        'These resources point at each other in a loop; plan them apart.'
      )
    state.set(i, 'visiting')
    for (const j of [...(after.get(i) ?? [])].sort((a, b) => a - b)) visit(j)
    state.set(i, 'done')
    const w = byIndex.get(i)
    if (w) out.push(w)
  }
  for (const w of [...work].sort((a, b) => a.index - b.index)) visit(w.index)
  return out
}

/** A planned op from the engine itself (adopt / accept / already gone), not the adapter. */
function engineOp(
  kind: OpKind,
  w: Work,
  reason: string,
  preconditions: Record<string, unknown>,
  action?: string
): PlannedOp {
  return {
    kind,
    type: w.type.key,
    resourceId: w.row?.id ?? null,
    externalId: w.externalId,
    reason,
    changes: [],
    preconditions,
    risk: [],
    ...(action ? { action } : {})
  }
}

function observedSnapshot(o: Observed): Record<string, unknown> {
  return { $exists: true, $version: o.version ?? null, fields: o.fields }
}

/** The value a precondition key reads from an observed resource. */
export function preconditionValue(o: Observed | null, key: string): unknown {
  if (key === '$exists') return !!o
  if (!o) return undefined
  if (key === '$version') return o.version ?? null
  if (key === '$status') return o.status ?? null
  if (key === '$name') return o.name ?? null
  if (key === '$tags') return o.tags ?? {}
  if (key === 'fields') return o.fields
  return o.fields[key]
}

/** The precondition keys whose observed value moved (empty = still as planned). */
export function movedPreconditions(o: Observed | null, pre: Record<string, unknown>): string[] {
  const moved: string[] = []
  for (const [k, want] of Object.entries(pre ?? {}))
    if (canonical(preconditionValue(o, k) ?? null) !== canonical(want ?? null)) moved.push(k)
  return moved
}

function defaultPreconditions(op: PlannedOp, observed: Observed | null): Record<string, unknown> {
  if (op.kind === 'create' || op.kind === 'noop' || !observed) return op.preconditions ?? {}
  if (op.preconditions && Object.keys(op.preconditions).length) return op.preconditions
  const pre: Record<string, unknown> = { $exists: true }
  if (observed.version) pre.$version = observed.version
  for (const c of op.changes ?? [])
    if (!c.secret && c.field in observed.fields) pre[c.field] = observed.fields[c.field]
  return pre
}

function cleanChanges(type: ResourceTypeSpec, changes: FieldChange[] | undefined): FieldChange[] {
  return (changes ?? []).map((c) => {
    const spec = type.fields.find((f) => f.key === c.field)
    return spec?.kind === 'secret' || c.secret ? { field: c.field, secret: true } : c
  })
}

function cleanPreconditions(type: ResourceTypeSpec, pre: Record<string, unknown>) {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(pre ?? {})) {
    const spec = type.fields.find((f) => f.key === k)
    if (spec?.kind === 'secret') continue
    out[k] = v
  }
  return out
}

const defaultReason = (kind: OpKind, label: string, name: string | null) => {
  const what = name ? `${label} ${name}` : label
  if (kind === 'create') return `Create ${what}.`
  if (kind === 'delete') return `Delete ${what}.`
  if (kind === 'replace') return `Replace ${what}.`
  if (kind === 'update') return `Update ${what}.`
  return `${what}: nothing to change.`
}

/** The name a typed confirm asks for: the type's name field, else the provider's name, else its id. */
export function nameOf(
  type: ResourceTypeSpec,
  fields: Record<string, unknown> | null,
  observed: Observed | null,
  row: HubResourceRow | null,
  externalId: string | null
): string | null {
  const own = fields?.[type.nameField ?? 'name']
  if (typeof own === 'string' && own) return own
  return observed?.name || row?.name || externalId || null
}

/** Plan-form fields → the DesiredResource an adapter sees (`plain` filled only for apply). */
export function desiredOf(
  w: { type: ResourceTypeSpec; row: HubResourceRow | null; externalId: string | null },
  fields: Record<string, unknown>,
  ctx: {
    scope: 'app' | 'shared'
    appId: number | null
    environmentId: number | null
    appKey: string | null
    envKey: string | null
    refExternal: (resourceId: number) => string | null
    plainOf?: (field: string) => string | null
  }
): DesiredResource {
  const out: Record<string, unknown> = {}
  const refs: Record<string, string | string[] | null> = {}
  for (const [k, v] of Object.entries(fields)) {
    const spec = w.type.fields.find((f) => f.key === k)
    if (spec?.kind === 'secret') {
      if (!isPlanSecret(v)) continue
      const sv: SecretValue = { fingerprint: v.fingerprint, changed: v.changed }
      const plain = ctx.plainOf?.(k)
      if (plain != null) sv.plain = plain
      out[k] = sv
      continue
    }
    out[k] = v
    if (spec && isRefField(spec)) {
      if (Array.isArray(v)) {
        const ids = v.map((x) => (isRecord(x) ? ctx.refExternal(Number(x.resourceId)) : null))
        refs[k] = ids.some((x) => x == null) ? null : (ids as string[])
      } else if (isRecord(v)) refs[k] = ctx.refExternal(Number(v.resourceId))
      else refs[k] = null
    }
  }
  const tags: Record<string, string> = {}
  if (w.type.capabilities.tag) {
    if (ctx.scope === 'app') {
      if (ctx.appKey) tags['nivaro-hub:app'] = ctx.appKey
      if (ctx.envKey) tags['nivaro-hub:env'] = ctx.envKey
    }
    if (w.row) tags['nivaro-hub:resource'] = String(w.row.id)
  }
  return {
    resourceId: w.row?.id ?? null,
    type: w.type.key,
    externalId: w.externalId,
    scope: ctx.scope,
    appId: ctx.scope === 'app' ? ctx.appId : null,
    environmentId: ctx.scope === 'app' ? ctx.environmentId : null,
    fields: out,
    refs,
    tags
  }
}

/** Update fields: the row's desired (plan form) with the request's fields laid over. */
export function mergeForUpdate(
  type: ResourceTypeSpec,
  row: HubResourceRow,
  overlay: Record<string, unknown>,
  rowOf: (refType: string, externalId: string) => number | null
): { fields: Record<string, unknown>; unresolved: string[] } {
  const base = row.desired
    ? { fields: planFormOf(type, row.desired), unresolved: [] as string[] }
    : desiredFromObservedFields(type, row.observed, rowOf)
  const fields = { ...base.fields }
  for (const [k, v] of Object.entries(overlay)) {
    if (v === null) delete fields[k]
    else fields[k] = v
  }
  return { fields, unresolved: base.unresolved.filter((k) => !(k in overlay)) }
}

/**
 * Computes a plan for `req` as `actor`: access first (no provider call before it passes), then
 * one observe per existing resource and the adapter's diff. Throws ResourceChangeError.
 */
export async function computePlan(
  req: PlanRequest,
  actor: HubActor,
  opts: PlanOptions
): Promise<ComputedPlan> {
  const scope = scopeKind(req)
  if (!Array.isArray(req.ops) || !req.ops.length)
    throw refuse('INVALID_FIELDS', 'A change needs at least one operation.')
  if (req.ops.length > 50) throw refuse('INVALID_FIELDS', 'Plan at most 50 operations at once.')
  const conn = await openConnection(Number(req.connectionId))
  const typeOf = (key: string | undefined): ResourceTypeSpec => {
    const hit = key ? findType(key) : null
    if (!hit || hit.provider.key !== conn.row.provider)
      throw refuse('UNKNOWN_TYPE', `Unknown resource type ${key ?? '(none)'} for this connection.`)
    return hit.type
  }

  // Rows the request names (ops + positive refs).
  const named = new Set<number>()
  for (const op of req.ops) if (op.resourceId != null) named.add(Number(op.resourceId))
  const reqTypes: Array<ResourceTypeSpec | null> = req.ops.map((op) =>
    op.type ? typeOf(op.type) : null
  )
  for (const [i, op] of req.ops.entries())
    if (reqTypes[i] && op.fields)
      for (const r of refsIn(reqTypes[i] as ResourceTypeSpec, op.fields))
        if (r.resourceId > 0) named.add(r.resourceId)
  const rowsList = named.size ? await listResources({ ids: [...named], includeDeleted: true }) : []
  const rowsById = new Map(rowsList.map((r) => [r.id, r]))

  // Per op: the row and the type (from the row when the request names none).
  const opRows: Array<HubResourceRow | null> = []
  const opTypes: ResourceTypeSpec[] = []
  const seenRows = new Set<number>()
  for (const [i, op] of req.ops.entries()) {
    const action = op.action
    if (!['create', 'update', 'delete', 'adopt', 'reapply', 'accept'].includes(action))
      throw refuse('INVALID_FIELDS', `Operation ${i + 1}: unknown action ${String(action)}.`)
    let row: HubResourceRow | null = null
    if (action === 'create' || action === 'adopt') {
      if (!op.type) throw refuse('INVALID_FIELDS', `Operation ${i + 1}: name the type.`)
    } else {
      row = op.resourceId != null ? (rowsById.get(Number(op.resourceId)) ?? null) : null
      if (!row || row.deleted_at) throw refuse('NOT_FOUND', `Operation ${i + 1}: no such resource.`)
      if (seenRows.has(row.id))
        throw refuse(
          'INVALID_FIELDS',
          `Resource ${row.id} is named twice; plan one change per resource.`
        )
      seenRows.add(row.id)
    }
    const type = row ? typeOf(row.type) : (reqTypes[i] as ResourceTypeSpec)
    if (row && op.type && op.type !== row.type)
      throw refuse('INVALID_FIELDS', `Operation ${i + 1}: the resource is a ${row.type}.`)
    opRows.push(row)
    opTypes.push(type)
  }

  // Access BEFORE any provider call.
  const access = await judgeAccess(
    {
      connection: conn.row,
      scope,
      appId: scope === 'app' ? (req.appId ?? null) : null,
      environmentId: scope === 'app' ? (req.environmentId ?? null) : null,
      types: opTypes,
      rows: opRows.filter((r): r is HubResourceRow => !!r)
    },
    actor
  )

  // Managed rows of this connection, for provider id → row lookups (refs, adopt).
  const peers = await listResources({ connectionId: conn.row.id })
  const byExternal = new Map(peers.map((p) => [`${p.type}\0${p.external_id}`, p.id]))
  for (const p of peers) rowsById.set(p.id, rowsById.get(p.id) ?? p)
  const rowOf = (refType: string, externalId: string) =>
    byExternal.get(`${refType}\0${externalId}`) ?? null

  const problems: Problem[] = []
  const sealedIn = openSealedSecrets(opts.sealed)
  const sealedOut: SealedSecrets = {}
  const storedOps: PlanRequestOp[] = []
  const work: Work[] = []
  const blockers: ChangeBlocker[] = []
  const deletedRows = new Set<number>()
  for (const [i, op] of req.ops.entries())
    if (op.action === 'delete' && opRows[i]) deletedRows.add((opRows[i] as HubResourceRow).id)

  for (const [i, op] of req.ops.entries()) {
    const type = opTypes[i]
    const row = opRows[i]
    const action = op.action
    const cap = type.capabilities
    const need =
      action === 'create'
        ? cap.create
        : action === 'update' || action === 'reapply'
          ? cap.update
          : action === 'delete'
            ? cap.delete
            : action === 'adopt'
              ? cap.adopt
              : true
    if (!need)
      throw refuse(
        'CAPABILITY_MISSING',
        `${type.label} cannot be ${action === 'reapply' ? 're-applied' : `${action}d`} through the Hub.`
      )
    const inFields = isRecord(op.fields) ? op.fields : {}
    const sub: Problem[] = []
    let fields: Record<string, unknown> | null = null
    const stored: PlanRequestOp = { action }
    if (op.type) stored.type = op.type
    if (row) stored.resourceId = row.id
    if (action === 'create') {
      const norm = normalizeFields(type, inFields, i, opts, null, sealedOut, sealedIn, sub)
      fields = withDefaults(type, norm)
      checkRequired(type, fields, sub)
      stored.fields = norm
    } else if (action === 'update') {
      const norm = normalizeFields(
        type,
        inFields,
        i,
        opts,
        row?.desired ?? null,
        sealedOut,
        sealedIn,
        sub
      )
      const merged = mergeForUpdate(type, row as HubResourceRow, norm, rowOf)
      fields = merged.fields
      for (const k of merged.unresolved)
        blockers.push({
          code: 'INVALID_FIELDS',
          message: `${k} points at a resource the Hub does not manage — adopt it first or set the field.`
        })
      for (const spec of type.fields)
        if (spec.createOnly && spec.key in norm) {
          const before = row?.desired
            ? planFormOf(type, row.desired)[spec.key]
            : row?.observed?.fields[spec.key]
          if (canonical(before ?? null) !== canonical(norm[spec.key] ?? null))
            sub.push({ field: spec.key, message: 'can only be set when the resource is created' })
        }
      checkRequired(type, fields, sub)
      stored.fields = norm
    } else if (action === 'reapply') {
      if (row?.desired) fields = planFormOf(type, row.desired)
    } else if (action === 'adopt') {
      if (typeof op.externalId !== 'string' || !op.externalId.trim())
        sub.push({ field: 'externalId', message: 'is required' })
      else stored.externalId = op.externalId.trim()
    }
    let deleteAll = false
    if (action === 'delete') {
      // A delete takes one option: deleteAllObjects (a non-empty S3 bucket) — admins only, and the
      // typed confirm becomes "delete all objects in <name>".
      for (const k of Object.keys(inFields))
        if (k !== 'deleteAllObjects')
          sub.push({ field: k, message: 'is not an option of a delete' })
      if (inFields.deleteAllObjects === true) {
        if (!actor.isAdmin)
          throw refuse(
            'ADMIN_ONLY',
            'Only a Hub administrator can delete a resource with everything inside it.'
          )
        deleteAll = true
        stored.fields = { deleteAllObjects: true }
      }
    }
    for (const p of sub) problems.push({ field: `${i + 1}.${p.field}`, message: p.message })
    // Refs: managed, same connection, the right type, this app (or shared), not being deleted.
    for (const r of refsIn(type, fields)) {
      const spec = type.fields.find((f) => f.key === r.field) as FieldSpec
      const want = refTypeOf(spec)
      if (r.resourceId < 0) {
        const j = -r.resourceId - 1
        const target = req.ops[j]
        if (target?.action !== 'create' || (want && target.type !== want) || j === i)
          problems.push({
            field: `${i + 1}.${r.field}`,
            message: 'must point at a create of the right type in this change'
          })
        continue
      }
      const target = rowsById.get(r.resourceId)
      if (
        !target ||
        target.deleted_at ||
        target.connection_id !== conn.row.id ||
        (want && target.type !== want)
      )
        problems.push({
          field: `${i + 1}.${r.field}`,
          message: 'must point at a managed resource of the right type on this connection'
        })
      else if (target.scope === 'app' && (scope !== 'app' || target.app_id !== access.app?.id))
        problems.push({
          field: `${i + 1}.${r.field}`,
          message: "must point at this app's resources or a shared one"
        })
      else if (deletedRows.has(target.id))
        problems.push({
          field: `${i + 1}.${r.field}`,
          message: 'points at a resource this change deletes'
        })
    }
    storedOps.push(stored)
    work.push({
      index: i,
      action,
      type,
      row,
      fields,
      externalId: row?.external_id ?? (action === 'adopt' ? (stored.externalId ?? null) : null),
      ...(deleteAll ? { deleteAll: true } : {})
    })
  }
  if (problems.length) throw invalid(problems)

  // SHARED_IN_USE: a delete of a resource others still point at (never overridable).
  for (const w of work) {
    if (w.action !== 'delete' || !w.row) continue
    const target = w.row
    for (const p of peers) {
      if (p.id === target.id || deletedRows.has(p.id)) continue
      const pType = findType(p.type)?.type
      const pointing = p.refs.filter((r) => r.resourceId === target.id)
      if (!pointing.length) continue
      const required = pointing.some((r) => {
        const spec = pType?.refs.find((x) => x.field === r.field)
        return spec?.required !== false
      })
      if (!required) continue
      // An update in this change that moves the ref elsewhere frees it.
      const moving = work.find((x) => x.row?.id === p.id && x.action === 'update')
      if (moving && pType && !refsIn(pType, moving.fields).some((r) => r.resourceId === target.id))
        continue
      blockers.push({
        code: 'SHARED_IN_USE',
        message: `${target.name ?? `Resource ${target.id}`} is still used by ${p.name ?? `resource ${p.id}`} (${p.type}); change or delete that first.`
      })
    }
  }

  const ordered = orderWork(work)
  const ops: PlannedOp[] = []
  const resourceIds: Array<number | null> = []
  const sources: number[] = []
  const names: Array<{ op: PlannedOp; name: string | null }> = []
  const refExternal = (id: number) => (id > 0 ? (rowsById.get(id)?.external_id ?? null) : null)

  for (const w of ordered) {
    const region = regionFor(conn.row.config, w.fields, w.row?.observed ?? null)
    const ctx = contextFor(conn, region)
    let observed: Observed | null = null
    if (w.externalId && w.action !== 'create') {
      try {
        observed = await conn.adapter.observe(ctx, w.type.key, w.externalId)
      } catch (e) {
        throw providerFailure(ctx, e)
      }
    }
    let planned: PlannedOp[]
    if (w.action === 'adopt') {
      if (!observed) throw refuse('NOT_FOUND', 'The provider does not have that resource.')
      if (rowOf(w.type.key, w.externalId as string) != null)
        throw refuse('RESOURCE_ALREADY_MANAGED', 'The Hub already manages this resource.')
      planned = [
        engineOp(
          'noop',
          w,
          `Adopt ${w.type.label} ${observed.name ?? w.externalId} into the Hub (no change at the provider).`,
          observedSnapshot(observed),
          'adopt'
        )
      ]
    } else if (w.action === 'accept') {
      if (!observed) {
        blockers.push({
          code: 'PRECONDITION_CHANGED',
          message: 'The provider no longer has this resource; there is nothing to accept.'
        })
        planned = [engineOp('noop', w, 'Nothing to accept: the resource is gone.', {}, 'accept')]
      } else {
        const back = desiredFromObservedFields(w.type, observed, rowOf)
        for (const k of back.unresolved)
          blockers.push({
            code: 'INVALID_FIELDS',
            message: `${k} points at a resource the Hub does not manage — adopt it first.`
          })
        planned = [
          engineOp(
            'noop',
            w,
            `Accept what the provider has now as the desired state of ${w.type.label} ${observed.name ?? w.externalId}.`,
            observedSnapshot(observed),
            'accept'
          )
        ]
      }
    } else if (w.action === 'delete' && !observed) {
      planned = [
        engineOp(
          'delete',
          w,
          `${w.type.label} ${w.row?.name ?? w.externalId ?? ''} is already gone at the provider; the Hub forgets it.`.replace(
            '  ',
            ' '
          ),
          {}
        )
      ]
    } else if (w.action === 'reapply' && !w.fields) {
      planned = [
        engineOp(
          'noop',
          w,
          'Nothing to re-apply: this resource has no desired state of its own yet.',
          {}
        )
      ]
    } else {
      const desired =
        w.action === 'delete'
          ? null
          : desiredOf(w, w.fields ?? {}, {
              scope,
              appId: access.app?.id ?? null,
              environmentId: access.env?.id ?? null,
              appKey: access.app?.key ?? null,
              envKey: access.env?.key ?? null,
              refExternal
            })
      // A create that would collide with something the provider already has: adopt it instead.
      if (w.action === 'create' && desired && conn.adapter.findExisting) {
        let hit: Observed | null = null
        try {
          hit = await conn.adapter.findExisting(ctx, w.type.key, desired)
        } catch (e) {
          throw providerFailure(ctx, e)
        }
        if (hit)
          blockers.push({
            code: 'ALREADY_EXISTS',
            message: `${w.type.label} ${hit.name ?? hit.externalId} already exists at the provider — adopt it instead of creating it.`
          })
      }
      try {
        planned = conn.adapter.plan(ctx, desired, observed)
      } catch (e) {
        throw providerFailure(ctx, e)
      }
      if (!Array.isArray(planned) || !planned.length)
        planned = [
          engineOp(
            'noop',
            w,
            defaultReason(
              'noop',
              w.type.label,
              nameOf(w.type, w.fields, observed, w.row, w.externalId)
            ),
            {}
          )
        ]
      for (const op of planned) {
        if (w.deleteAll && op.kind === 'delete') {
          const name = nameOf(w.type, null, observed, w.row, w.externalId) ?? w.externalId ?? ''
          op.data = {
            ...(op.data ?? {}),
            deleteAllObjects: true,
            $confirm: `delete all objects in ${name}`
          }
          op.risk = [...(op.risk ?? []), 'data_loss']
        }
        const desiredForRisk = desired
        const extra: RiskFlag[] = []
        if (
          (op.kind === 'create' || op.kind === 'replace') &&
          desiredForRisk &&
          w.type.costClass?.(desiredForRisk) === 'monthly'
        )
          extra.push('cost')
        op.risk = [
          ...new Set([...(op.risk ?? []), ...w.type.risk(op, desiredForRisk), ...extra])
        ].sort() as RiskFlag[]
      }
    }
    for (const raw of planned) {
      const kind = raw.kind
      const cap = w.type.capabilities
      if (
        (kind === 'create' && !cap.create) ||
        (kind === 'update' && !cap.update) ||
        (kind === 'delete' && !cap.delete) ||
        (kind === 'replace' && !(cap.create && cap.delete))
      )
        throw refuse(
          'CAPABILITY_MISSING',
          `${w.type.label} cannot be ${kind === 'replace' ? 'replaced' : `${kind}d`} through the Hub.`
        )
      const op: PlannedOp = {
        kind,
        type: w.type.key,
        resourceId: w.row?.id ?? null,
        externalId: raw.externalId ?? w.externalId ?? observed?.externalId ?? null,
        reason:
          raw.reason ||
          defaultReason(
            kind,
            w.type.label,
            nameOf(w.type, w.fields, observed, w.row, w.externalId)
          ),
        changes: cleanChanges(w.type, raw.changes),
        preconditions: cleanPreconditions(w.type, defaultPreconditions(raw, observed)),
        risk: [...(raw.risk ?? [])],
        ...(raw.action ? { action: raw.action } : {}),
        ...(raw.data ? { data: raw.data } : {})
      }
      ops.push(op)
      resourceIds.push(w.row?.id ?? null)
      sources.push(w.index)
      names.push({ op, name: nameOf(w.type, w.fields, observed, w.row, w.externalId) })
    }
  }

  // Adapter blockers + risk gates.
  const gates: ChangeGate[] = []
  const production = access.production === true
  let adminNeeded = false
  for (const op of ops) {
    const b = isRecord(op.data) ? op.data.$blocker : null
    if (isRecord(b) && typeof b.code === 'string')
      blockers.push({ code: b.code, message: typeof b.message === 'string' ? b.message : b.code })
    if (op.risk.includes('public_exposure') || (isRecord(op.data) && op.data.$adminOnly === true))
      adminNeeded = true
  }
  if (adminNeeded) {
    gates.push({
      code: 'ADMIN_ONLY',
      passed: actor.isAdmin,
      message:
        'Opens something to the internet (or the provider asks for an administrator): a Hub administrator must start it.'
    })
    if (!actor.isAdmin)
      blockers.push({
        code: 'ADMIN_ONLY',
        message: 'A Hub administrator must start this change (it opens something to the internet).'
      })
  }
  const confirmOps = names.filter(
    ({ op }) =>
      op.risk.includes('destructive') ||
      op.risk.includes('data_loss') ||
      (production && op.risk.includes('downtime')) ||
      (isRecord(op.data) && typeof op.data.$confirm === 'string')
  )
  const explicit = confirmOps.filter(
    ({ op }) => isRecord(op.data) && typeof op.data.$confirm === 'string'
  )
  let needsConfirm: string | null = null
  if (explicit.length > 1)
    blockers.push({
      code: 'INVALID_FIELDS',
      message: 'Two operations each ask for their own typed confirmation: plan them one at a time.'
    })
  if (explicit.length)
    needsConfirm = String((explicit[0].op.data as Record<string, unknown>).$confirm)
  else if (confirmOps.length === 1)
    needsConfirm = confirmOps[0].name ?? confirmOps[0].op.externalId ?? conn.row.name
  else if (confirmOps.length > 1)
    needsConfirm = scope === 'app' ? (access.app?.key ?? conn.row.name) : conn.row.name
  if (ops.some((o) => o.risk.includes('downtime')))
    gates.push({
      code: 'DOWNTIME',
      passed: true,
      message: production
        ? 'This change can stop the service for a while; production asks for the typed confirmation.'
        : 'This change can stop the service for a while.'
    })
  if (needsConfirm)
    gates.push({
      code: 'CONFIRM_MISMATCH',
      passed: false,
      message: `Type ${needsConfirm} to start.`
    })
  const needsApproval = !actor.isAdmin && ops.some((o) => o.risk.includes('cost'))
  if (ops.some((o) => o.risk.includes('cost')))
    gates.push({
      code: 'APPROVAL_REQUIRED',
      passed: !needsApproval,
      message: needsApproval
        ? 'This change adds a monthly cost: a Hub administrator approves it before it runs.'
        : 'This change adds a monthly cost.'
    })
  if (access.env)
    gates.push({
      code: 'PRODUCTION_ADMIN_ONLY',
      passed: true,
      message: production ? 'Production environment.' : 'Not a production environment.'
    })
  const change = await judgeChangeGates({
    scope,
    appId: access.app?.id ?? null,
    environmentId: access.env?.id ?? null,
    production
  })
  gates.unshift(...change.gates)

  const storedRequest: PlanRequest = {
    connectionId: conn.row.id,
    scope,
    ...(scope === 'app' && access.app ? { appId: access.app.id } : {}),
    ...(scope === 'app' && access.env ? { environmentId: access.env.id } : {}),
    ops: storedOps
  }
  const stored: StoredChangePlan & { sealed?: string | null } = {
    request: storedRequest,
    ops,
    gates,
    needsConfirm,
    needsApproval,
    blockers,
    preconditionFingerprint: preconditionFingerprint(ops),
    resourceIds,
    sources,
    undoOf: opts.undoOf ?? null,
    sealed: Object.keys(sealedOut).length ? sealSecret(JSON.stringify(sealedOut)) : null
  }
  // Same plaintext, same envelope: a re-plan from a stored plan keeps its sealed blob.
  if (opts.mode === 'stored' && opts.sealed && canonical(sealedOut) === canonical(sealedIn))
    stored.sealed = opts.sealed
  return {
    stored,
    planHash: planHashOf(stored),
    gateRefusal: change.refusal,
    access,
    connection: conn.row,
    adapter: conn.adapter
  }
}
