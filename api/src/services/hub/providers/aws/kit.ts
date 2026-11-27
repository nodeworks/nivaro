import { fieldWords } from '../plan-words.js'
import {
  type ConnectionTest,
  type DesiredResource,
  type FieldChange,
  type FieldSpec,
  type HealthAnswer,
  type ListPage,
  type Observed,
  type OpResult,
  type PlannedOp,
  type ProviderAdapter,
  type ProviderContext,
  ProviderError,
  type ResourceTypeSpec,
  type RiskFlag,
  type SnapshotRef
} from '../types.js'
import { regionsOf, resolveRegion } from './client.js'

/**
 * What every `aws.*` resource type implements (`AwsTypeDef`) and the one adapter that dispatches
 * to them. The planner (pure diff of desired vs observed), the read-before-write apply and the
 * region handling live here so a type only says how to read, create, change and remove itself.
 *
 * Region: every AWS resource has a required `region` field (create-only, replace on change). The
 * engine hands calls a `ctx.region`; an op carries its own region in `op.data.region`.
 */

export interface AwsMade {
  id: string
  outputs?: Record<string, string>
}

export interface AwsListPage {
  items: Observed[]
  next: string | null
}

export interface AwsProbe {
  type: string
  /** The IAM action the type's reads need, e.g. 'ec2:DescribeVpcs'. */
  need: string
  run(ctx: ProviderContext, region: string): Promise<unknown>
  /** An EC2 DryRun call: `DryRunOperation` means allowed. */
  dryRun?: boolean
}

export interface AwsTypeDef {
  spec: ResourceTypeSpec
  /** Not regional (Route 53): listed once whatever the allowed regions. */
  global?: boolean
  probe?: Pick<AwsProbe, 'need' | 'run' | 'dryRun'>
  observe(ctx: ProviderContext, id: string, region: string): Promise<Observed | null>
  list(ctx: ProviderContext, region: string, token: string | null): Promise<AwsListPage>
  /**
   * Creates the resource; answers its provider id, or `{id, outputs}` when the provider handed
   * out values (Task 13: they travel as `OpResult.outputs` only). Parents already exist
   * (`desired.refs`).
   */
  create(
    ctx: ProviderContext,
    desired: DesiredResource,
    region: string,
    op: PlannedOp
  ): Promise<string | AwsMade>
  /** Reconciles the changed fields against the freshly read `observed`; may answer outputs. */
  update?(
    ctx: ProviderContext,
    id: string,
    region: string,
    desired: DesiredResource,
    observed: Observed,
    changed: Set<string>,
    op: PlannedOp
  ): Promise<void | { outputs?: Record<string, string> }>
  /** Outputs the provider shows again (never a `onceOnly` one). */
  readOutputs?(ctx: ProviderContext, id: string, region: string): Promise<Record<string, string>>
  /** Type-specific health (scan findings, sandbox mode); else the status-based default. */
  health?(
    ctx: ProviderContext,
    id: string,
    region: string,
    observed: Observed
  ): Promise<Omit<HealthAnswer, 'checkedAt'>>
  remove(ctx: ProviderContext, id: string, region: string, op: PlannedOp): Promise<void>
  /** A resource a half-finished create already made (tag / name lookup), or null. */
  findExisting?(
    ctx: ProviderContext,
    desired: DesiredResource,
    region: string
  ): Promise<Observed | null>
  snapshot?(ctx: ProviderContext, id: string, region: string): Promise<SnapshotRef>
  /** Throws a ProviderError when the change is one the type refuses (a volume shrink). */
  checkPlan?(desired: DesiredResource, observed: Observed | null): void
  /** The desired fields as they are compared with `observed` (drop what the provider does not echo). */
  normalize?(fields: Record<string, unknown>): Record<string, unknown>
  /** Plan-time data stored on the op and handed back to apply (client tokens, snapshot names). */
  opData?(
    ctx: ProviderContext,
    desired: DesiredResource | null,
    observed: Observed | null,
    kind: PlannedOp['kind']
  ): Record<string, unknown>
}

// ── Values ──

const isRefField = (f: FieldSpec) =>
  f.kind === 'ref' || (f.kind === 'list' && f.items?.kind === 'ref')

function canon(v: unknown): string {
  const norm = (x: unknown): unknown => {
    if (Array.isArray(x))
      return x.map(norm).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
    if (x && typeof x === 'object')
      return Object.fromEntries(
        Object.entries(x as Record<string, unknown>)
          .filter(([, val]) => val !== undefined && val !== null && val !== '')
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, val]) => [k, norm(val)])
      )
    return x
  }
  return JSON.stringify(norm(v) ?? null)
}

const isEmpty = (v: unknown) =>
  v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)

export const sameValue = (a: unknown, b: unknown) => canon(a) === canon(b)

/** What the Hub wants for one field (`undefined` = not managed). */
function wanted(desired: DesiredResource, f: FieldSpec): unknown {
  if (isRefField(f)) return desired.refs[f.key] === undefined ? undefined : desired.refs[f.key]
  const v = desired.fields[f.key]
  return v === undefined ? f.default : v
}

function display(
  desired: DesiredResource | null,
  observed: Observed | null,
  def: AwsTypeDef
): string {
  const nameField = def.spec.nameField ?? 'name'
  const v = desired?.fields[nameField] ?? observed?.name ?? observed?.fields[nameField]
  return typeof v === 'string' && v ? v : (observed?.externalId ?? desired?.externalId ?? 'new')
}

function regionOf(desired: DesiredResource | null, observed: Observed | null): string | undefined {
  const r = desired?.fields.region ?? observed?.fields.region
  return typeof r === 'string' && r ? r : undefined
}

// ── Plan ──

export function planFor(
  ctx: ProviderContext,
  def: AwsTypeDef,
  desired: DesiredResource | null,
  observed: Observed | null
): PlannedOp[] {
  const spec = def.spec
  const label = spec.label
  if (!desired && !observed) return []
  const name = display(desired, observed, def)
  const base = {
    type: spec.key,
    resourceId: desired?.resourceId ?? null,
    externalId: observed?.externalId ?? desired?.externalId ?? null
  }
  const finish = (op: Omit<PlannedOp, 'risk' | 'data'>, kind: PlannedOp['kind']): PlannedOp => {
    const region = regionOf(desired, observed)
    const full: PlannedOp = {
      ...op,
      risk: [],
      data: { ...(region ? { region } : {}), ...(def.opData?.(ctx, desired, observed, kind) ?? {}) }
    }
    full.risk = spec.risk(full, desired)
    return full
  }

  if (!desired && observed) {
    return [
      finish(
        {
          ...base,
          kind: 'delete',
          reason: `Delete ${label} ${name}`,
          changes: [],
          preconditions: pre(observed, [])
        },
        'delete'
      )
    ]
  }
  if (!desired) return []
  def.checkPlan?.(desired, observed)
  const dn = def.normalize ? { ...desired, fields: def.normalize(desired.fields) } : desired

  const settable = spec.fields.filter((f) => !f.readOnly)
  if (!observed) {
    const changes: FieldChange[] = []
    for (const f of settable) {
      const v = wanted(desired, f)
      if (f.trigger && v !== true) continue
      if (v === undefined || v === null || (Array.isArray(v) && !v.length)) continue
      changes.push(f.kind === 'secret' ? { field: f.key, secret: true } : { field: f.key, to: v })
    }
    return [
      finish(
        { ...base, kind: 'create', reason: `Create ${label} ${name}`, changes, preconditions: {} },
        'create'
      )
    ]
  }

  const changes: FieldChange[] = []
  let replace = false
  for (const f of settable) {
    if (f.kind === 'secret') {
      const s = desired.fields[f.key] as { changed?: boolean } | undefined
      if (s?.changed) changes.push({ field: f.key, secret: true })
      continue
    }
    const want = wanted(dn, f)
    if (want === undefined) continue
    if (f.trigger && want !== true) continue // a one-shot trigger that is off changes nothing
    const have = observed.fields[f.key]
    if (have === undefined && f.createOnly) continue // write-only: the provider does not echo it
    // An unresolved ref (parent not created yet) counts as a change unless nothing is set.
    if (want === null) {
      if (isEmpty(have)) continue
    } else if (sameValue(want, have) || (isEmpty(want) && isEmpty(have))) continue
    changes.push({ field: f.key, from: have, to: want })
    if (f.replaceOnChange || f.createOnly) replace = true
  }
  if (!changes.length)
    return [
      finish(
        {
          ...base,
          kind: 'noop',
          reason: `${spec.label} ${name} is up to date`,
          changes: [],
          preconditions: {}
        },
        'noop'
      )
    ]
  const kind: PlannedOp['kind'] = replace ? 'replace' : 'update'
  const fields = fieldWords(spec.fields, changes)
  return [
    finish(
      {
        ...base,
        kind,
        reason: replace
          ? `Replace ${label} ${name}: ${fields} cannot change in place`
          : `Change ${fields} on ${label} ${name}`,
        changes,
        preconditions: pre(observed, changes)
      },
      kind
    )
  ]
}

function pre(observed: Observed, changes: FieldChange[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (observed.status) out.status = observed.status
  if (observed.version) out.version = observed.version
  for (const c of changes) if (c.from !== undefined && !c.secret) out[c.field] = c.from
  return out
}

// ── Apply ──

const DUPLICATE =
  /^(InvalidGroup\.Duplicate|InvalidVpc\.Duplicate|.*AlreadyExists.*|.*ExistsException|BucketAlreadyOwnedByYou|Duplicate\w+)$/

const changedKeys = (op: PlannedOp) => new Set(op.changes.map((c) => c.field))

/** Plain values of a desired resource's secret fields, to scrub from provider text. */
export function plainSecrets(desired: DesiredResource | null): string[] {
  const out: string[] = []
  for (const v of Object.values(desired?.fields ?? {})) {
    const p = (v as { plain?: unknown } | null)?.plain
    if (typeof p === 'string' && p.length >= 4) out.push(p)
  }
  return out
}

async function applyOp(
  ctx: ProviderContext,
  def: AwsTypeDef,
  op: PlannedOp,
  desired: DesiredResource | null
): Promise<OpResult> {
  const region = resolveRegion(ctx, op.data?.region ?? desired?.fields.region)
  const id = op.externalId ?? desired?.externalId ?? null
  const done = async (
    externalId: string | null,
    answer?: Record<string, unknown>,
    outputs?: Record<string, string>
  ): Promise<OpResult> => {
    const observed = externalId ? await def.observe(ctx, externalId, region) : null
    return {
      ok: true,
      externalId,
      observed,
      answer: { region, ...answer },
      ...(outputs && Object.keys(outputs).length ? { outputs } : {})
    }
  }

  if (op.kind === 'noop') return done(id)

  if (op.kind === 'delete') {
    const have = id ? await def.observe(ctx, id, region) : null
    if (have && id) await def.remove(ctx, id, region, op)
    const result = {
      ok: true,
      externalId: id,
      observed: null,
      answer: { region, alreadyGone: !have }
    }
    return result
  }

  if (op.kind === 'update') {
    if (!id || !desired)
      throw new ProviderError('OP_INVALID', 'An update needs the resource and its desired state.')
    if (desired.externalId && op.externalId && desired.externalId !== op.externalId)
      throw new ProviderError(
        'TARGET_MISMATCH',
        'The change targets a different resource than the one planned.'
      )
    const have = await def.observe(ctx, id, region)
    if (!have) throw new ProviderError('NOT_FOUND', `${def.spec.label} ${id} no longer exists.`)
    // Read-before-write: only what still differs.
    const todo = planFor(ctx, def, desired, have).find((o) => o.kind === 'update')
    const made =
      todo && def.update
        ? await def.update(ctx, id, region, desired, have, changedKeys(todo), op)
        : undefined
    return done(id, { changed: todo ? [...changedKeys(todo)] : [] }, made?.outputs)
  }

  // create / replace
  if (!desired) throw new ProviderError('OP_INVALID', 'A create needs the desired state.')
  if (op.kind === 'replace' && id) {
    const have = await def.observe(ctx, id, region)
    if (have) await def.remove(ctx, id, region, op)
  }
  let existing: Observed | null = null
  if (op.kind === 'create') {
    // A resumed run (externalId recorded) or the Hub's own earlier create (resource tag) is
    // reused; a resource the Hub did not create is never modified or bound: adopt it instead.
    if (desired.externalId) existing = await def.observe(ctx, desired.externalId, region)
    else {
      const found = (await def.findExisting?.(ctx, desired, region)) ?? null
      const mark = desired.tags['nivaro-hub:resource']
      if (found && !(mark && found.tags['nivaro-hub:resource'] === mark))
        throw new ProviderError(
          'ALREADY_EXISTS',
          `${def.spec.label} ${found.name ?? found.externalId} already exists and was not created by the Hub. Adopt it instead of creating it.`
        )
      existing = found
    }
  }
  if (existing) {
    const todo = planFor(ctx, def, desired, existing).find((o) => o.kind === 'update')
    if (todo && def.update)
      await def.update(ctx, existing.externalId, region, desired, existing, changedKeys(todo), op)
    return done(existing.externalId, { reused: true })
  }
  let newId: string
  let outputs: Record<string, string> | undefined
  try {
    const made = await def.create(ctx, desired, region, op)
    newId = typeof made === 'string' ? made : made.id
    outputs = typeof made === 'string' ? undefined : made.outputs
  } catch (err) {
    if (err instanceof ProviderError && DUPLICATE.test(err.code))
      throw new ProviderError(
        'ALREADY_EXISTS',
        `${def.spec.label} ${display(desired, null, def)} already exists. Adopt it instead of creating it.`
      )
    throw err
  }
  return done(newId, undefined, outputs)
}

// ── The adapter ──

const PERMISSION_CODES = new Set([
  'AccessDenied',
  'AccessDeniedException',
  'UnauthorizedOperation',
  'UnauthorizedAccess',
  'AuthFailure',
  'UnrecognizedClientException',
  'InvalidClientTokenId',
  'SignatureDoesNotMatch',
  'Forbidden',
  'AUTH_FAILED'
])

export interface AwsAdapterParts {
  key: string
  label: string
  connection: ProviderAdapter['connection']
  defs: AwsTypeDef[]
  identity(ctx: ProviderContext): Promise<string | null>
  /** The adapter's bundled, dated price table (the price book's fallback). */
  bundledPrices?: ProviderAdapter['bundledPrices']
  /**
   * Optional permissions beyond the types' own (price estimates, measured data out): each gets a
   * row in the connection test, but a missing one never fails the connection.
   */
  optionalProbes?: Array<{
    type: string
    need: string
    why: string
    run(ctx: ProviderContext, region: string): Promise<unknown>
  }>
}

export function makeAwsAdapter(parts: AwsAdapterParts): ProviderAdapter {
  const byType = new Map(parts.defs.map((d) => [d.spec.key, d]))
  const defOf = (type: string): AwsTypeDef => {
    const d = byType.get(type)
    if (!d) throw new ProviderError('TYPE_UNKNOWN', `AWS has no resource type ${type}.`)
    return d
  }
  /** Provider messages never carry a secret (connection secrets are scrubbed by the client). */
  const guard = async <T>(
    ctx: ProviderContext,
    desired: DesiredResource | null,
    fn: () => Promise<T>
  ) => {
    try {
      return await fn()
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err
      let msg = ctx.scrub(err.message)
      for (const s of plainSecrets(desired)) msg = msg.split(s).join('••••••••')
      throw new ProviderError(err.code, msg, { retryable: err.retryable, status: err.status })
    }
  }

  return {
    key: parts.key,
    label: parts.label,
    connection: parts.connection,
    types: parts.defs.map((d) => d.spec),
    ...(parts.bundledPrices ? { bundledPrices: parts.bundledPrices } : {}),

    async testConnection(ctx): Promise<ConnectionTest> {
      let identity: string | null = null
      try {
        identity = await parts.identity(ctx)
      } catch (err) {
        const msg = ctx.scrub(err instanceof Error ? err.message : 'AWS refused the credentials.')
        return {
          ok: false,
          identity: null,
          permissions: [{ type: '*', need: 'sts:GetCallerIdentity', has: false }],
          missing: ['sts:GetCallerIdentity'],
          message: msg
        }
      }
      const region = regionsOf(ctx.config)[0]
      const permissions: ConnectionTest['permissions'] = [
        { type: '*', need: 'sts:GetCallerIdentity', has: true }
      ]
      for (const d of parts.defs) {
        if (!d.probe) continue
        let has = true
        try {
          await d.probe.run(ctx, region)
        } catch (err) {
          const code = err instanceof ProviderError ? err.code : ''
          if (d.probe.dryRun && code === 'DryRunOperation') has = true
          else if (PERMISSION_CODES.has(code)) has = false
          else if (err instanceof ProviderError && err.retryable) throw err
          else has = false
        }
        permissions.push({ type: d.spec.key, need: d.probe.need, has })
      }
      const required = permissions.filter((p) => !p.has).map((p) => p.need)
      // Optional permissions (price estimates, measured data out) get a row but never fail the test.
      const optional: Array<{ need: string; why: string }> = []
      for (const o of parts.optionalProbes ?? []) {
        let has = true
        try {
          await o.run(ctx, region)
        } catch (err) {
          const code = err instanceof ProviderError ? err.code : ''
          if (!(code === 'DryRunOperation')) has = false
        }
        permissions.push({ type: o.type, need: o.need, has })
        if (!has) optional.push({ need: o.need, why: o.why })
      }
      const missing = permissions.filter((p) => !p.has).map((p) => p.need)
      return {
        ok: required.length === 0,
        identity,
        permissions,
        missing,
        message: required.length
          ? `Missing permissions: ${required.join(', ')}`
          : optional.length
            ? `Optional, not granted: ${optional.map((o) => `${o.need} (${o.why})`).join('; ')}.`
            : undefined
      }
    },

    observe: (ctx, type, externalId) =>
      guard(ctx, null, () => defOf(type).observe(ctx, externalId, resolveRegion(ctx, ctx.region))),

    async list(ctx, type, cursor): Promise<ListPage> {
      const def = defOf(type)
      const all = ctx.region ? [resolveRegion(ctx, ctx.region)] : regionsOf(ctx.config)
      // Global services (Route 53) answer once, not once per region.
      const regions = def.global ? all.slice(0, 1) : all
      const [idxRaw, ...rest] = (cursor ?? '0|').split('|')
      const idx = Math.max(0, Number.parseInt(idxRaw, 10) || 0)
      const token = rest.join('|') || null
      if (idx >= regions.length) return { items: [], cursor: null }
      const page = await guard(ctx, null, () => def.list(ctx, regions[idx], token))
      const next = page.next
        ? `${idx}|${page.next}`
        : idx + 1 < regions.length
          ? `${idx + 1}|`
          : null
      return { items: page.items, cursor: next }
    },

    plan: (ctx, desired, observed) => {
      const type = desired?.type ?? observed?.type
      if (!type) return []
      return planFor(ctx, defOf(type), desired, observed)
    },

    apply: (ctx, op, desired) =>
      guard(ctx, desired, () => applyOp(ctx, defOf(op.type), op, desired)),

    /**
     * Plan time: what a create would collide with (an S3 bucket of that name, a security group of
     * that name in the VPC …). What the Hub's own earlier, interrupted create made (its resource
     * tag) is not a collision: apply picks that one up again.
     */
    async findExisting(ctx, type, desired) {
      const def = defOf(type)
      const look = def.findExisting
      if (!look || desired.externalId) return null
      const found = await guard(ctx, desired, () =>
        look(ctx, desired, resolveRegion(ctx, desired.fields.region))
      )
      const mark = desired.tags['nivaro-hub:resource']
      if (found && mark && found.tags['nivaro-hub:resource'] === mark) return null
      return found ?? null
    },

    async snapshot(ctx, type, externalId) {
      const def = defOf(type)
      if (!def.snapshot)
        throw new ProviderError('NO_SNAPSHOT', `${def.spec.label} has no snapshot.`)
      return guard(
        ctx,
        null,
        () =>
          def.snapshot?.(ctx, externalId, resolveRegion(ctx, ctx.region)) as Promise<SnapshotRef>
      )
    },

    async readOutputs(ctx, type, externalId) {
      const def = defOf(type)
      if (!def.readOutputs) return {}
      return guard(ctx, null, () =>
        (def.readOutputs as NonNullable<AwsTypeDef['readOutputs']>)(
          ctx,
          externalId,
          resolveRegion(ctx, ctx.region)
        )
      )
    },

    async health(ctx, type, externalId): Promise<HealthAnswer> {
      const def = defOf(type)
      const region = resolveRegion(ctx, ctx.region)
      const o = await def.observe(ctx, externalId, region)
      const checkedAt = ctx.now().toISOString()
      if (!o) return { status: 'down', message: 'The resource is gone.', checkedAt }
      if (def.health) {
        const h = await guard(ctx, null, () =>
          (def.health as NonNullable<typeof def.health>)(ctx, externalId, region, o)
        )
        return { ...h, checkedAt }
      }
      const s = (o.status ?? '').toLowerCase()
      const good = ['available', 'running', 'active', 'issued', 'in-use', 'associated', 'ok']
      return {
        status: !s ? 'unknown' : good.includes(s) ? 'ok' : 'warn',
        message: o.status ?? undefined,
        checkedAt
      }
    }
  }
}

// ── Shared helpers for the types ──

export function observed(
  type: string,
  externalId: string,
  region: string,
  name: string | null,
  fields: Record<string, unknown>,
  tags: Record<string, string>,
  status?: string | null
): Observed {
  return {
    type,
    externalId,
    name: name || (tags.Name ?? null),
    fields: { region, name: name || (tags.Name ?? undefined), ...fields },
    tags,
    status: status ?? null
  }
}

export const cap = (over: Partial<ResourceTypeSpec['capabilities']> = {}) => ({
  create: true,
  update: true,
  delete: true,
  adopt: true,
  snapshot: false,
  tag: true,
  ...over
})

/** The `region` and `name` fields every AWS type starts with. */
export const regionField: FieldSpec = {
  key: 'region',
  label: 'Region',
  kind: 'string',
  required: true,
  createOnly: true,
  replaceOnChange: true,
  help: 'One of the connection’s allowed regions.',
  pattern: '^[a-z]{2}(-[a-z]+)+-\\d$',
  optionsFrom: 'regions'
}
export const nameField: FieldSpec = { key: 'name', label: 'Name', kind: 'string', required: true }

/** Plain risk: delete / replace are destructive; `extra` adds more by op. */
export function riskOf(
  extra?: (op: PlannedOp, desired: DesiredResource | null) => RiskFlag[]
): ResourceTypeSpec['risk'] {
  return (op, desired) => {
    const out = new Set<RiskFlag>()
    if (op.kind === 'delete' || op.kind === 'replace') out.add('destructive')
    for (const f of extra?.(op, desired) ?? []) out.add(f)
    return [...out]
  }
}

/** `{ items: [...] }`-style paging for EC2 `nextToken`. */
export const ec2Page = (nextToken: unknown): string | null =>
  typeof nextToken === 'string' && nextToken ? nextToken : null
