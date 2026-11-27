import {
  estimateOf,
  lineOf,
  type PriceLookupAnswer,
  priceLookup,
  unknownEstimate
} from '../pricing/index.js'
import type {
  BundledPriceTable,
  CostEstimate,
  CostLine,
  DesiredResource,
  Observed,
  ProviderContext
} from '../types.js'
import { teamIdOf, vercelCall } from './client.js'

/**
 * Vercel cost estimates (Task 44b). Vercel bills the TEAM, not each project: a plan with a price
 * per seat, plus usage past what the plan includes. So a project, variable, domain or deployment
 * adds nothing to the fixed bill; its estimate is a known zero with the team's plan and price in
 * the note (basis `plan_price`), and the one usage extra the Hub can size from what a person
 * enters — data transfer past the plan's allowance — as a `transfer` line on a project.
 *
 * The plan is read from the team (`billing.plan`); the prices are the dated table below (Vercel
 * has no price API). A team whose plan cannot be read is "No estimate".
 */

export const VERCEL_PRICES_AS_OF = '2026-11-26'

/** Fast data transfer included per month for the whole team (GB). Hobby cannot buy more. */
export const INCLUDED_TRANSFER_GB: Record<string, number> = { hobby: 100, pro: 1000 }

export const VERCEL_BUNDLED: BundledPriceTable = {
  asOf: VERCEL_PRICES_AS_OF,
  currency: 'USD',
  items: {
    'plan:pro:seat': { unit: 'seat-month', unitCents: 2000, label: 'Pro plan, per seat' },
    'plan:hobby': { unit: 'month', unitCents: 0, label: 'Hobby plan (personal use)' },
    'transfer:overage': { unit: 'GB', unitCents: 15, label: 'Data transfer past the allowance' }
  }
}

export type VercelKind = 'project' | 'env_var' | 'domain' | 'deployment'

interface TeamPlan {
  plan: string
  seats: number | null
}

async function readPlan(ctx: ProviderContext): Promise<TeamPlan | null> {
  try {
    const r = await vercelCall(ctx, 'GET', `/v2/teams/${encodeURIComponent(teamIdOf(ctx))}`, {
      allow: [403, 404]
    })
    if (r.status !== 200) return null
    const plan = String(r.body?.billing?.plan ?? '').toLowerCase()
    if (!plan) return null
    const seatsRaw = r.body?.billing?.seats ?? r.body?.membersCount
    const seats =
      typeof seatsRaw === 'number' && Number.isFinite(seatsRaw) && seatsRaw > 0 ? seatsRaw : null
    return { plan, seats }
  } catch {
    return null
  }
}

const dollars = (cents: number) => `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`

function planNote(plan: TeamPlan, seat: PriceLookupAnswer | null, kind: VercelKind): string {
  const bits: string[] = []
  if (plan.plan === 'pro')
    bits.push(
      seat
        ? `Covered by the team's Pro plan (${dollars(seat.unitCents)} per seat a month${plan.seats ? `, ${plan.seats} seats` : ''}), which is billed to the team, not per ${kind === 'project' ? 'project' : 'resource'}.`
        : "Covered by the team's Pro plan, billed per seat to the team."
    )
  else if (plan.plan === 'hobby')
    bits.push("Covered by the team's Hobby plan (free; personal, non-commercial use).")
  else if (plan.plan === 'enterprise')
    bits.push("Covered by the team's Enterprise contract (its price is set by contract).")
  else bits.push(`Covered by the team's ${plan.plan} plan.`)
  if (kind === 'deployment')
    bits.push('Builds past the plan’s concurrent build limit or build minutes are usage.')
  return bits.join(' ')
}

export function vercelEstimate(kind: VercelKind) {
  return async function estimate(
    ctx: ProviderContext,
    _desired: DesiredResource | null,
    _observed: Observed | null
  ): Promise<CostEstimate> {
    try {
      const plan = await readPlan(ctx)
      if (!plan) return unknownEstimate("The team's plan could not be read.")
      const seat =
        plan.plan === 'pro' ? await priceLookup(ctx, 'vercel', 'plan:pro:seat', null) : null
      const lines: CostLine[] = []
      const traffic = ctx.traffic
      let extra = ''
      if (kind === 'project' && traffic && traffic.egressGbMonth > 0) {
        const allowance = INCLUDED_TRANSFER_GB[plan.plan]
        if (allowance != null) {
          const over = Math.max(0, traffic.egressGbMonth - allowance)
          const rate = await priceLookup(ctx, 'vercel', 'transfer:overage', null)
          if (over > 0 && plan.plan === 'pro' && rate)
            lines.push(
              lineOf(
                'Data transfer past the included 1 TB',
                Math.round(over * 1000) / 1000,
                'GB',
                rate.unitCents,
                traffic.source === 'measured' ? 'measured' : 'assumed',
                'transfer'
              )
            )
          else if (over > 0 && plan.plan === 'hobby')
            extra = ' This traffic is past the Hobby allowance, which cannot be bought up.'
          else extra = ` The ${allowance} GB the plan includes is shared by the whole team.`
        }
      }
      return estimateOf({
        basis: 'plan_price',
        confidence: lines.length ? 'usage_varies' : 'exact',
        lines,
        priceAsOf: seat?.asOf ?? VERCEL_PRICES_AS_OF,
        note: `${planNote(plan, seat, kind)}${extra}`.trim()
      })
    } catch {
      return unknownEstimate('The price could not be worked out.')
    }
  }
}
