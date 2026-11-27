import {
  estimateOf,
  type PriceLookupAnswer,
  priceLookup,
  unknownEstimate
} from '../pricing/index.js'
import type {
  BundledPriceTable,
  CostEstimate,
  DesiredResource,
  Observed,
  ProviderContext
} from '../types.js'
import { glCall, isGitlabCom, pathSeg, pinOf } from './client.js'

/**
 * GitLab cost estimates (Task 18). GitLab bills the top-level GROUP (namespace), not each
 * project, token or variable: on gitlab.com a plan with a price per seat, on a self-managed
 * install a licence by contract. So every GitLab resource adds nothing to the fixed bill; its
 * estimate is a known zero with the namespace's plan and list price in the note (basis
 * `plan_price`). Hosted runner minutes past the plan's quota are usage the Hub cannot size.
 *
 * The plan is read from the pinned group's namespace (`GET /namespaces/:path`, `plan`); the
 * prices are the dated table below (GitLab has no price API). A group whose plan cannot be read
 * is "No estimate".
 */

export const GITLAB_PRICES_AS_OF = '2026-11-26'

export const GITLAB_BUNDLED: BundledPriceTable = {
  asOf: GITLAB_PRICES_AS_OF,
  currency: 'USD',
  items: {
    'plan:premium:seat': { unit: 'seat-month', unitCents: 2900, label: 'Premium, per seat' },
    'plan:ultimate:seat': { unit: 'seat-month', unitCents: 9900, label: 'Ultimate, per seat' },
    'plan:free': { unit: 'month', unitCents: 0, label: 'Free' }
  }
}

export type GitlabKind = 'group' | 'project' | 'config' | 'token' | 'runner'

interface NamespacePlan {
  plan: string
  seats: number | null
}

async function readPlan(ctx: ProviderContext): Promise<NamespacePlan | null> {
  try {
    const r = await glCall(ctx, 'GET', `/namespaces/${pathSeg(pinOf(ctx), 'group path')}`, {
      allow: [403, 404]
    })
    if (r.status !== 200) return null
    const plan = String(r.body?.plan ?? '').toLowerCase()
    if (!plan) return null
    const n = r.body?.billable_members_count
    return { plan, seats: typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null }
  } catch {
    return null
  }
}

const dollars = (cents: number) => `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`

function planNote(
  plan: NamespacePlan,
  seat: PriceLookupAnswer | null,
  kind: GitlabKind,
  com: boolean
): string {
  const what = kind === 'group' ? 'group' : 'resource'
  const bits: string[] = []
  if (!com)
    bits.push(`Self-managed GitLab: the licence is by contract and is not billed per ${what}.`)
  else if (plan.plan === 'free' || plan.plan === 'default')
    bits.push("Covered by the group's Free plan (no charge).")
  else if (seat)
    bits.push(
      `Covered by the group's ${plan.plan} plan (${dollars(seat.unitCents)} per seat a month${
        plan.seats ? `, ${plan.seats} seats` : ''
      }), which is billed to the group, not per ${what}.`
    )
  else bits.push(`Covered by the group's ${plan.plan} plan, billed per seat to the group.`)
  if (kind === 'runner')
    bits.push(
      'A self-hosted runner costs what its own machine costs; hosted runner minutes past the plan quota are usage.'
    )
  return bits.join(' ')
}

export function gitlabEstimate(kind: GitlabKind) {
  return async function estimate(
    ctx: ProviderContext,
    _desired: DesiredResource | null,
    _observed: Observed | null
  ): Promise<CostEstimate> {
    try {
      const com = isGitlabCom(ctx.config)
      const plan = await readPlan(ctx)
      if (!plan) return unknownEstimate("The group's plan could not be read.")
      const sku = plan.plan === 'premium' || plan.plan === 'ultimate' ? plan.plan : null
      const seat = com && sku ? await priceLookup(ctx, 'gitlab', `plan:${sku}:seat`, null) : null
      const paid = com && !!sku
      return estimateOf({
        basis: 'plan_price',
        confidence: kind === 'runner' ? 'usage_varies' : paid ? 'list_price' : 'exact',
        lines: [],
        priceAsOf: seat?.asOf ?? GITLAB_PRICES_AS_OF,
        note: planNote(plan, seat, kind, com)
      })
    } catch {
      return unknownEstimate('The price could not be worked out.')
    }
  }
}
