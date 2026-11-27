import { estimateOf, freeEstimate, lineOf, priceLookup, unknownEstimate } from '../pricing/index.js'
import type {
  BundledPriceTable,
  CostEstimate,
  DesiredResource,
  Observed,
  PriceAnswer,
  ProviderContext
} from '../types.js'
import { numSegment, rcCall } from './client.js'

/**
 * Redis Cloud cost estimates (Task 17). An Essentials (fixed) subscription bills the plan it is
 * on: the plan's price is read from `GET /fixed/plans/:id` (the price book's `priceApi`; sku key
 * `plan:<id>`), with a small dated table below as the fallback (the free plan only: other plan
 * prices change too often to copy). A Pro subscription bills by memory, throughput and region, not
 * by a plan: "No estimate" (adopt-only anyway). A database adds nothing to its subscription.
 */

export const RC_PRICES_AS_OF = '2026-11-26'

export const RC_BUNDLED: BundledPriceTable = {
  asOf: RC_PRICES_AS_OF,
  currency: 'USD',
  items: {
    'plan:free': { unit: 'month', unitCents: 0, label: 'Essentials free plan (30 MB)' }
  }
}

/** `priceApi`: one Essentials plan's monthly price from the provider. null = no price there. */
export async function redisCloudPlanPrice(
  ctx: ProviderContext,
  skuKey: string
): Promise<PriceAnswer | null> {
  const m = /^plan:(\d{1,12})$/.exec(skuKey)
  if (!m) return null
  const r = await rcCall(ctx, 'GET', `/fixed/plans/${numSegment(m[1])}`, { allow: [403, 404] })
  if (r.status !== 200) return null
  const price = Number(r.body?.price)
  const period = String(r.body?.pricePeriod ?? 'Month').toLowerCase()
  if (!Number.isFinite(price) || price < 0 || period !== 'month') return null
  return {
    unitCents: Math.round(price * 100),
    unit: 'month',
    currency: String(r.body?.priceCurrency ?? 'USD'),
    asOf: RC_PRICES_AS_OF
  }
}

const dollars = (cents: number) => `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`

export async function subscriptionEstimate(
  ctx: ProviderContext,
  desired: DesiredResource | null,
  observed: Observed | null
): Promise<CostEstimate> {
  try {
    if (observed && observed.fields.kind === 'pro')
      return unknownEstimate(
        'A Pro subscription bills by memory, throughput and region, not by a fixed plan.'
      )
    const planId = String(observed?.fields.planId ?? desired?.fields.planId ?? '')
    if (!/^\d{1,12}$/.test(planId)) return unknownEstimate('The subscription’s plan is not known.')
    const price = await priceLookup(ctx, 'redis-cloud', `plan:${planId}`, null)
    if (!price) return unknownEstimate('The plan’s price could not be read.')
    const name = String(observed?.fields.planName ?? `plan ${planId}`)
    if (price.unitCents === 0) return freeEstimate(`${name} is free.`)
    return estimateOf({
      basis: 'plan_price',
      confidence: 'exact',
      lines: [lineOf(`Essentials ${name}`, 1, 'month', price.unitCents, 'plan_price')],
      priceAsOf: price.asOf,
      note: `${name} is ${dollars(price.unitCents)} a month; every database on the subscription is covered by it.`
    })
  } catch {
    return unknownEstimate('The price could not be worked out.')
  }
}
