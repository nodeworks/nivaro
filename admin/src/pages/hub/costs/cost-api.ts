import { api } from '@/lib/api'

/**
 * Live costs and estimates (Task 44c, over the routes of Task 44a): the estimate shape every
 * figure carries, the live run-rate answer, budgets and the Hub-wide auto-approve limit. Amounts
 * are cents. Every figure is an estimate at list price and says so; Billed is the providers' own
 * bills (the cost feed), shown beside it with the gap.
 */

export type CostBasis = 'price_list' | 'plan_price' | 'rate_card' | 'usage' | 'free'
export type CostConfidence = 'exact' | 'list_price' | 'usage_varies' | 'unknown'
export type CostLineKind = 'base' | 'transfer' | 'tax' | 'discount'
export type CostLineSource =
  | 'price_list'
  | 'plan_price'
  | 'measured'
  | 'assumed'
  | 'learned_from_bill'
  | 'admin_rate'

export interface CostLine {
  label: string
  qty: number
  unit: string
  unitCents: number
  monthlyCents: number
  kind: CostLineKind
  source: CostLineSource
}

export interface CostEstimate {
  currency: string
  monthlyCents: number
  oneTimeCents: number
  yearlyCents: number
  basis: CostBasis
  confidence: CostConfidence
  lines: CostLine[]
  priceAsOf: string | null
  note?: string
}

export interface EstimateTraffic {
  egressGbMonth: number
  source: 'form' | 'measured'
}

/** POST /providers/estimate: the figure (after the change), what it costs now, the traffic used. */
export interface ProviderEstimate extends CostEstimate {
  before: CostEstimate | null
  deltaMonthlyCents: number
  traffic: EstimateTraffic | null
}

export interface ProviderEstimateBody {
  connection_id: number
  type?: string
  desired?: Record<string, unknown>
  resource_id?: number
  app_id?: number
  environment_id?: number
  /** Absent = the Hub's measured figure (or none). */
  egress_gb_month?: number
  delete?: boolean
}

export interface BeforeAfter {
  before: CostEstimate | null
  after: CostEstimate | null
  deltaMonthlyCents: number
}

export interface PlanCostTotal {
  deltaMonthlyCents: number
  oneTimeCents: number
  yearlyCents: number
  unknownOps: number
  checkedAt: string
}

export interface OpCost {
  before: CostEstimate | null
  after: CostEstimate | null
  deltaMonthlyCents: number
}

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

export interface CreateEstimate {
  currency: string
  monthlyCents: number
  oneTimeCents: number
  unknown: number
  environments: CreateEstimateEnv[]
  note?: string
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
  /** null = no provider cost feed yet ("No bill yet"). */
  billed: { throughDate: string | null; monthToDateCents: number } | null
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

export interface CostSettings {
  cost_auto_approve_under_cents: number
}

// ─── Query keys (every one starts with `hub`: live Hub updates refresh them) ──

export const costKeys = {
  all: ['hub-costs'] as const,
  live: (appId: number | null, envId: number | null = null) =>
    ['hub-costs', 'live', appId, envId] as const,
  budget: (appId: number) => ['hub-costs', 'budget', appId] as const,
  settings: () => ['hub-costs', 'settings'] as const,
  estimate: (what: string, body: unknown) => ['hub-costs', 'estimate', what, body] as const
}

const data = <T>(r: { data: { data: T } }) => r.data.data

export const fetchLiveCosts = (appId: number | null, envId: number | null = null) => {
  const q = new URLSearchParams()
  if (appId != null) q.set('app_id', String(appId))
  if (envId != null) q.set('environment_id', String(envId))
  const s = q.toString()
  return api.get<{ data: LiveCosts }>(`/hub/costs/live${s ? `?${s}` : ''}`).then(data)
}

export const fetchBudget = (appId: number) =>
  api.get<{ data: CostBudget }>(`/hub/apps/${appId}/cost-budget`).then(data)

export const saveBudget = (
  appId: number,
  body: { monthly_cents: number; auto_approve_under_cents: number | null }
) => api.put<{ data: CostBudget }>(`/hub/apps/${appId}/cost-budget`, body).then(data)

export const fetchCostSettings = () =>
  api.get<{ data: CostSettings }>('/hub/costs/settings').then(data)

export const saveCostSettings = (body: CostSettings) =>
  api.put<{ data: CostSettings }>('/hub/costs/settings', body).then(data)

export const estimateProvider = (body: ProviderEstimateBody, signal?: AbortSignal) =>
  api.post<{ data: ProviderEstimate }>('/hub/providers/estimate', body, { signal }).then(data)

export const estimateStack = (
  envId: number,
  body: { size?: string; replicas?: Record<string, number> },
  signal?: AbortSignal
) =>
  api
    .post<{ data: BeforeAfter }>(`/hub/environments/${envId}/stack/estimate`, body, { signal })
    .then(data)

export const estimateCreate = (body: unknown, signal?: AbortSignal) =>
  api.post<{ data: CreateEstimate }>('/hub/apps/create/estimate', body, { signal }).then(data)

// ─── Words ───────────────────────────────────────────────────────────────────

/** An amount in cents, in the estimate's currency ("$48.20"). */
export function cents(n: number, currency = 'USD'): string {
  const v = (Number.isFinite(n) ? n : 0) / 100
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(v)
  } catch {
    return `${v.toFixed(2)} ${currency}`
  }
}

/** A unit price in cents, keeping small prices readable ("$0.0104"). */
export function unitPrice(n: number, currency = 'USD'): string {
  const v = (Number.isFinite(n) ? n : 0) / 100
  const digits = v !== 0 && Math.abs(v) < 1 ? 4 : 2
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: digits
    }).format(v)
  } catch {
    return `${v.toFixed(digits)} ${currency}`
  }
}

/** "+$3.20" / "−$3.20" / "$0.00": a monthly difference. */
export function signedCents(n: number, currency = 'USD'): string {
  if (!n) return cents(0, currency)
  return `${n > 0 ? '+' : '−'}${cents(Math.abs(n), currency)}`
}

/** Monthly cents as an hourly figure (730 hours a month, the price lists' month). */
export const hourly = (monthlyCents: number, currency = 'USD') =>
  unitPrice(monthlyCents / 730, currency)

export const BASIS_COPY: Record<CostBasis, { label: string; hint: string }> = {
  price_list: { label: 'List price', hint: 'The provider’s published price list.' },
  plan_price: {
    label: 'Plan price',
    hint: 'The plan the account is on; the provider bills the account, not each resource.'
  },
  rate_card: { label: 'Hub rates', hint: 'The rates a Hub administrator set under Costs.' },
  usage: { label: 'Plus usage', hint: 'Priced by what it uses; the figure is the base only.' },
  free: { label: 'Free', hint: 'The provider does not charge for this.' }
}

export const SOURCE_COPY: Record<CostLineSource, string> = {
  price_list: 'price list',
  plan_price: 'plan price',
  measured: 'measured',
  assumed: 'assumed',
  learned_from_bill: 'from your bills',
  admin_rate: 'rate set by an administrator'
}

/** Where the traffic figure on a form came from. */
export function trafficWords(t: EstimateTraffic | null | undefined, typed: boolean): string {
  if (typed) return 'you entered'
  if (!t || !(t.egressGbMonth > 0)) return 'none assumed'
  return t.source === 'measured' ? 'measured' : 'you entered'
}

/** "Prices as of Nov 26" (the price's own date). */
export function asOfWords(iso: string | null): string | null {
  if (!iso) return null
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso)
  if (!Number.isFinite(d.getTime())) return null
  return `prices as of ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getUTCFullYear() === new Date().getUTCFullYear() ? undefined : 'numeric' })}`
}

/** A figure the screens can draw (an older Hub, or an unexpected answer, reads as no estimate). */
export const isEstimate = (e: unknown): e is CostEstimate =>
  !!e &&
  typeof e === 'object' &&
  typeof (e as CostEstimate).monthlyCents === 'number' &&
  typeof (e as CostEstimate).currency === 'string' &&
  Array.isArray((e as CostEstimate).lines)

export const isUnknown = (e: CostEstimate | null | undefined): boolean =>
  !isEstimate(e) || e.confidence === 'unknown'

/**
 * The plain sentences under a figure: what it leaves out (no transfer, tax or discount line) and
 * the estimate's own note. Never claims a line that is not there.
 */
export function caveats(e: CostEstimate): string[] {
  if (e.confidence === 'unknown') return e.note ? [e.note] : []
  const has = (k: CostLineKind) => e.lines.some((l) => l.kind === k)
  const out: string[] = []
  if (e.basis === 'free') {
    if (e.note) out.push(e.note)
    return out
  }
  if (!has('transfer') && !/transfer/i.test(e.note ?? '')) out.push('No data transfer counted.')
  if (!has('tax') && !/tax not included/i.test(e.note ?? '')) out.push('Tax not included.')
  if (!has('discount')) out.push('Credits and discounts not counted.')
  if (e.note) out.push(e.note)
  return out
}

/** The secret values of a form payload replaced by "set": an estimate never sends a secret. */
export function withoutSecrets(
  fields: Array<{ key: string; kind: string; fields?: unknown; items?: unknown }>,
  payload: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(payload)) {
    const f = fields.find((x) => x.key === k)
    out[k] = f ? scrub(f, v) : v
  }
  return out
}

type SpecLike = { key: string; kind: string; fields?: unknown; items?: unknown }

function scrub(f: SpecLike, v: unknown): unknown {
  if (f.kind === 'secret') return v != null && v !== '' ? true : null
  if (f.kind === 'object' && v && typeof v === 'object' && !Array.isArray(v))
    return withoutSecrets((f.fields as SpecLike[] | undefined) ?? [], v as Record<string, unknown>)
  if (f.kind === 'list' && Array.isArray(v) && f.items)
    return v.map((x) => scrub(f.items as SpecLike, x))
  return v
}
