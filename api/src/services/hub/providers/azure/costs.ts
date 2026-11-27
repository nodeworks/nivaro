import type { CostRow, ProviderContext } from '../types.js'
import { ProviderError } from '../types.js'
import { API, armCall, armVersion, isArmUrl, subscriptionsOf } from './client.js'

/**
 * Azure Cost Management through the Query API (`Microsoft.CostManagement/query`), one subscription
 * at a time. The Query API accepts at most two groupings, so two queries are made:
 *
 *  1. actual cost per day grouped by ResourceId and ChargeType: the rows, with `recordType` from
 *     the charge type;
 *  2. cost grouped by ResourceId and the tag `nivaro-hub-app`: only a resource id → app tag map,
 *     laid on the rows of the first (a resource carries one value of the tag).
 *
 * Amounts are in the billing currency, in cents; credits and refunds are negative. Never throws
 * for a subscription the app registration cannot read costs of (403): that subscription simply
 * has no rows (the connection test says it is missing Cost Management Reader).
 */

export const APP_TAG_KEY = 'nivaro-hub-app'

type Column = { name?: string; type?: string }

function columnIndex(columns: Column[], ...names: string[]): number {
  const lower = names.map((n) => n.toLowerCase())
  return columns.findIndex((c) => lower.includes(String(c.name ?? '').toLowerCase()))
}

/** A Cost Management date (20261105 or an ISO string) → YYYY-MM-DD. */
export function costDate(v: unknown): string | null {
  const s = String(v ?? '')
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)
  return null
}

/** What Azure's charge type says about the row. */
export function recordTypeOf(
  chargeType: unknown,
  amount: number
): NonNullable<CostRow['recordType']> {
  const t = String(chargeType ?? '').toLowerCase()
  if (t.includes('tax')) return 'tax'
  if (t.includes('refund')) return 'refund'
  if (t.includes('credit')) return 'credit'
  if (t.includes('discount')) return 'discount'
  return amount < 0 ? 'credit' : 'usage'
}

const rangeOk = (r: { from: string; to: string }) =>
  /^\d{4}-\d{2}-\d{2}$/.test(r.from) && /^\d{4}-\d{2}-\d{2}$/.test(r.to) && r.from <= r.to

async function query(
  ctx: ProviderContext,
  sub: string,
  body: unknown
): Promise<{ columns: Column[]; rows: unknown[][] } | null> {
  const path = `/subscriptions/${sub}/providers/Microsoft.CostManagement/query`
  let res = await armCall(ctx, 'POST', path, {
    query: armVersion(API.cost),
    body,
    allow: [403, 404]
  })
  if (res.status !== 200) return null
  const columns: Column[] = Array.isArray(res.body?.properties?.columns)
    ? res.body.properties.columns
    : []
  const rows: unknown[][] = []
  for (let page = 0; page < 20; page++) {
    if (Array.isArray(res.body?.properties?.rows)) rows.push(...res.body.properties.rows)
    const next = res.body?.properties?.nextLink
    if (typeof next !== 'string' || !isArmUrl(next)) break
    // A next link is the same query again at another offset.
    const u = new URL(next)
    res = await armCall(ctx, 'POST', u.pathname, {
      query: Object.fromEntries(u.searchParams.entries()),
      body,
      allow: [403, 404]
    })
    if (res.status !== 200) break
  }
  return { columns, rows }
}

const period = (range: { from: string; to: string }) => ({
  from: `${range.from}T00:00:00Z`,
  to: `${range.to}T23:59:59Z`
})

async function appTags(
  ctx: ProviderContext,
  sub: string,
  range: { from: string; to: string }
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const q = await query(ctx, sub, {
    type: 'ActualCost',
    timeframe: 'Custom',
    timePeriod: period(range),
    dataset: {
      granularity: 'None',
      aggregation: { totalCost: { name: 'Cost', function: 'Sum' } },
      grouping: [
        { type: 'Dimension', name: 'ResourceId' },
        { type: 'TagKey', name: APP_TAG_KEY }
      ]
    }
  })
  if (!q) return out
  const rid = columnIndex(q.columns, 'ResourceId')
  const val = columnIndex(q.columns, 'TagValue', APP_TAG_KEY)
  if (rid < 0 || val < 0) return out
  for (const row of q.rows) {
    const id = String(row[rid] ?? '').toLowerCase()
    let tag = String(row[val] ?? '')
    // Some answers carry `key$value`.
    if (tag.toLowerCase().startsWith(`${APP_TAG_KEY}$`)) tag = tag.slice(APP_TAG_KEY.length + 1)
    if (id && tag && !out.has(id)) out.set(id, tag)
  }
  return out
}

/** The cost rows of `range` (inclusive days, UTC) across every subscription of the connection. */
export async function azureCosts(
  ctx: ProviderContext,
  range: { from: string; to: string }
): Promise<CostRow[]> {
  if (!rangeOk(range))
    throw new ProviderError('INVALID', 'The cost range must be two days, YYYY-MM-DD.')
  const out: CostRow[] = []
  for (const sub of subscriptionsOf(ctx.config)) {
    const q = await query(ctx, sub, {
      type: 'ActualCost',
      timeframe: 'Custom',
      timePeriod: period(range),
      dataset: {
        granularity: 'Daily',
        aggregation: { totalCost: { name: 'Cost', function: 'Sum' } },
        grouping: [
          { type: 'Dimension', name: 'ResourceId' },
          { type: 'Dimension', name: 'ChargeType' }
        ]
      }
    })
    if (!q || !q.rows.length) continue
    const tags = await appTags(ctx, sub, range)
    const cost = columnIndex(q.columns, 'Cost', 'PreTaxCost', 'CostUSD')
    const day = columnIndex(q.columns, 'UsageDate', 'BillingMonth')
    const rid = columnIndex(q.columns, 'ResourceId')
    const charge = columnIndex(q.columns, 'ChargeType')
    const cur = columnIndex(q.columns, 'Currency')
    if (cost < 0 || day < 0) continue
    for (const row of q.rows) {
      const amount = Number(row[cost])
      const date = costDate(row[day])
      if (!Number.isFinite(amount) || !date) continue
      const cents = Math.round(Number((amount * 100).toFixed(4)))
      if (cents === 0) continue
      const externalId = rid >= 0 ? String(row[rid] ?? '') : ''
      const appTag = externalId ? tags.get(externalId.toLowerCase()) : undefined
      const currency = (cur >= 0 && row[cur] ? String(row[cur]) : 'USD').toUpperCase()
      out.push({
        date,
        amountCents: cents,
        currency,
        ...(externalId ? { externalId } : {}),
        ...(appTag ? { appTag } : {}),
        recordType: recordTypeOf(charge >= 0 ? row[charge] : null, cents)
      })
    }
  }
  return out
}
