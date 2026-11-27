import { estimateOf, lineOf, priceLookup, unknownEstimate } from '../pricing/index.js'
import type {
  BundledPriceTable,
  CostEstimate,
  DesiredResource,
  Observed,
  ProviderContext
} from '../types.js'

/**
 * Cloudflare cost estimates (Task 44b contract). Cloudflare has no price API, so the figures come
 * from the dated table below (copied from the public pricing pages). What bills, and so what a
 * type's estimate says:
 *
 *  - zone                  the ZONE's plan (Free $0, Pro, Business; Enterprise is by contract).
 *  - dns record, tunnel, tunnel route, WAF custom rule, Worker secret   included, a known zero.
 *  - Access app / policy   Zero Trust: free up to 50 users, then a per-user price (account-wide).
 *  - Worker route          routes are free; the account's Workers Paid plan is billed per account.
 *  - R2 bucket             usage: storage past a free allowance and operations; data out is free.
 *
 * A missing price is "No estimate", never an error.
 */

export const CLOUDFLARE_PRICES_AS_OF = '2026-11-26'

export const CLOUDFLARE_BUNDLED: BundledPriceTable = {
  asOf: CLOUDFLARE_PRICES_AS_OF,
  currency: 'USD',
  items: {
    'zone:free': { unit: 'month', unitCents: 0, label: 'Free plan' },
    'zone:pro': { unit: 'month', unitCents: 2500, label: 'Pro plan, billed monthly' },
    'zone:business': { unit: 'month', unitCents: 25000, label: 'Business plan, billed monthly' },
    'zerotrust:seat': {
      unit: 'user-month',
      unitCents: 700,
      label: 'Zero Trust, per user past the free 50'
    },
    'workers:paid': { unit: 'month', unitCents: 500, label: 'Workers Paid plan, per account' },
    'r2:storage': { unit: 'GB-month', unitCents: 1.5, label: 'R2 Standard storage' },
    'r2:class_a': { unit: 'million ops', unitCents: 450, label: 'R2 Class A operations' },
    'r2:class_b': { unit: 'million ops', unitCents: 36, label: 'R2 Class B operations' },
    // Task 43: Cloudflare Registrar sells at cost (registry + ICANN fee); copied 2026-11-27.
    'domain:renew:com': { unit: 'year', unitCents: 1046, label: '.com renewal (at cost)' },
    'domain:renew:net': { unit: 'year', unitCents: 1250, label: '.net renewal (at cost)' },
    'domain:renew:org': { unit: 'year', unitCents: 1050, label: '.org renewal (at cost)' },
    'domain:renew:dev': { unit: 'year', unitCents: 1250, label: '.dev renewal (at cost)' },
    'domain:renew:app': { unit: 'year', unitCents: 1450, label: '.app renewal (at cost)' },
    'domain:renew:io': { unit: 'year', unitCents: 5000, label: '.io renewal (at cost)' }
  }
}

export const R2_FREE_GB = 10

const dollars = (cents: number) => `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`

type Est = (
  ctx: ProviderContext,
  desired: DesiredResource | null,
  observed: Observed | null
) => Promise<CostEstimate>

/** A type that is included in every plan: a known zero with a sentence saying why. */
export function includedEstimate(note: string): Est {
  return async () =>
    estimateOf({
      basis: 'free',
      confidence: 'exact',
      lines: [],
      priceAsOf: CLOUDFLARE_PRICES_AS_OF,
      note
    })
}

/** The zone's own plan. The plan name is read from the zone ("Free Website", "Pro Website"). */
export const zoneEstimate: Est = async (ctx, desired, observed) => {
  try {
    const plan = String(observed?.fields.plan ?? desired?.fields.plan ?? '').toLowerCase()
    if (!plan) return unknownEstimate('The zone’s plan could not be read.')
    if (plan.includes('free'))
      return estimateOf({
        basis: 'plan_price',
        confidence: 'exact',
        lines: [],
        priceAsOf: CLOUDFLARE_PRICES_AS_OF,
        note: 'The zone is on the Free plan.'
      })
    const sku = plan.includes('business')
      ? 'zone:business'
      : plan.includes('pro')
        ? 'zone:pro'
        : null
    if (!sku)
      return unknownEstimate(
        'This plan (Enterprise or a custom plan) is priced by contract, not by list price.'
      )
    const price = await priceLookup(ctx, 'cloudflare', sku, null)
    if (!price) return unknownEstimate('No Cloudflare plan price is known.')
    return estimateOf({
      basis: 'plan_price',
      confidence: 'list_price',
      lines: [
        lineOf(
          `${sku === 'zone:pro' ? 'Pro' : 'Business'} plan`,
          1,
          'month',
          price.unitCents,
          'plan_price'
        )
      ],
      priceAsOf: price.asOf,
      note: 'List price billed monthly; annual billing is cheaper.'
    })
  } catch {
    return unknownEstimate('The price could not be worked out.')
  }
}

/** Zero Trust (Access): per-user billing for the whole account, free up to 50 users. */
export const zeroTrustEstimate: Est = async (ctx) => {
  try {
    const price = await priceLookup(ctx, 'cloudflare', 'zerotrust:seat', null)
    if (!price) return unknownEstimate('No Zero Trust price is known.')
    return estimateOf({
      basis: 'plan_price',
      confidence: 'list_price',
      lines: [],
      priceAsOf: price.asOf,
      note: `Adds no fixed charge: Zero Trust is free up to 50 users, then ${dollars(price.unitCents)} per user a month for the whole account (list price).`
    })
  } catch {
    return unknownEstimate('The price could not be worked out.')
  }
}

/** A Worker route: free by itself; the account's Workers plan is what bills. */
export const workerRouteEstimate: Est = async (ctx) => {
  try {
    const price = await priceLookup(ctx, 'cloudflare', 'workers:paid', null)
    if (!price) return unknownEstimate('No Workers price is known.')
    return estimateOf({
      basis: 'plan_price',
      confidence: 'list_price',
      lines: [],
      priceAsOf: price.asOf,
      note: `Adds no fixed charge: routes are free. The Worker they call is billed to the account (Workers Paid ${dollars(price.unitCents)} a month per account, list price; the Free plan covers small use).`
    })
  } catch {
    return unknownEstimate('The price could not be worked out.')
  }
}

/** R2: no fixed price; storage past the free allowance and operations. Data out is free. */
export const r2Estimate: Est = async (ctx) => {
  try {
    const [storage, a, b] = await Promise.all([
      priceLookup(ctx, 'cloudflare', 'r2:storage', null),
      priceLookup(ctx, 'cloudflare', 'r2:class_a', null),
      priceLookup(ctx, 'cloudflare', 'r2:class_b', null)
    ])
    if (!storage) return unknownEstimate('No R2 price is known.')
    return estimateOf({
      basis: 'usage',
      confidence: 'usage_varies',
      lines: [
        lineOf(
          `Storage past the free ${R2_FREE_GB} GB`,
          0,
          'GB-month',
          storage.unitCents,
          'price_list'
        )
      ],
      priceAsOf: storage.asOf,
      note: `No fixed charge, plus usage: $${(storage.unitCents / 100).toFixed(3)} per GB-month past ${R2_FREE_GB} GB free${
        a && b
          ? `, ${dollars(a.unitCents)} per million writes and ${dollars(b.unitCents)} per million reads`
          : ''
      }. Data out (egress) is free.`
    })
  } catch {
    return unknownEstimate('The price could not be worked out.')
  }
}
