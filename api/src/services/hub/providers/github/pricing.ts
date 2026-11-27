import { estimateOf, priceLookup, unknownEstimate } from '../pricing/index.js'
import type {
  BundledPriceTable,
  CostEstimate,
  DesiredResource,
  Observed,
  ProviderContext
} from '../types.js'
import { gh, ownerOf, seg } from './api.js'

/**
 * GitHub cost estimates (Task 44b). GitHub bills the ORGANISATION: a per-seat plan, plus Actions
 * minutes past what the plan includes for private repositories. So a repository adds no fixed
 * charge (a known zero, basis `plan_price`, with the plan read from `GET /orgs/{owner}` and its
 * seat price in the note), and a workflow is usage (basis `usage`): the per-minute price of a
 * Linux runner past the plan's included minutes, which the Hub cannot size before the runs happen.
 * Prices are the dated table below (GitHub has no price API). A personal account (no `/orgs`
 * answer) has no readable plan: the repository is "No estimate".
 */

export const GITHUB_PRICES_AS_OF = '2026-11-26'

/** Actions minutes included per month by plan (private repositories; public ones are free). */
export const INCLUDED_ACTIONS_MINUTES: Record<string, number> = {
  free: 2000,
  team: 3000,
  enterprise: 50000
}

export const GITHUB_BUNDLED: BundledPriceTable = {
  asOf: GITHUB_PRICES_AS_OF,
  currency: 'USD',
  items: {
    'plan:team:seat': { unit: 'seat-month', unitCents: 400, label: 'Team plan, per seat' },
    'plan:enterprise:seat': {
      unit: 'seat-month',
      unitCents: 2100,
      label: 'Enterprise plan, per seat'
    },
    'actions:linux:minute': { unit: 'minute', unitCents: 0.8, label: 'Linux runner minute' }
  }
}

interface OrgPlan {
  plan: string
  seats: number | null
}

async function readPlan(ctx: ProviderContext): Promise<OrgPlan | null> {
  try {
    const owner = ownerOf(ctx)
    if (!owner) return null
    const r = await gh<any>(ctx, 'GET', `/orgs/${seg(owner)}`, { ok: [403, 404] })
    if (r.status !== 200) return null
    const name = String(r.json?.plan?.name ?? '').toLowerCase()
    if (!name) return null
    const seats = r.json?.plan?.seats
    return {
      plan: name,
      seats: typeof seats === 'number' && Number.isFinite(seats) && seats > 0 ? seats : null
    }
  } catch {
    return null
  }
}

const dollars = (cents: number) => `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`

async function planNote(ctx: ProviderContext, p: OrgPlan): Promise<string> {
  if (p.plan === 'free') return "Covered by the organisation's Free plan."
  const seat = await priceLookup(ctx, 'github', `plan:${p.plan}:seat`, null)
  return seat
    ? `Covered by the organisation's ${p.plan} plan (${dollars(seat.unitCents)} per seat a month${
        p.seats ? `, ${p.seats} seats` : ''
      }; list price), billed to the organisation, not per repository.`
    : `Covered by the organisation's ${p.plan} plan, billed to the organisation.`
}

export async function githubRepositoryEstimate(
  ctx: ProviderContext,
  _desired: DesiredResource | null,
  _observed: Observed | null
): Promise<CostEstimate> {
  try {
    const plan = await readPlan(ctx)
    if (!plan) return unknownEstimate("The account's plan could not be read.")
    const seat =
      plan.plan === 'free' ? null : await priceLookup(ctx, 'github', `plan:${plan.plan}:seat`, null)
    return estimateOf({
      basis: 'plan_price',
      confidence: 'exact',
      lines: [],
      priceAsOf: seat?.asOf ?? GITHUB_PRICES_AS_OF,
      note: `Adds no fixed charge: ${await planNote(ctx, plan)}`
    })
  } catch {
    return unknownEstimate('The price could not be worked out.')
  }
}

export async function githubWorkflowEstimate(
  ctx: ProviderContext,
  _desired: DesiredResource | null,
  _observed: Observed | null
): Promise<CostEstimate> {
  try {
    const minute = await priceLookup(ctx, 'github', 'actions:linux:minute', null)
    if (!minute) return unknownEstimate('No Actions minute price is known.')
    const plan = await readPlan(ctx)
    const included = plan ? INCLUDED_ACTIONS_MINUTES[plan.plan] : undefined
    return estimateOf({
      basis: 'usage',
      confidence: 'usage_varies',
      lines: [],
      priceAsOf: minute.asOf,
      note: `Billed by use: Linux runner minutes at ${(minute.unitCents / 100).toFixed(3)} dollars a minute (list price) past ${
        included != null
          ? `the ${included.toLocaleString('en-US')} a month the plan includes`
          : 'the minutes the plan includes'
      } for private repositories; public repositories run free. Nothing is counted until runs happen.`
    })
  } catch {
    return unknownEstimate('The price could not be worked out.')
  }
}
