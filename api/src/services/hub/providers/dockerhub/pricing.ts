import { estimateOf, priceLookup, unknownEstimate } from '../pricing/index.js'
import type {
  BundledPriceTable,
  CostEstimate,
  DesiredResource,
  Observed,
  ProviderContext
} from '../types.js'
import { dhCall, namespaceOf, seg } from './api.js'

/**
 * Docker Hub cost estimates (Task 20). Docker bills the ACCOUNT's plan per seat, not each
 * repository: a public repository is free, and one private repository is included in the free
 * plan. Past that a private repository needs a paid plan (Pro for a person, Team for an
 * organisation), whose price the Hub cannot read, so the estimate names it (dated list price,
 * basis `plan_price`) without adding it as a charge of this repository.
 */

export const DOCKERHUB_PRICES_AS_OF = '2026-11-26'

export const DOCKERHUB_BUNDLED: BundledPriceTable = {
  asOf: DOCKERHUB_PRICES_AS_OF,
  currency: 'USD',
  items: {
    'plan:pro:seat': { unit: 'seat-month', unitCents: 1100, label: 'Pro plan, per user (monthly)' },
    'plan:team:seat': {
      unit: 'seat-month',
      unitCents: 1600,
      label: 'Team plan, per user (monthly)'
    }
  }
}

const dollars = (cents: number) => `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`

/** How many OTHER private repositories the namespace has (the free plan includes one). */
async function otherPrivateRepos(
  ctx: ProviderContext,
  self: string | null
): Promise<number | null> {
  try {
    const r = await dhCall(ctx, 'GET', `/v2/namespaces/${seg(namespaceOf(ctx))}/repositories`, {
      query: { page_size: 100 },
      allow: [403, 404]
    })
    if (r.status !== 200) return null
    return (r.body?.results ?? []).filter(
      (x: any) => x?.is_private === true && String(x?.name ?? '') !== self
    ).length
  } catch {
    return null
  }
}

export async function repositoryEstimate(
  ctx: ProviderContext,
  desired: DesiredResource | null,
  observed: Observed | null
): Promise<CostEstimate> {
  try {
    const isPrivate =
      desired != null ? desired.fields.private !== false : observed?.fields.private !== false
    if (!isPrivate)
      return estimateOf({
        basis: 'free',
        confidence: 'exact',
        lines: [],
        priceAsOf: DOCKERHUB_PRICES_AS_OF,
        note: 'Public repositories are free.'
      })
    const self = String(desired?.fields.name ?? observed?.fields.name ?? '') || null
    const others = await otherPrivateRepos(ctx, self)
    if (others == null) return unknownEstimate('The private repositories could not be counted.')
    const pro = await priceLookup(ctx, 'dockerhub', 'plan:pro:seat', null)
    const team = await priceLookup(ctx, 'dockerhub', 'plan:team:seat', null)
    if (others === 0)
      return estimateOf({
        basis: 'plan_price',
        confidence: 'list_price',
        lines: [],
        priceAsOf: pro?.asOf ?? DOCKERHUB_PRICES_AS_OF,
        note: 'The free plan includes one private repository; this would be the only one.'
      })
    const proText = pro ? `Pro is ${dollars(pro.unitCents)} per user a month` : 'Pro is a paid plan'
    const teamText = team
      ? `Team is ${dollars(team.unitCents)} per user a month`
      : 'Team is a paid plan'
    return estimateOf({
      basis: 'plan_price',
      confidence: 'list_price',
      lines: [],
      priceAsOf: pro?.asOf ?? DOCKERHUB_PRICES_AS_OF,
      note: `Docker bills the account plan, not each repository. More than one private repository needs a paid plan (${proText}; ${teamText}, list prices); nothing is added here if the account already has one.`
    })
  } catch {
    return unknownEstimate('The price could not be worked out.')
  }
}
