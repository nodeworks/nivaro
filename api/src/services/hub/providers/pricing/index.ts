import { db } from '../../../../db/index.js'
import { getProvider } from '../registry.js'
import { readConnection } from '../store.js'
import type {
  ConnectionField,
  CostBasis,
  CostConfidence,
  CostEstimate,
  CostLine,
  EstimateTraffic,
  PriceAnswer,
  ProviderAdapter,
  ProviderContext
} from '../types.js'
import { awsPriceListLookup } from './aws-price-list.js'
import { bundledPrice } from './bundled.js'
import { PRICE_CACHE_MS, readCachedPrice, writeCachedPrice } from './cache.js'

/**
 * The price book (Task 44a, spec "Live costs and estimates"):
 *
 *  - priceLookup   one unit price: the 7-day cache, else the provider's price API (AWS Price List
 *                  in aws-price-list.ts, or an adapter's own `priceApi`), else the adapter's dated
 *                  bundled table, else a stale cache row, else null. Never throws; never blocks a
 *                  plan (a miss is "No estimate").
 *  - estimateOf    builds a CostEstimate from lines (monthlyCents = the lines' sum).
 *  - effectiveRates / applyRates   tax and discount as SEPARATE lines: tax learned from the
 *                  provider's own bills (nivaro_hub_provider_costs, Task 34's feed, last three
 *                  billed months) beats the admin rate on the connection (`tax_percent`, 0 =
 *                  exempt), else none ("tax not included"); a discount only when learned from a
 *                  bill, never assumed.
 *  - transferLine  data out from the form's traffic or the measured one.
 *  - missingEstimates  the guard rule: a type with a costClass needs an estimate.
 */

export type PriceSource = 'api' | 'cache' | 'bundled'

export interface PriceLookupAnswer extends PriceAnswer {
  source: PriceSource
}

/** Core price APIs by provider key (an adapter's own `priceApi` wins). */
const CORE_PRICE_APIS: Record<
  string,
  (ctx: ProviderContext, skuKey: string, region: string) => Promise<PriceAnswer | null>
> = {
  aws: awsPriceListLookup
}

function priceApiOf(adapter: ProviderAdapter | null, provider: string) {
  if (adapter?.priceApi) return adapter.priceApi.bind(adapter)
  return Object.hasOwn(CORE_PRICE_APIS, provider) ? CORE_PRICE_APIS[provider] : null
}

const validPrice = (p: PriceAnswer | null | undefined): p is PriceAnswer =>
  !!p &&
  typeof p.unitCents === 'number' &&
  Number.isFinite(p.unitCents) &&
  p.unitCents >= 0 &&
  typeof p.unit === 'string'

/**
 * One unit price. `region` '*' (or empty) = a price that is the same everywhere. Never throws:
 * a price the Hub cannot find anywhere answers null.
 */
export async function priceLookup(
  ctx: ProviderContext,
  provider: string,
  skuKey: string,
  region: string | null
): Promise<PriceLookupAnswer | null> {
  const reg = region || '*'
  let now: Date
  try {
    now = ctx.now()
  } catch {
    now = new Date()
  }
  const cached = await readCachedPrice(provider, skuKey, reg)
  if (cached && now.getTime() - cached.fetchedAt.getTime() < PRICE_CACHE_MS)
    return {
      unitCents: cached.unitCents,
      unit: cached.unit,
      currency: cached.currency,
      asOf: cached.asOf,
      source: 'cache'
    }
  const adapter = getProvider(provider)
  const api = priceApiOf(adapter, provider)
  if (api) {
    try {
      const p = await api(ctx, skuKey, reg === '*' ? '' : reg)
      if (validPrice(p)) {
        await writeCachedPrice(provider, skuKey, reg, p, now)
        return { ...p, source: 'api' }
      }
    } catch {
      // The provider's API failed (no permission, throttled, down): fall back below.
    }
  }
  const bundled = bundledPrice(adapter, skuKey, reg === '*' ? null : reg)
  if (bundled) return { ...bundled, source: 'bundled' }
  if (cached)
    return {
      unitCents: cached.unitCents,
      unit: cached.unit,
      currency: cached.currency,
      asOf: cached.asOf,
      source: 'cache'
    }
  return null
}

// ── Building estimates ──

const roundCents = (n: number): number => (Number.isFinite(n) ? Math.round(n) : 0)

export interface EstimateInput {
  currency?: string
  basis: CostBasis
  confidence: CostConfidence
  lines: CostLine[]
  oneTimeCents?: number
  yearlyCents?: number
  priceAsOf?: string | null
  note?: string
}

/** A CostEstimate whose monthlyCents is the sum of its lines (each rounded to a cent). */
export function estimateOf(input: EstimateInput): CostEstimate {
  const lines = input.lines.map((l) => ({ ...l, monthlyCents: roundCents(l.monthlyCents) }))
  const out: CostEstimate = {
    currency: input.currency ?? 'USD',
    monthlyCents: lines.reduce((n, l) => n + l.monthlyCents, 0),
    oneTimeCents: roundCents(input.oneTimeCents ?? 0),
    yearlyCents: roundCents(input.yearlyCents ?? 0),
    basis: input.basis,
    confidence: input.confidence,
    lines,
    priceAsOf: input.priceAsOf ?? null
  }
  if (input.note) out.note = input.note
  return out
}

/** One line: qty × unitCents (monthly). */
export function lineOf(
  label: string,
  qty: number,
  unit: string,
  unitCents: number,
  source: CostLine['source'],
  kind: CostLine['kind'] = 'base'
): CostLine {
  const q = Number.isFinite(qty) ? qty : 0
  const u = Number.isFinite(unitCents) ? unitCents : 0
  return { label, qty: q, unit, unitCents: u, monthlyCents: roundCents(q * u), kind, source }
}

/** "No estimate": the price could not be found (or the type cannot say). */
export function unknownEstimate(note = 'No price found for this resource.'): CostEstimate {
  return estimateOf({ basis: 'usage', confidence: 'unknown', lines: [], note })
}

/** A resource that costs nothing by itself. */
export function freeEstimate(note?: string): CostEstimate {
  return estimateOf({
    basis: 'free',
    confidence: 'exact',
    lines: [],
    ...(note ? { note } : {})
  })
}

/**
 * The data-transfer line for the traffic on the context: null when no traffic is assumed. A
 * measured figure says so (source `measured`); a typed one is `assumed`.
 */
export function transferLine(
  traffic: EstimateTraffic | null | undefined,
  unitCentsPerGb: number,
  label = 'Data transfer out'
): CostLine | null {
  if (!traffic || !Number.isFinite(traffic.egressGbMonth) || traffic.egressGbMonth <= 0) return null
  return lineOf(
    label,
    Math.round(traffic.egressGbMonth * 1000) / 1000,
    'GB',
    unitCentsPerGb,
    traffic.source === 'measured' ? 'measured' : 'assumed',
    'transfer'
  )
}

// ── Tax and discounts ──

export interface EffectiveRates {
  /** 0–100; 0 with source 'none' = not known (tax not included). */
  taxPercent: number
  /** 0–100, a reduction (shown as a minus line). */
  discountPercent: number
  /** Where the tax rate came from. */
  source: 'bill' | 'admin' | 'none'
  /** How many billed months the learned rates are from (0 = none learned). */
  months: number
}

/** The cost feed's table (Task 34, migration 586); read only when it exists. */
export const PROVIDER_COSTS = 'nivaro_hub_provider_costs'

const ymd = (d: Date) => d.toISOString().slice(0, 10)

/** The tax percent an administrator set on the connection (`tax_percent`), or null. */
export function adminTaxPercent(config: Record<string, unknown> | null | undefined): number | null {
  const raw = config?.tax_percent
  if (raw == null || raw === '') return null
  const v = typeof raw === 'string' ? Number(raw) : raw
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100 ? v : null
}

interface BillSums {
  usage: number
  tax: number
  discount: number
  months: number
}

const TAX_KINDS = new Set(['tax'])
const DISCOUNT_KINDS = new Set(['credit', 'discount', 'refund'])

/** What a cost row is, from its record type (Task 34) or, failing that, its service name. */
function rowKind(recordType: unknown, service: unknown): 'usage' | 'tax' | 'discount' {
  const k = String(recordType ?? '')
    .trim()
    .toLowerCase()
  const s = String(service ?? '')
    .trim()
    .toLowerCase()
  if (TAX_KINDS.has(k) || (!k && s === 'tax')) return 'tax'
  if (DISCOUNT_KINDS.has(k) || (!k && DISCOUNT_KINDS.has(s))) return 'discount'
  return 'usage'
}

/** The last three whole billed months of one connection's cost feed (null when none). */
async function billSums(connectionId: number, now: Date): Promise<BillSums | null> {
  try {
    if (!(await db.schema.hasTable(PROVIDER_COSTS))) return null
    const hasType = await db.schema.hasColumn(PROVIDER_COSTS, 'record_type')
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, 1))
    const rows = (await db(PROVIDER_COSTS)
      .where('connection_id', connectionId)
      .where('date', '>=', ymd(from))
      .where('date', '<', ymd(monthStart))
      .select('date', 'service', 'amount_cents', ...(hasType ? ['record_type'] : []))) as Array<
      Record<string, unknown>
    >
    if (!rows.length) return null
    const out: BillSums = { usage: 0, tax: 0, discount: 0, months: 0 }
    const months = new Set<string>()
    for (const r of rows) {
      const amount = Number(r.amount_cents)
      if (!Number.isFinite(amount)) continue
      const d = r.date instanceof Date ? ymd(r.date) : String(r.date ?? '').slice(0, 10)
      if (d) months.add(d.slice(0, 7))
      const kind = rowKind(r.record_type, r.service)
      if (kind === 'tax') out.tax += amount
      else if (kind === 'discount') out.discount += -amount
      else out.usage += amount
    }
    out.months = months.size
    return out
  } catch {
    return null
  }
}

const pct = (part: number, whole: number) =>
  whole > 0 && part > 0 ? Math.min(100, Math.round((part / whole) * 10_000) / 100) : 0

/**
 * The tax and discount rates to put on a connection's estimates: learned from its bills when the
 * cost feed has them, else the administrator's tax rate, else none. Never throws.
 */
export async function effectiveRates(
  connectionId: number,
  opts: { now?: Date; config?: Record<string, unknown> | null } = {}
): Promise<EffectiveRates> {
  const now = opts.now ?? new Date()
  let config = opts.config ?? null
  if (config == null) {
    try {
      config = (await readConnection(connectionId))?.config ?? null
    } catch {
      config = null
    }
  }
  const bill = await billSums(connectionId, now)
  const admin = adminTaxPercent(config)
  const learnedTax = bill && bill.usage > 0 && bill.tax > 0 ? pct(bill.tax, bill.usage) : null
  const discountPercent = bill && bill.usage > 0 ? pct(bill.discount, bill.usage) : 0
  if (learnedTax != null)
    return { taxPercent: learnedTax, discountPercent, source: 'bill', months: bill?.months ?? 0 }
  if (admin != null)
    return { taxPercent: admin, discountPercent, source: 'admin', months: bill?.months ?? 0 }
  return { taxPercent: 0, discountPercent, source: 'none', months: bill?.months ?? 0 }
}

const NO_TAX_NOTE = 'Tax not included.'

/**
 * The estimate with the tax and discount lines laid on (never folded into a base line). Tax and
 * discount are taken from the base + transfer lines' monthly total; one-time and yearly amounts
 * are left as listed. An unknown or free estimate is answered unchanged (no lines to tax), apart
 * from the "tax not included" note.
 */
export function applyRates(est: CostEstimate, rates: EffectiveRates): CostEstimate {
  const priced = est.lines.filter((l) => l.kind === 'base' || l.kind === 'transfer')
  const base = priced.reduce((n, l) => n + l.monthlyCents, 0)
  const lines = est.lines.filter((l) => l.kind !== 'tax' && l.kind !== 'discount')
  const notes: string[] = est.note ? [est.note] : []
  if (est.confidence !== 'unknown' && base > 0) {
    if (rates.discountPercent > 0)
      lines.push({
        label: `Credits and discounts (${rates.discountPercent}% from the last ${rates.months} billed month${rates.months === 1 ? '' : 's'})`,
        qty: 1,
        unit: 'month',
        unitCents: -Math.round((base * rates.discountPercent) / 100),
        monthlyCents: -Math.round((base * rates.discountPercent) / 100),
        kind: 'discount',
        source: 'learned_from_bill'
      })
    const afterDiscount = base - Math.round((base * rates.discountPercent) / 100)
    if (rates.source !== 'none' && rates.taxPercent > 0) {
      const tax = Math.round((afterDiscount * rates.taxPercent) / 100)
      lines.push({
        label:
          rates.source === 'bill'
            ? `Tax (${rates.taxPercent}% as billed over the last ${rates.months} month${rates.months === 1 ? '' : 's'})`
            : `Tax (${rates.taxPercent}%, the rate set on this connection)`,
        qty: 1,
        unit: 'month',
        unitCents: tax,
        monthlyCents: tax,
        kind: 'tax',
        source: rates.source === 'bill' ? 'learned_from_bill' : 'admin_rate'
      })
    }
  }
  if (rates.source === 'none' && !notes.includes(NO_TAX_NOTE) && est.basis !== 'free')
    notes.push(NO_TAX_NOTE)
  const out: CostEstimate = {
    ...est,
    lines,
    monthlyCents: lines.reduce((n, l) => n + l.monthlyCents, 0)
  }
  if (est.confidence === 'unknown') out.monthlyCents = 0
  if (notes.length) out.note = notes.join(' ')
  else delete out.note
  return out
}

// ── Connection fields every provider takes ──

/**
 * The cost settings on every connection's form (beside the adapter's own fields): the tax rate
 * the Hub puts on its estimates while no bill has taught it one.
 */
export const COST_CONNECTION_FIELDS: ConnectionField[] = [
  {
    key: 'tax_percent',
    label: 'Tax rate on estimates (%)',
    kind: 'number',
    help: 'Used until the provider’s own bills show the rate. 0 = tax-exempt; empty = tax not included.'
  }
]

export const COST_CONNECTION_KEYS: ReadonlySet<string> = new Set(
  COST_CONNECTION_FIELDS.map((f) => f.key)
)

/** Problems with the cost fields of a connection's config (empty = fine). */
export function costConfigProblems(config: Record<string, unknown>): string[] {
  const raw = config.tax_percent
  if (raw === undefined || raw === null || raw === '') return []
  return adminTaxPercent(config) == null ? ['tax_percent is a number from 0 to 100.'] : []
}

// ── The guard rule ──

/**
 * Types that have a costClass but no estimate (the guard test's rule), minus the allow-list.
 * A type without a costClass costs nothing by contract.
 */
export function missingEstimates(
  adapters: readonly ProviderAdapter[],
  allow: ReadonlySet<string> = new Set()
): string[] {
  const out: string[] = []
  for (const a of adapters)
    for (const t of a.types)
      if (
        typeof t.costClass === 'function' &&
        typeof t.estimate !== 'function' &&
        !allow.has(t.key)
      )
        out.push(t.key)
  return out.sort()
}
