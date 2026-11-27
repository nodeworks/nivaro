import type { Knex } from 'knex'
import { db } from '../../../db/index.js'
import { emitOps } from '../../ops-live.js'
import { SAMPLES } from '../capacity/store.js'
import type { StackRole, StackRoleName } from '../docker/agent-types.js'
import { readStackSettings } from '../docker/stack-settings.js'
import { STACK_SIZES, STACK_TEMPLATES, type StackSize } from '../docker/templates.js'
import { hubModeEnabled } from '../mode.js'
import { deliverHubNotice, hubEventRecipients } from '../notify-events.js'
import {
  chargebackReport,
  databaseBytes,
  estimateStack,
  readChargeback,
  type StackShape
} from '../placement/chargeback.js'
import { REGION_DRIVERS, REGIONS } from '../placement/regions.js'
import { applyScaleShape, isRoleName, type RoleFigures, type ScaleShape } from '../scale/shape.js'
import { readScaleShape } from '../scale/store.js'
import type { HubActor } from './engine/contract.js'
import { ResourceChangeError } from './engine/contract.js'
import { judgeAccess } from './engine/gates.js'
import {
  contextFor,
  desiredOf,
  openConnection,
  planFormOf,
  regionFor,
  withDefaults
} from './engine/plan.js'
import {
  COST_BUDGETS,
  costsLiveDeps,
  estimateResource,
  isCostedType,
  listBudgets,
  type OverBudgetNotice,
  opCostOf,
  trafficFor
} from './estimate.js'
import { effectiveRates, PROVIDER_COSTS } from './pricing/index.js'
import { findType } from './registry.js'
import { listResources, readResource } from './store.js'
import type {
  CostEstimate,
  DesiredResource,
  EstimateTraffic,
  FieldSpec,
  ResourceTypeSpec
} from './types.js'

/**
 * Live costs (Task 44a, spec "Live costs and estimates"): the estimate reads the routes answer
 * (a provider resource, a Docker stack, a whole Create app), the run-rate tick that follows each
 * capacity sample run, month to date / forecast / billed, and the over-budget alerts.
 *
 *  - Estimates WRITE NOTHING but the price cache: no plan, no audit row, no run-rate row.
 *  - The run-rate (every 15 minutes, Hub only, where crons tick): one row per live managed
 *    resource (its estimate of what it costs now — re-estimated when the provider was read since
 *    the last sample, else the last figure kept) and one per environment whose stack the
 *    chargeback rates price (its rate-card figure from MEASURED usage). Rows are figures only,
 *    kept RUNRATE_KEEP_DAYS. The tick then pokes `hub:costs` with app ids only and checks budgets.
 *  - Month to date = Σ (row's monthly figure × one sample interval / the month's length) over
 *    the month's rows: a missed tick counts nothing (a gap, never a guess). Forecast = month to
 *    date + the newest run-rate for what is left of the month.
 *  - Budgets: forecast ≥ 80 % / ≥ 100 % of an app's monthly budget alerts once per threshold
 *    per month (last_alert_month + last_alert_pct), the higher threshold only when both crossed.
 */

export const RUNRATE = 'nivaro_hub_cost_runrate'
export const RUNRATE_KEEP_DAYS = 400
/** One sample interval: the capacity tick (every 15 minutes). */
export const SAMPLE_MS = 15 * 60_000

const ENVS = 'nivaro_hub_environments'
const APPS = 'nivaro_hub_apps'
const PLACEMENTS = 'nivaro_hub_placements'
const SHARED = 'nivaro_hub_shared_deployments'

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

const refuse = (code: ConstructorParameters<typeof ResourceChangeError>[0], message: string) =>
  new ResourceChangeError(code, message)

// ── A provider resource's estimate (POST /providers/estimate) ──

export interface ProviderEstimateInput {
  connection_id: number
  type?: string
  /** The form's fields (create), or the fields to change (update). Secrets are never needed. */
  desired?: Record<string, unknown> | null
  resource_id?: number | null
  app_id?: number | null
  environment_id?: number | null
  /** The form's expected data out (GB a month); absent = prefilled from what the Hub measured. */
  egress_gb_month?: number | null
  /** true = what deleting `resource_id` saves. */
  delete?: boolean
}

export interface ProviderEstimateAnswer extends CostEstimate {
  before: CostEstimate | null
  deltaMonthlyCents: number
  traffic: EstimateTraffic | null
}

/** The fields an estimate may see: known, not read-only, secrets reduced to "a value is set". */
function estimateFields(
  type: ResourceTypeSpec,
  raw: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(raw)) {
    const spec: FieldSpec | undefined = type.fields.find((f) => f.key === k)
    if (!spec || spec.readOnly) continue
    if (spec.kind === 'secret') {
      if (v != null && v !== '') out[k] = { fingerprint: 'estimate', changed: true }
      continue
    }
    out[k] = v
  }
  return out
}

/** One resource's estimate as `actor` may ask it (the plan's access rule, no provider read). */
export async function estimateProvider(
  input: ProviderEstimateInput,
  actor: HubActor
): Promise<ProviderEstimateAnswer> {
  const conn = await openConnection(Number(input.connection_id))
  const row = input.resource_id != null ? await readResource(Number(input.resource_id)) : null
  if (input.resource_id != null && (!row || row.deleted_at))
    throw refuse('NOT_FOUND', 'No such resource.')
  const typeKey = row?.type ?? input.type
  const hit = typeKey ? findType(typeKey) : null
  if (
    !hit ||
    hit.provider.key !== conn.row.provider ||
    (row && input.type && input.type !== row.type)
  )
    throw refuse(
      'UNKNOWN_TYPE',
      `Unknown resource type ${typeKey ?? '(none)'} for this connection.`
    )
  const type = hit.type
  const scope = row?.scope ?? type.scope
  const appId = scope === 'app' ? (row?.app_id ?? input.app_id ?? null) : null
  // Create app: the app does not exist yet — an administrator estimates its parts with no app
  // (the route is admin-only); every other estimate is judged like a plan.
  const unborn = scope === 'app' && appId == null && !row
  if (unborn && !actor.isAdmin) throw refuse('INVALID_FIELDS', 'Name the app the resource is for.')
  if (unborn && conn.row.status === 'disabled')
    throw refuse('CONNECTION_DISABLED', 'This connection is disabled.')
  const access = unborn
    ? { app: null, env: null, production: null }
    : await judgeAccess(
        {
          connection: conn.row,
          scope,
          appId,
          environmentId:
            scope === 'app' ? (row?.environment_id ?? input.environment_id ?? null) : null,
          types: [type],
          rows: row ? [row] : [],
          requestOps: row
            ? [{ action: input.delete ? 'delete' : 'update', resourceId: row.id }]
            : [{ action: 'create' }]
        },
        actor
      )
  const observed = row?.observed ?? null
  const overlay = isObj(input.desired) ? estimateFields(type, input.desired) : {}
  let fields: Record<string, unknown>
  if (row) {
    const base = row.desired ? planFormOf(type, row.desired) : { ...(observed?.fields ?? {}) }
    fields = { ...base, ...overlay }
  } else fields = withDefaults(type, overlay)
  const refIds = new Set<number>()
  for (const spec of type.fields) {
    const v = fields[spec.key]
    for (const x of Array.isArray(v) ? v : [v])
      if (isObj(x) && Number(x.resourceId) > 0) refIds.add(Number(x.resourceId))
  }
  const refRows = refIds.size ? await listResources({ ids: [...refIds] }) : []
  const refExt = new Map(
    refRows.filter((r) => r.connection_id === conn.row.id).map((r) => [r.id, r.external_id])
  )
  const desired: DesiredResource = desiredOf(
    { type, row, externalId: row?.external_id ?? null },
    fields,
    {
      scope,
      appId: access.app?.id ?? null,
      environmentId: access.env?.id ?? null,
      appKey: access.app?.key ?? null,
      envKey: access.env?.key ?? null,
      refExternal: (id) => refExt.get(id) ?? null
    }
  )
  const ctx = contextFor(conn, regionFor(conn.row.config, fields, observed))
  const traffic = await trafficFor(
    access.app?.id ?? null,
    access.env?.id ?? null,
    typeof input.egress_gb_month === 'number' ? input.egress_gb_month : null
  )
  if (traffic) ctx.traffic = traffic
  const rates = await effectiveRates(conn.row.id, {
    now: costsLiveDeps().now(),
    config: conn.row.config
  })
  const opts = { connectionId: conn.row.id, config: conn.row.config, rates }
  const before = row && observed ? await estimateResource(ctx, type, null, observed, opts) : null
  const after = input.delete ? null : await estimateResource(ctx, type, desired, observed, opts)
  const shown =
    after ??
    before ??
    ({
      currency: 'USD',
      monthlyCents: 0,
      oneTimeCents: 0,
      yearlyCents: 0,
      basis: 'free',
      confidence: 'exact',
      lines: [],
      priceAsOf: null
    } as CostEstimate)
  const c = opCostOf(before, after)
  return {
    ...shown,
    before,
    deltaMonthlyCents: isCostedType(type) ? c.deltaMonthlyCents : 0,
    traffic: traffic ?? null
  }
}

// ── Docker stacks ──

const LATEST_TEMPLATE = [...STACK_TEMPLATES].sort((a, b) =>
  a.from.localeCompare(b.from, 'en', { numeric: true })
)[STACK_TEMPLATES.length - 1]

/** The size template's roles (the newest template: the cost differs only by role counts). */
export function templateRoles(size: StackSize): StackRole[] {
  return structuredClone(LATEST_TEMPLATE.sizes[size]) as StackRole[]
}

async function factorOfDriver(driverId: number | null): Promise<number> {
  if (driverId == null) return 100
  try {
    const m = (await db(REGION_DRIVERS).where({ driver_id: driverId }).first('region_id')) as
      | { region_id: number }
      | undefined
    if (!m) return 100
    const r = (await db(REGIONS).where({ id: m.region_id }).first('cost_percent')) as
      | { cost_percent: number | null }
      | undefined
    const f = Number(r?.cost_percent ?? 100)
    return Number.isFinite(f) && f > 0 ? f : 100
  } catch {
    return 100
  }
}

async function sharedDriver(sharedId: number): Promise<number | null> {
  try {
    const s = (await db(SHARED).where({ id: sharedId }).first('driver_id')) as
      | { driver_id: number | null }
      | undefined
    return s?.driver_id == null ? null : Number(s.driver_id)
  } catch {
    return null
  }
}

interface EnvPlacement {
  envId: number
  appId: number
  kind: 'dedicated' | 'shared' | null
  driverId: number | null
  sharedId: number | null
}

async function placementOf(envId: number): Promise<EnvPlacement | null> {
  const r = (await db(`${ENVS} as e`)
    .leftJoin(`${PLACEMENTS} as p`, 'p.id', 'e.placement_id')
    .where('e.id', envId)
    .first(
      'e.id',
      'e.app_id',
      'p.kind as kind',
      'p.driver_id as driver_id',
      'p.shared_deployment_id as shared_id'
    )) as Record<string, unknown> | undefined
  if (!r) return null
  const kind = r.kind === 'dedicated' || r.kind === 'shared' ? r.kind : null
  const sharedId = r.shared_id == null ? null : Number(r.shared_id)
  return {
    envId: Number(r.id),
    appId: Number(r.app_id),
    kind,
    driverId:
      kind === 'shared' && sharedId != null
        ? await sharedDriver(sharedId)
        : r.driver_id == null
          ? null
          : Number(r.driver_id),
    sharedId
  }
}

/** The environment's newest measured stored files and database size (GB; null = not measured). */
async function measuredSizes(
  envId: number
): Promise<{ storage_gb: number | null; database_gb: number | null }> {
  let storage: number | null = null
  try {
    const s = (await db(SAMPLES)
      .where({ scope: 'environment', environment_id: envId })
      .whereNotNull('storage_bytes')
      .orderBy('sampled_at', 'desc')
      .first('storage_bytes')) as { storage_bytes: unknown } | undefined
    const v = Number(s?.storage_bytes)
    if (s && Number.isFinite(v) && v >= 0) storage = v / 1024 ** 3
  } catch {
    storage = null
  }
  let database: number | null = null
  try {
    const d = (await databaseBytes([envId])).get(envId)
    if (d != null) database = d / 1024 ** 3
  } catch {
    database = null
  }
  return { storage_gb: storage, database_gb: database }
}

async function rolesNow(kind: 'environment' | 'shared', id: number, size: StackSize) {
  let shape: ScaleShape | null = null
  try {
    shape = await readScaleShape(kind, id)
  } catch {
    shape = null
  }
  return applyScaleShape(templateRoles(size), shape)
}

async function rateCard() {
  const s = await readChargeback()
  return { rates: s.rates, currency: s.currency }
}

export interface StackEstimateInput {
  size?: unknown
  /** Role → replicas (scalable roles), laid over the size template. */
  replicas?: unknown
  /** Stack settings (none of them change the rate-card figure today; accepted for the form). */
  settings?: unknown
}

export interface BeforeAfter {
  before: CostEstimate | null
  after: CostEstimate | null
  deltaMonthlyCents: number
}

const baDelta = (before: CostEstimate | null, after: CostEstimate | null): BeforeAfter => ({
  before,
  after,
  deltaMonthlyCents: opCostOf(before, after).deltaMonthlyCents
})

/** What the environment's stack costs now (rate card), or null when it has no Docker stack. */
export async function currentStackEstimate(envId: number): Promise<CostEstimate | null> {
  const p = await placementOf(envId)
  if (!p?.kind) return null
  const { rates, currency } = await rateCard()
  const sizes = await measuredSizes(envId)
  const factor = await factorOfDriver(p.driverId)
  if (p.kind === 'shared')
    return estimateStack({ roles: [], shared: true, ...sizes }, rates, factor, currency)
  const settings = await readStackSettings(envId).catch(() => null)
  if (!settings) return null
  const roles = await rolesNow('environment', envId, settings.size)
  return estimateStack({ roles, ...sizes }, rates, factor, currency)
}

/** POST /environments/:envId/stack/estimate: the stack as it is → as planned. */
export async function stackEstimate(
  envId: number,
  input: StackEstimateInput
): Promise<BeforeAfter> {
  const p = await placementOf(envId)
  if (!p) throw refuse('NOT_FOUND', 'No such environment.')
  const settings = await readStackSettings(envId).catch(() => null)
  const size =
    typeof input.size === 'string' && (STACK_SIZES as readonly string[]).includes(input.size)
      ? (input.size as StackSize)
      : (settings?.size ?? 'small')
  if (input.size !== undefined && size !== input.size)
    throw refuse('INVALID_FIELDS', `size is one of ${STACK_SIZES.join(', ')}.`)
  const shape: ScaleShape = {}
  if (input.replicas !== undefined) {
    if (!isObj(input.replicas)) throw refuse('INVALID_FIELDS', 'replicas is {role: count}.')
    for (const [role, n] of Object.entries(input.replicas)) {
      if (!isRoleName(role) || typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 10)
        throw refuse('INVALID_FIELDS', 'replicas is {role: count}, each count 0–10.')
      shape[role as StackRoleName] = { replicas: n }
    }
  }
  const { rates, currency } = await rateCard()
  const sizes = await measuredSizes(envId)
  const factor = await factorOfDriver(p.driverId)
  const before = await currentStackEstimate(envId)
  // A planned shape keeps the stored scale (limits) and lays the asked replicas over it.
  const base = await rolesNow('environment', envId, size)
  const after = estimateStack(
    { roles: applyScaleShape(base, shape), ...sizes },
    rates,
    factor,
    currency
  )
  return baDelta(before, after)
}

/** A scale plan's cost: its `from` → `to` figures at the rate card (environment or shared). */
export async function scaleCost(
  target: { kind: 'environment' | 'shared'; id: number },
  from: readonly RoleFigures[],
  to: readonly RoleFigures[]
): Promise<BeforeAfter> {
  const { rates, currency } = await rateCard()
  let driver: number | null = null
  let sizes: { storage_gb: number | null; database_gb: number | null } = {
    storage_gb: null,
    database_gb: null
  }
  if (target.kind === 'environment') {
    driver = (await placementOf(target.id))?.driverId ?? null
    sizes = await measuredSizes(target.id)
  } else driver = await sharedDriver(target.id)
  const factor = await factorOfDriver(driver)
  const shapeOf = (list: readonly RoleFigures[]): StackShape => ({ roles: list, ...sizes })
  return baDelta(
    estimateStack(shapeOf(from), rates, factor, currency),
    estimateStack(shapeOf(to), rates, factor, currency)
  )
}

/** A move plan's cost: where the environment runs now → the target placement. */
export async function moveCost(envId: number, to: unknown): Promise<BeforeAfter | null> {
  if (!isObj(to)) return null
  const before = await currentStackEstimate(envId)
  const { rates, currency } = await rateCard()
  const sizes = await measuredSizes(envId)
  if (to.kind === 'shared' && Number.isInteger(to.shared_id)) {
    const factor = await factorOfDriver(await sharedDriver(Number(to.shared_id)))
    return baDelta(
      before,
      estimateStack({ roles: [], shared: true, ...sizes }, rates, factor, currency)
    )
  }
  if (to.kind === 'dedicated' && Number.isInteger(to.placement_id)) {
    const pl = (await db(PLACEMENTS)
      .where({ id: Number(to.placement_id) })
      .first('driver_id')) as { driver_id: number | null } | undefined
    const factor = await factorOfDriver(pl?.driver_id == null ? null : Number(pl.driver_id))
    const settings = await readStackSettings(envId).catch(() => null)
    const roles = await rolesNow('environment', envId, settings?.size ?? 'small')
    return baDelta(before, estimateStack({ roles, ...sizes }, rates, factor, currency))
  }
  return null
}

// ── Create app ──

export interface CreateEstimateEnv {
  key: string
  stack: CostEstimate | null
  providers: Array<{
    connection_id: number
    type: string
    estimate: CostEstimate | null
    error?: string
  }>
  monthlyCents: number
  unknown: number
}

export interface CreateEstimateAnswer {
  currency: string
  monthlyCents: number
  oneTimeCents: number
  unknown: number
  environments: CreateEstimateEnv[]
  note?: string
}

/** POST /apps/create/estimate: per environment, its stack at the rate card + its provider parts. */
export async function createEstimate(raw: unknown, actor: HubActor): Promise<CreateEstimateAnswer> {
  const body = isObj(raw) ? raw : {}
  const target = isObj(body.target) ? body.target : null
  const envs = Array.isArray(body.environments) ? body.environments.slice(0, 6) : []
  const { rates, currency } = await rateCard()
  let stack: CostEstimate | null = null
  let note: string | undefined
  if (target?.kind === 'docker' && Number.isInteger(target.driver_id)) {
    const s = isObj(target.stack) ? target.stack : {}
    const size =
      typeof s.size === 'string' && (STACK_SIZES as readonly string[]).includes(s.size)
        ? (s.size as StackSize)
        : 'small'
    stack = estimateStack(
      { roles: templateRoles(size) },
      rates,
      await factorOfDriver(Number(target.driver_id)),
      currency
    )
  } else if (target?.kind === 'shared' && Number.isInteger(target.shared_id)) {
    stack = estimateStack(
      { roles: [], shared: true },
      rates,
      await factorOfDriver(await sharedDriver(Number(target.shared_id))),
      currency
    )
  } else
    note = 'The app runs outside the Hub’s own hosts (a GitLab or GitHub target): no stack figure.'
  const out: CreateEstimateEnv[] = []
  for (const raw of envs) {
    const e = isObj(raw) ? raw : {}
    const parts: CreateEstimateEnv['providers'] = []
    for (const p of (Array.isArray(e.providers) ? e.providers : []).slice(0, 20)) {
      if (!isObj(p) || !Number.isInteger(p.connection_id) || typeof p.type !== 'string') continue
      try {
        const est = await estimateProvider(
          {
            connection_id: Number(p.connection_id),
            type: p.type,
            desired: isObj(p.fields) ? p.fields : {},
            app_id: null
          },
          actor
        )
        parts.push({ connection_id: Number(p.connection_id), type: p.type, estimate: est })
      } catch (err) {
        parts.push({
          connection_id: Number(p.connection_id),
          type: p.type,
          estimate: null,
          error: err instanceof ResourceChangeError ? err.code : 'ESTIMATE_FAILED'
        })
      }
    }
    const figures = [stack, ...parts.map((x) => x.estimate)].filter((x): x is CostEstimate => !!x)
    out.push({
      key: typeof e.key === 'string' ? e.key.slice(0, 40) : '',
      stack,
      providers: parts,
      monthlyCents: figures
        .filter((f) => f.confidence !== 'unknown')
        .reduce((n, f) => n + f.monthlyCents, 0),
      unknown:
        figures.filter((f) => f.confidence === 'unknown').length +
        parts.filter((x) => !x.estimate).length
    })
  }
  const answer: CreateEstimateAnswer = {
    currency,
    monthlyCents: out.reduce((n, e) => n + e.monthlyCents, 0),
    oneTimeCents: out.reduce(
      (n, e) =>
        n +
        e.providers.reduce(
          (m, p) =>
            m + (p.estimate && p.estimate.confidence !== 'unknown' ? p.estimate.oneTimeCents : 0),
          0
        ),
      0
    ),
    unknown: out.reduce((n, e) => n + e.unknown, 0),
    environments: out
  }
  if (note) answer.note = note
  return answer
}

// ── Run-rate ──

export interface RunRateRow {
  sampled_at: Date
  app_id: number | null
  environment_id: number | null
  provider: string | null
  resource_id: number | null
  kind: 'resource' | 'stack'
  monthly_cents: number
  basis: string
  confidence: string
}

const at = (v: unknown): number => {
  const d = v instanceof Date ? v : new Date(String(v))
  return d.getTime()
}

/** The newest run-rate row per resource (for "re-estimate only when observed changed"). */
async function lastResourceRows(): Promise<
  Map<number, { at: number; monthly: number; basis: string; confidence: string }>
> {
  const out = new Map<number, { at: number; monthly: number; basis: string; confidence: string }>()
  try {
    const newest = db(RUNRATE)
      .where('kind', 'resource')
      .whereNotNull('resource_id')
      .groupBy('resource_id')
      .select('resource_id')
      .max({ at: 'sampled_at' })
      .as('n')
    const rows = (await db(`${RUNRATE} as r`)
      .join(newest, function () {
        this.on('r.resource_id', '=', 'n.resource_id').andOn('r.sampled_at', '=', 'n.at')
      })
      .where('r.kind', 'resource')
      .select(
        'r.resource_id',
        'r.sampled_at',
        'r.monthly_cents',
        'r.basis',
        'r.confidence'
      )) as Array<Record<string, unknown>>
    for (const r of rows)
      out.set(Number(r.resource_id), {
        at: at(r.sampled_at),
        monthly: Number(r.monthly_cents) || 0,
        basis: String(r.basis),
        confidence: String(r.confidence)
      })
  } catch {
    /* behind migration 585: nothing kept */
  }
  return out
}

const monthBounds = (now: Date) => {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
  return { start, end, ms: end.getTime() - start.getTime() }
}

/** The resource rows of one tick (no write). */
export async function resourceRunRate(now: Date): Promise<RunRateRow[]> {
  const rows: RunRateRow[] = []
  const live = (await listResources({})).filter((r) => r.external_id && r.observed)
  if (!live.length) return rows
  const last = await lastResourceRows()
  const byConn = new Map<number, typeof live>()
  for (const r of live) {
    const l = byConn.get(r.connection_id) ?? []
    l.push(r)
    byConn.set(r.connection_id, l)
  }
  const { start } = monthBounds(now)
  for (const [connectionId, list] of byConn) {
    let conn: Awaited<ReturnType<typeof openConnection>>
    try {
      conn = await openConnection(connectionId)
    } catch {
      continue
    }
    if (conn.row.status === 'disabled') continue
    const rates = await effectiveRates(connectionId, { now, config: conn.row.config })
    // Near-live usage of usage-priced resources (Anthropic / OpenAI / Vercel / Twilio …).
    const usage = new Map<string, number>()
    if (conn.adapter.usageNow) {
      try {
        const ctx = contextFor(conn, regionFor(conn.row.config, null, null))
        for (const u of await conn.adapter.usageNow(ctx, {
          from: start.toISOString().slice(0, 10),
          to: now.toISOString().slice(0, 10)
        }))
          if (
            u.externalId &&
            Number.isFinite(u.amountCents) &&
            (u.recordType ?? 'usage') === 'usage'
          )
            usage.set(u.externalId, (usage.get(u.externalId) ?? 0) + u.amountCents)
      } catch {
        /* usage is a bonus: the estimate stands */
      }
    }
    const elapsed = Math.max(1 / 24, (now.getTime() - start.getTime()) / monthBounds(now).ms)
    for (const r of list) {
      const hit = findType(r.type)
      if (!hit || !isCostedType(hit.type)) continue
      const prev = last.get(r.id)
      const observedAt = r.observed_at ? at(r.observed_at) : Number.POSITIVE_INFINITY
      let monthly: number
      let basis: string
      let confidence: string
      if (prev && observedAt <= prev.at) {
        monthly = prev.monthly
        basis = prev.basis
        confidence = prev.confidence
      } else {
        const ctx = contextFor(conn, regionFor(conn.row.config, null, r.observed))
        // Measured data out of this very resource (CloudWatch, cached an hour) is its traffic.
        const own = r.external_id
          ? costsLiveDeps().resourceEgress(connectionId, r.type, r.external_id)
          : null
        if (own != null && own > 0) ctx.traffic = { egressGbMonth: own, source: 'measured' }
        const est = await estimateResource(ctx, hit.type, null, r.observed, {
          connectionId,
          config: conn.row.config,
          rates
        })
        if (!est) continue
        monthly = est.confidence === 'unknown' ? 0 : est.monthlyCents
        basis = est.basis
        confidence = est.confidence
      }
      const used = r.external_id ? usage.get(r.external_id) : undefined
      if (used != null && used > 0) {
        monthly = Math.max(monthly, Math.round(used / elapsed))
        if (confidence === 'unknown') confidence = 'usage_varies'
      }
      rows.push({
        sampled_at: now,
        app_id: r.app_id,
        environment_id: r.environment_id,
        provider: r.provider,
        resource_id: r.id,
        kind: 'resource',
        monthly_cents: Math.round(monthly),
        basis: basis.slice(0, 16),
        confidence: confidence.slice(0, 16)
      })
    }
  }
  return rows
}

/** The stack rows of one tick: each environment's rate-card figure from measured usage. */
export async function stackRunRate(now: Date): Promise<RunRateRow[]> {
  const report = await chargebackReport(now)
  if (report.unrated) return []
  const rows: RunRateRow[] = []
  for (const a of report.apps)
    for (const e of a.environments) {
      if (e.runs_on === 'Not placed') continue
      rows.push({
        sampled_at: now,
        app_id: a.app_id,
        environment_id: e.env_id,
        provider: null,
        resource_id: null,
        kind: 'stack',
        monthly_cents: Math.round(e.cost.total * 100),
        basis: 'rate_card',
        confidence: e.gaps.length ? 'list_price' : 'exact'
      })
    }
  return rows
}

export async function insertRunRate(rows: RunRateRow[]): Promise<void> {
  for (let i = 0; i < rows.length; i += 100) await db(RUNRATE).insert(rows.slice(i, i + 100))
}

export async function pruneRunRate(now: Date): Promise<number> {
  const before = new Date(now.getTime() - RUNRATE_KEEP_DAYS * 86_400_000)
  try {
    return Number(await db(RUNRATE).where('sampled_at', '<', before).del()) || 0
  } catch {
    return 0
  }
}

export interface RunRateTickResult {
  rows: number
  apps: number
  alerts: number
  pruned: number
}

/**
 * The tick after each capacity sample run (Hub only). Never throws: a part that fails is
 * skipped (the next tick tries again).
 */
export async function runRateTick(now = costsLiveDeps().now()): Promise<RunRateTickResult> {
  const out: RunRateTickResult = { rows: 0, apps: 0, alerts: 0, pruned: 0 }
  if (!hubModeEnabled()) return out
  let rows: RunRateRow[] = []
  try {
    rows = rows.concat(await resourceRunRate(now))
  } catch {
    /* next tick */
  }
  try {
    rows = rows.concat(await stackRunRate(now))
  } catch {
    /* next tick */
  }
  try {
    await insertRunRate(rows)
    out.rows = rows.length
  } catch {
    return out
  }
  const apps = [...new Set(rows.map((r) => r.app_id).filter((x): x is number => x != null))]
  out.apps = apps.length
  if (rows.length) emitOps('hub:costs', { app_ids: apps.slice(0, 500) })
  try {
    out.alerts = await checkBudgets(now)
  } catch {
    /* next tick */
  }
  out.pruned = await pruneRunRate(now)
  return out
}

// ── Now, month to date, forecast, billed ──

export interface LiveFilter {
  /** null = every app (administrators). */
  appIds: number[] | null
  environmentId?: number | null
}

export interface LiveSeries {
  kind: 'resource' | 'stack'
  app_id: number | null
  environment_id: number | null
  provider: string | null
  resource_id: number | null
  nowCents: number
  monthToDateCents: number
  basis: string | null
  confidence: string | null
}

export interface LiveCosts {
  currency: string
  sampledAt: string | null
  nowCents: number
  monthToDateCents: number
  forecastCents: number
  month: string
  billed: { throughDate: string | null; monthToDateCents: number } | null
  /** Billed so far against the estimated accrual over the same days (null = nothing billed). */
  gapCents: number | null
  byApp: Array<{
    app_id: number
    nowCents: number
    monthToDateCents: number
    forecastCents: number
  }>
  byProvider: Array<{ provider: string; nowCents: number; monthToDateCents: number }>
  series: LiveSeries[]
}

const seriesKey = (r: Record<string, unknown>) =>
  [r.kind, r.app_id, r.environment_id, r.provider, r.resource_id].map((x) => x ?? '').join('|')

function scoped(q: Knex.QueryBuilder, f: LiveFilter): Knex.QueryBuilder {
  if (f.appIds) q.whereIn('app_id', f.appIds.length ? f.appIds : [-1])
  if (f.environmentId != null) q.where('environment_id', f.environmentId)
  return q
}

/** The live figures for the filter (GET /costs/live). */
export async function liveCosts(f: LiveFilter, now = costsLiveDeps().now()): Promise<LiveCosts> {
  const { start, end, ms } = monthBounds(now)
  const { currency } = await rateCard()
  const newest = (await scoped(db(RUNRATE), f)
    .where('sampled_at', '<=', now)
    .max({ at: 'sampled_at' })
    .first()) as { at: unknown } | undefined
  const newestAt = newest?.at == null ? null : new Date(at(newest.at))
  const nowRows = newestAt
    ? ((await scoped(db(RUNRATE), f).where('sampled_at', newestAt).select('*')) as Array<
        Record<string, unknown>
      >)
    : []
  // A newest sample older than two intervals is not "now" (the tick stopped): nothing runs.
  const fresh = !!newestAt && now.getTime() - newestAt.getTime() <= 2 * SAMPLE_MS
  const sums = (await scoped(db(RUNRATE), f)
    .where('sampled_at', '>=', start)
    .where('sampled_at', '<=', now)
    .groupBy('kind', 'app_id', 'environment_id', 'provider', 'resource_id')
    .select('kind', 'app_id', 'environment_id', 'provider', 'resource_id')
    .sum({ s: 'monthly_cents' })) as Array<Record<string, unknown>>
  const series = new Map<string, LiveSeries>()
  const seriesOf = (r: Record<string, unknown>) => {
    const k = seriesKey(r)
    let s = series.get(k)
    if (!s) {
      s = {
        kind: r.kind === 'stack' ? 'stack' : 'resource',
        app_id: r.app_id == null ? null : Number(r.app_id),
        environment_id: r.environment_id == null ? null : Number(r.environment_id),
        provider: r.provider == null ? null : String(r.provider),
        resource_id: r.resource_id == null ? null : Number(r.resource_id),
        nowCents: 0,
        monthToDateCents: 0,
        basis: null,
        confidence: null
      }
      series.set(k, s)
    }
    return s
  }
  for (const r of sums)
    seriesOf(r).monthToDateCents = Math.round((Number(r.s) || 0) * (SAMPLE_MS / ms))
  if (fresh)
    for (const r of nowRows) {
      const s = seriesOf(r)
      s.nowCents = Number(r.monthly_cents) || 0
      s.basis = String(r.basis)
      s.confidence = String(r.confidence)
    }
  const list = [...series.values()]
  const left = Math.max(0, end.getTime() - now.getTime()) / ms
  const nowCents = list.reduce((n, s) => n + s.nowCents, 0)
  const mtd = list.reduce((n, s) => n + s.monthToDateCents, 0)
  const byAppMap = new Map<number, LiveCosts['byApp'][number]>()
  const byProvMap = new Map<string, LiveCosts['byProvider'][number]>()
  for (const s of list) {
    if (s.app_id != null) {
      const a = byAppMap.get(s.app_id) ?? {
        app_id: s.app_id,
        nowCents: 0,
        monthToDateCents: 0,
        forecastCents: 0
      }
      a.nowCents += s.nowCents
      a.monthToDateCents += s.monthToDateCents
      byAppMap.set(s.app_id, a)
    }
    const pk = s.provider ?? (s.kind === 'stack' ? 'hub-stack' : 'other')
    const p = byProvMap.get(pk) ?? { provider: pk, nowCents: 0, monthToDateCents: 0 }
    p.nowCents += s.nowCents
    p.monthToDateCents += s.monthToDateCents
    byProvMap.set(pk, p)
  }
  for (const a of byAppMap.values())
    a.forecastCents = a.monthToDateCents + Math.round(a.nowCents * left)
  const billed = await billedSoFar(f, start, now)
  let gap: number | null = null
  if (billed?.throughDate) {
    // The estimate accrued over the same billed days (rows up to the end of that day).
    const through = new Date(`${billed.throughDate}T23:59:59.999Z`)
    const est = (await scoped(db(RUNRATE), f)
      .where('sampled_at', '>=', start)
      .where('sampled_at', '<=', through < now ? through : now)
      .sum({ s: 'monthly_cents' })
      .first()) as { s: unknown } | undefined
    gap = billed.monthToDateCents - Math.round((Number(est?.s) || 0) * (SAMPLE_MS / ms))
  }
  return {
    currency,
    sampledAt: newestAt ? newestAt.toISOString() : null,
    nowCents,
    monthToDateCents: mtd,
    forecastCents: mtd + Math.round(nowCents * left),
    month: start.toISOString().slice(0, 7),
    billed,
    gapCents: gap,
    byApp: [...byAppMap.values()].sort((x, y) => y.forecastCents - x.forecastCents),
    byProvider: [...byProvMap.values()].sort((x, y) => y.monthToDateCents - x.monthToDateCents),
    series: list.sort((x, y) => y.nowCents - x.nowCents).slice(0, 500)
  }
}

/** What the providers billed this month so far (Task 34's feed), or null before it exists. */
async function billedSoFar(f: LiveFilter, start: Date, now: Date): Promise<LiveCosts['billed']> {
  try {
    if (!(await db.schema.hasTable(PROVIDER_COSTS))) return null
    const q = db(PROVIDER_COSTS)
      .where('date', '>=', start.toISOString().slice(0, 10))
      .where('date', '<=', now.toISOString().slice(0, 10))
    if (f.appIds) q.whereIn('app_id', f.appIds.length ? f.appIds : [-1])
    if (f.environmentId != null) {
      // The feed maps rows to apps and resources, not environments: only resource rows of the
      // environment count.
      const ids = (await listResources({ environmentId: f.environmentId })).map((r) => r.id)
      q.whereIn('resource_id', ids.length ? ids : [-1])
    }
    const r = (await q.sum({ s: 'amount_cents' }).max({ d: 'date' }).first()) as
      | { s: unknown; d: unknown }
      | undefined
    if (!r || r.d == null) return { throughDate: null, monthToDateCents: 0 }
    const d = r.d instanceof Date ? r.d.toISOString().slice(0, 10) : String(r.d).slice(0, 10)
    return { throughDate: d, monthToDateCents: Math.round(Number(r.s) || 0) }
  } catch {
    return null
  }
}

// ── Budgets ──

const monthKey = (now: Date) => now.toISOString().slice(0, 7)

/** The threshold to alert now (80 | 100), or null (nothing new crossed this month). */
export function budgetThreshold(
  forecastCents: number,
  budgetCents: number,
  last: { month: string | null; pct: number | null },
  month: string
): 80 | 100 | null {
  if (!(budgetCents > 0)) return null
  const pct = (forecastCents / budgetCents) * 100
  const crossed: 80 | 100 | null = pct >= 100 ? 100 : pct >= 80 ? 80 : null
  if (!crossed) return null
  const sent = last.month === month ? (last.pct ?? 0) : 0
  return crossed > sent ? crossed : null
}

async function defaultOverBudget(p: OverBudgetNotice): Promise<void> {
  const money = (c: number) => `${(c / 100).toFixed(2)} ${p.currency}`
  await deliverHubNotice(await hubEventRecipients(p.appId), {
    subject: `${p.appKey}: forecast at ${p.pct}% of its budget`,
    message: `This month's forecast is ${money(p.forecastCents)} against a budget of ${money(p.budgetCents)} (${p.month}).`,
    path: `/hub/costs?app=${p.appId}`,
    urgent: p.pct >= 100,
    source: { kind: 'hub-cost-budget', label: p.appKey, id: p.appId },
    why: 'You are a Hub administrator or an owner of this app.'
  })
  // Task 13: the app's and the Hub's notify routes for this event (Slack, Teams, email, SMS…).
  const { notifyHub } = await import('./notify.js')
  void notifyHub('cost.over_budget', {
    appId: p.appId,
    title: `${p.appKey}: forecast at ${p.pct}% of its budget`,
    body: `This month's forecast is ${money(p.forecastCents)} against a budget of ${money(p.budgetCents)} (${p.month}).`,
    link: `/hub/costs?app=${p.appId}`,
    severity: p.pct >= 100 ? 'critical' : 'warning',
    dedupKey: `cost:${p.appId}:${p.month}:${p.pct}`
  })
}

/** Checks every budget against its app's forecast; answers how many alerts went out. */
export async function checkBudgets(now: Date): Promise<number> {
  const budgets = (await listBudgets()).filter((b) => b.monthly_cents > 0)
  if (!budgets.length) return 0
  const month = monthKey(now)
  const live = await liveCosts({ appIds: budgets.map((b) => b.app_id) }, now)
  const byApp = new Map(live.byApp.map((a) => [a.app_id, a]))
  const keys = new Map(
    (
      (await db(APPS)
        .whereIn(
          'id',
          budgets.map((b) => b.app_id)
        )
        .select('id', 'key')) as Array<Record<string, unknown>>
    ).map((a) => [Number(a.id), String(a.key)])
  )
  let sent = 0
  for (const b of budgets) {
    const forecast = byApp.get(b.app_id)?.forecastCents ?? 0
    const pct = budgetThreshold(
      forecast,
      b.monthly_cents,
      { month: b.last_alert_month, pct: b.last_alert_pct },
      month
    )
    if (!pct) continue
    // Claim the threshold first (compare-and-set), so two ticks never both alert.
    const claimed = await db(COST_BUDGETS)
      .where({ app_id: b.app_id })
      .where((w) => {
        if (b.last_alert_month == null) w.whereNull('last_alert_month')
        else w.where('last_alert_month', b.last_alert_month)
      })
      .where((w) => {
        if (b.last_alert_pct == null) w.whereNull('last_alert_pct')
        else w.where('last_alert_pct', b.last_alert_pct)
      })
      .update({ last_alert_month: month, last_alert_pct: pct })
    if (!claimed) continue
    const notice: OverBudgetNotice = {
      appId: b.app_id,
      appKey: keys.get(b.app_id) ?? `app ${b.app_id}`,
      pct,
      forecastCents: forecast,
      budgetCents: b.monthly_cents,
      currency: live.currency,
      month
    }
    try {
      await (costsLiveDeps().notifyOverBudget ?? defaultOverBudget)(notice)
    } catch {
      /* the threshold stays claimed: one alert per threshold per month, never a storm */
    }
    sent++
  }
  return sent
}
