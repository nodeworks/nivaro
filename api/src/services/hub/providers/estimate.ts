import { db } from '../../../db/index.js'
import { awsMeasuredEgress, awsResourceEgress } from './aws/egress.js'
import type { PlanCostTotal } from './engine/contract.js'
import { applyRates, effectiveRates, unknownEstimate } from './pricing/index.js'
import type {
  CostEstimate,
  DesiredResource,
  EstimateTraffic,
  Observed,
  PlannedOp,
  ProviderContext,
  ResourceTypeSpec
} from './types.js'

/**
 * Estimates as the engine uses them (Task 44a): one resource's figure with the connection's tax /
 * discount lines and the traffic prefill, the per-op before → after, a plan's totals and the
 * owner auto-approve rule. A leaf module (no engine import), so plan.ts and costs-live.ts both
 * read it without a cycle.
 *
 * Rules:
 *  - An adapter's estimate never stops a plan: a throw or a slow answer (ESTIMATE_TIMEOUT_MS) is
 *    "No estimate" (`confidence: 'unknown'`).
 *  - A type with no `estimate` and no `costClass` costs nothing by contract (no figure, not
 *    counted unknown); one with a `costClass` and no estimate is unknown (the guard test keeps
 *    that list to Wave 1 until Task 44b).
 *  - An `unknown` estimate never auto-approves; neither does a Hub with no limit set (0).
 */

export const COSTS_SETTINGS = { extension_id: 'nivaro-hub', key: 'costs' } as const
export const COST_BUDGETS = 'nivaro_hub_cost_budgets'
export const ESTIMATE_TIMEOUT_MS = 5_000
/** The largest auto-approve limit an administrator may set (cents): $100,000 a month. */
export const MAX_AUTO_APPROVE_CENTS = 10_000_000

// ── Seams (tests and later tasks set them) ──

export interface CostsLiveDeps {
  now: () => Date
  /**
   * What the Hub measured going out of each environment of an app, GB a month (environment id →
   * GB). The default is the AWS CloudWatch reader (aws/egress.ts: one batched read per connection,
   * at most hourly, cached); other providers add nothing.
   */
  measuredEgress: (appId: number) => Promise<Map<number, number>>
  /**
   * What one resource sent out, GB a month, from the measured cache (null = none): the run-rate
   * puts it on that resource's estimate as its traffic. Default: the AWS CloudWatch reader.
   */
  resourceEgress: (connectionId: number, type: string, externalId: string) => number | null
  /** Over-budget alerts (Task 13's notifyHub('cost.over_budget') when it lands). */
  notifyOverBudget: ((p: OverBudgetNotice) => Promise<void>) | null
  estimateTimeoutMs: number
}

export interface OverBudgetNotice {
  appId: number
  appKey: string
  pct: 80 | 100
  forecastCents: number
  budgetCents: number
  currency: string
  month: string
}

const defaults = (): CostsLiveDeps => ({
  now: () => new Date(),
  measuredEgress: (appId) => awsMeasuredEgress(appId),
  resourceEgress: (connectionId, type, externalId) =>
    awsResourceEgress(connectionId, type, externalId),
  notifyOverBudget: null,
  estimateTimeoutMs: ESTIMATE_TIMEOUT_MS
})

// Hub-only (HUB=on, never a shared deployment): the cost seams, set by tests and later tasks.
let current: CostsLiveDeps = defaults()

export function costsLiveDeps(): CostsLiveDeps {
  return current
}

export function configureCostsLive(over: Partial<CostsLiveDeps>): void {
  current = { ...current, ...over }
}

export function resetCostsLiveForTest(): void {
  current = defaults()
}

// ── Settings (Hub-wide auto-approve) ──

export interface CostSettings {
  /** An owner's costed change under this (monthly increase AND one-time) skips approval; 0 = never. */
  cost_auto_approve_under_cents: number
}

export const DEFAULT_COST_SETTINGS: CostSettings = { cost_auto_approve_under_cents: 0 }

const centsIn = (v: unknown, max = MAX_AUTO_APPROVE_CENTS): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max ? v : null

export function normalizeCostSettings(raw: unknown): CostSettings {
  const o =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  return {
    cost_auto_approve_under_cents:
      centsIn(o.cost_auto_approve_under_cents) ??
      DEFAULT_COST_SETTINGS.cost_auto_approve_under_cents
  }
}

/** What a PUT may send: a refusal sentence, or null. */
export function costSettingsRefusal(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return 'Send the settings as an object.'
  const o = raw as Record<string, unknown>
  const unknown = Object.keys(o).filter((k) => k !== 'cost_auto_approve_under_cents')
  if (unknown.length) return `Unknown setting: ${unknown[0].slice(0, 40)}.`
  if (
    o.cost_auto_approve_under_cents !== undefined &&
    centsIn(o.cost_auto_approve_under_cents) == null
  )
    return `cost_auto_approve_under_cents is a whole number of cents, 0–${MAX_AUTO_APPROVE_CENTS}.`
  return null
}

export async function readCostSettings(): Promise<CostSettings> {
  try {
    const row = (await db('nivaro_extension_settings').where(COSTS_SETTINGS).first('value')) as
      | { value: string | null }
      | undefined
    return normalizeCostSettings(row?.value ? JSON.parse(row.value) : {})
  } catch {
    return { ...DEFAULT_COST_SETTINGS }
  }
}

export async function writeCostSettings(s: CostSettings): Promise<void> {
  const value = JSON.stringify(normalizeCostSettings(s))
  const existing = (await db('nivaro_extension_settings').where(COSTS_SETTINGS).first('id')) as
    | { id: number }
    | undefined
  if (existing)
    await db('nivaro_extension_settings')
      .where({ id: existing.id })
      .update({ value, updated_at: new Date() })
  else
    await db('nivaro_extension_settings').insert({
      ...COSTS_SETTINGS,
      value,
      updated_at: new Date()
    })
}

// ── Budgets ──

export interface CostBudget {
  app_id: number
  monthly_cents: number
  /** null = the Hub-wide limit applies. */
  auto_approve_under_cents: number | null
  last_alert_month: string | null
  last_alert_pct: number | null
  updated_by: string | null
  updated_at: string | null
}

const numOrNull = (v: unknown): number | null =>
  v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v)

function budgetOf(r: Record<string, unknown>): CostBudget {
  const at = r.updated_at
  const d = at == null ? null : at instanceof Date ? at : new Date(String(at))
  return {
    app_id: Number(r.app_id),
    monthly_cents: numOrNull(r.monthly_cents) ?? 0,
    auto_approve_under_cents: numOrNull(r.auto_approve_under_cents),
    last_alert_month: r.last_alert_month == null ? null : String(r.last_alert_month),
    last_alert_pct: numOrNull(r.last_alert_pct),
    updated_by: r.updated_by == null ? null : String(r.updated_by),
    updated_at: d && Number.isFinite(d.getTime()) ? d.toISOString() : null
  }
}

export async function readBudget(appId: number): Promise<CostBudget | null> {
  try {
    const r = (await db(COST_BUDGETS).where({ app_id: appId }).first()) as
      | Record<string, unknown>
      | undefined
    return r ? budgetOf(r) : null
  } catch {
    return null
  }
}

export async function listBudgets(): Promise<CostBudget[]> {
  try {
    return ((await db(COST_BUDGETS).select('*')) as Array<Record<string, unknown>>).map(budgetOf)
  } catch {
    return []
  }
}

export interface BudgetInput {
  monthly_cents: number
  auto_approve_under_cents: number | null
}

/** What a budget PUT may send: the checked input, or a refusal sentence. */
export function checkBudgetInput(raw: unknown): BudgetInput | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'Send the budget as an object.'
  const o = raw as Record<string, unknown>
  const unknown = Object.keys(o).filter(
    (k) => k !== 'monthly_cents' && k !== 'auto_approve_under_cents'
  )
  if (unknown.length) return `Unknown field: ${unknown[0].slice(0, 40)}.`
  const monthly = centsIn(o.monthly_cents, 1_000_000_000)
  if (monthly == null) return 'monthly_cents is a whole number of cents (0 = no budget).'
  let auto: number | null = null
  if (o.auto_approve_under_cents !== undefined && o.auto_approve_under_cents !== null) {
    auto = centsIn(o.auto_approve_under_cents)
    if (auto == null)
      return `auto_approve_under_cents is a whole number of cents, 0–${MAX_AUTO_APPROVE_CENTS}, or null.`
  }
  return { monthly_cents: monthly, auto_approve_under_cents: auto }
}

export async function writeBudget(
  appId: number,
  input: BudgetInput,
  by: string | null
): Promise<CostBudget> {
  const values = {
    monthly_cents: input.monthly_cents,
    auto_approve_under_cents: input.auto_approve_under_cents,
    updated_by: by && /^[0-9a-f-]{36}$/i.test(by) ? by : null,
    updated_at: new Date()
  }
  const n = await db(COST_BUDGETS).where({ app_id: appId }).update(values)
  if (!n) await db(COST_BUDGETS).insert({ app_id: appId, ...values })
  return (await readBudget(appId)) as CostBudget
}

/** The auto-approve limit for an owner's change on this app (cents; 0 = every change waits). */
export async function autoApproveLimit(appId: number | null): Promise<number> {
  if (appId != null) {
    const b = await readBudget(appId)
    if (b?.auto_approve_under_cents != null) return b.auto_approve_under_cents
  }
  return (await readCostSettings()).cost_auto_approve_under_cents
}

// ── One resource's estimate ──

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve('timeout'), ms)
    t.unref?.()
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      }
    )
  })
}

const isEstimate = (v: unknown): v is CostEstimate =>
  !!v &&
  typeof v === 'object' &&
  typeof (v as CostEstimate).monthlyCents === 'number' &&
  Array.isArray((v as CostEstimate).lines) &&
  typeof (v as CostEstimate).confidence === 'string'

/** Whether a type can cost anything (it has an estimate or a costClass). */
export const isCostedType = (type: ResourceTypeSpec): boolean =>
  typeof type.estimate === 'function' || typeof type.costClass === 'function'

export interface EstimateOptions {
  connectionId: number
  config?: Record<string, unknown> | null
  /** Rates already read for this connection (one read per plan). */
  rates?: Awaited<ReturnType<typeof effectiveRates>>
}

/**
 * The estimate of one resource (desired null = what it costs now), with the connection's tax and
 * discount lines. null = the type costs nothing by contract. Never throws.
 */
export async function estimateResource(
  ctx: ProviderContext,
  type: ResourceTypeSpec,
  desired: DesiredResource | null,
  observed: Observed | null,
  opts: EstimateOptions
): Promise<CostEstimate | null> {
  if (!isCostedType(type)) return null
  if (typeof type.estimate !== 'function')
    return unknownEstimate('This resource type has no estimate yet.')
  let est: CostEstimate
  try {
    const got = await withTimeout(
      Promise.resolve(type.estimate(ctx, desired, observed)),
      current.estimateTimeoutMs
    )
    if (got === 'timeout') return unknownEstimate('The price could not be read in time.')
    if (!isEstimate(got)) return unknownEstimate()
    est = got
  } catch {
    return unknownEstimate('The price could not be read.')
  }
  try {
    const rates =
      opts.rates ??
      (await effectiveRates(opts.connectionId, {
        now: current.now(),
        ...(opts.config !== undefined ? { config: opts.config } : {})
      }))
    return applyRates(est, rates)
  } catch {
    return est
  }
}

/**
 * The traffic an estimate assumes: the form's figure when it sent one, else what the Hub measured
 * for the same app (the environment itself first, else the busiest other environment), else none.
 */
export async function trafficFor(
  appId: number | null,
  environmentId: number | null,
  form?: number | null
): Promise<EstimateTraffic | undefined> {
  if (typeof form === 'number' && Number.isFinite(form) && form >= 0)
    return { egressGbMonth: form, source: 'form' }
  if (appId == null) return undefined
  let byEnv: Map<number, number>
  try {
    byEnv = await current.measuredEgress(appId)
  } catch {
    return undefined
  }
  const own = environmentId != null ? byEnv.get(environmentId) : undefined
  if (typeof own === 'number' && Number.isFinite(own) && own > 0)
    return { egressGbMonth: own, source: 'measured' }
  let best = 0
  for (const v of byEnv.values()) if (Number.isFinite(v) && v > best) best = v
  return best > 0 ? { egressGbMonth: best, source: 'measured' } : undefined
}

// ── Plans ──

export type { PlanCostTotal }
export type OpCost = NonNullable<PlannedOp['cost']>

export function opCostOf(before: CostEstimate | null, after: CostEstimate | null): OpCost {
  // An after-figure the Hub could not price is no change of figure, never "now free": a reader
  // that only looks at the delta must not see a saving that is not there.
  if (after && after.confidence === 'unknown') return { before, after, deltaMonthlyCents: 0 }
  const b = before && before.confidence !== 'unknown' ? before.monthlyCents : 0
  const a = after && after.confidence !== 'unknown' ? after.monthlyCents : 0
  return { before, after, deltaMonthlyCents: a - b }
}

/** Unknown = the side of the op that matters (after, or before for a delete) has no figure. */
export function opIsUnknown(op: PlannedOp): boolean {
  const c = op.cost
  if (!c) return false
  const side = op.kind === 'delete' ? c.before : c.after
  return !side || side.confidence === 'unknown'
}

/** The change's totals over its ops' costs. */
export function planCostTotal(ops: readonly PlannedOp[], now: Date): PlanCostTotal {
  let delta = 0
  let once = 0
  let yearly = 0
  let unknown = 0
  for (const op of ops) {
    const c = op.cost
    if (!c) continue
    if (opIsUnknown(op)) unknown++
    delta += c.deltaMonthlyCents
    const a = c.after && c.after.confidence !== 'unknown' ? c.after : null
    const b = c.before && c.before.confidence !== 'unknown' ? c.before : null
    // One-time amounts are paid on a create (or a replace); yearly ones change like monthly.
    if (a && (op.kind === 'create' || op.kind === 'replace')) once += a.oneTimeCents
    yearly += (a?.yearlyCents ?? 0) - (b?.yearlyCents ?? 0)
  }
  return {
    deltaMonthlyCents: delta,
    oneTimeCents: once,
    yearlyCents: yearly,
    unknownOps: unknown,
    checkedAt: now.toISOString()
  }
}

/**
 * Whether an owner's costed change goes through without an administrator: a limit is set (> 0),
 * every costed op has a figure, and the monthly increase, the one-time total and the yearly
 * increase are each under the limit — summed over the ops that cost MORE, never netted against
 * deletes or savings in the same change. Any op with the `cost` flag and no figure keeps it waiting.
 */
export function autoApproves(
  ops: readonly PlannedOp[],
  total: PlanCostTotal,
  limit: number
): boolean {
  if (!(limit > 0)) return false
  if (total.unknownOps > 0) return false
  if (ops.some((o) => o.risk.includes('cost') && !o.cost)) return false
  // Increases only: a delete or a saving in the same change never offsets a new costed op.
  let monthlyUp = 0
  let yearlyUp = 0
  for (const op of ops) {
    const c = op.cost
    if (!c) continue
    monthlyUp += Math.max(0, c.deltaMonthlyCents)
    const a = c.after && c.after.confidence !== 'unknown' ? c.after.yearlyCents : 0
    const b = c.before && c.before.confidence !== 'unknown' ? c.before.yearlyCents : 0
    yearlyUp += Math.max(0, a - b)
  }
  return monthlyUp < limit && Math.max(0, total.oneTimeCents) < limit && yearlyUp < limit
}
