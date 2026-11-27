import { estimateOf, priceLookup, unknownEstimate } from '../pricing/index.js'
import type {
  BundledPriceTable,
  CostEstimate,
  DesiredResource,
  Observed,
  ProviderContext
} from '../types.js'

/**
 * Auth0 cost estimates (Task 44b). Auth0 bills the TENANT by monthly active users on its plan, not
 * per application, API or connection, and its Management API does not say which plan a tenant is
 * on. So each Auth0 type adds no fixed charge: a known zero (basis `plan_price`) with the plans'
 * starting prices from the dated table below in the note. What a tenant really pays arrives with
 * its bills (the cost feed), not from a guess here.
 */

export const AUTH0_PRICES_AS_OF = '2026-11-26'

export const AUTH0_BUNDLED: BundledPriceTable = {
  asOf: AUTH0_PRICES_AS_OF,
  currency: 'USD',
  items: {
    'plan:free': { unit: 'month', unitCents: 0, label: 'Free, up to 25,000 active users' },
    'plan:essentials': {
      unit: 'month',
      unitCents: 3500,
      label: 'Essentials, from 500 active users'
    },
    'plan:professional': {
      unit: 'month',
      unitCents: 24000,
      label: 'Professional, from 500 active users'
    }
  }
}

const dollars = (cents: number) => `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`

export async function auth0Estimate(
  ctx: ProviderContext,
  _desired: DesiredResource | null,
  _observed: Observed | null
): Promise<CostEstimate> {
  try {
    const [free, essentials, pro] = await Promise.all([
      priceLookup(ctx, 'auth0', 'plan:free', null),
      priceLookup(ctx, 'auth0', 'plan:essentials', null),
      priceLookup(ctx, 'auth0', 'plan:professional', null)
    ])
    if (!essentials || !pro) return unknownEstimate('No Auth0 plan prices are known.')
    return estimateOf({
      basis: 'plan_price',
      confidence: 'list_price',
      lines: [],
      priceAsOf: essentials.asOf,
      note: `Adds no fixed charge: Auth0 bills the tenant by active users on its plan (${
        free ? 'Free to 25,000 users, ' : ''
      }Essentials from ${dollars(essentials.unitCents)} a month, Professional from ${dollars(
        pro.unitCents
      )} a month; list prices). The Hub cannot read the tenant's plan.`
    })
  } catch {
    return unknownEstimate('The price could not be worked out.')
  }
}
