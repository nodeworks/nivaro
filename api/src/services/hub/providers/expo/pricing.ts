import { estimateOf, priceLookup, unknownEstimate } from '../pricing/index.js'
import type {
  BundledPriceTable,
  CostEstimate,
  DesiredResource,
  Observed,
  ProviderContext
} from '../types.js'
import { gql } from './client.js'
import { Q_ACCOUNT_PLAN } from './queries.js'

/**
 * Expo (EAS) cost estimates (Task 44b). EAS bills the ACCOUNT: a plan price a month (the plan also
 * carries a build-credit allowance) and, past that, per build by platform and worker size. So an
 * Expo project adds no fixed charge — a known zero with the account's plan and price in the note
 * (basis `plan_price`) — and a build is a one-time usage amount at the on-demand price for its
 * platform (medium worker, the default; the plan's included credit is used first, so the amount
 * is a ceiling). The plan is read from the account when Expo answers it; the prices are the dated
 * table below (EAS has no price API).
 */

export const EXPO_PRICES_AS_OF = '2026-11-26'

export const EXPO_BUNDLED: BundledPriceTable = {
  asOf: EXPO_PRICES_AS_OF,
  currency: 'USD',
  items: {
    'plan:starter': { unit: 'month', unitCents: 1900, label: 'Starter plan' },
    'plan:production': { unit: 'month', unitCents: 19900, label: 'Production plan' },
    'build:android:medium': {
      unit: 'build',
      unitCents: 100,
      label: 'Android build, medium worker'
    },
    'build:ios:medium': { unit: 'build', unitCents: 200, label: 'iOS build, medium worker' }
  }
}

const dollars = (cents: number) => `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`

/** The account's plan name, lower case ('free', 'starter', 'production', 'enterprise'); null = not readable. */
async function readPlan(ctx: ProviderContext): Promise<string | null> {
  try {
    const data = await gql<any>(ctx, Q_ACCOUNT_PLAN, { name: String(ctx.config.account ?? '') })
    const name = data?.account?.byName?.subscription?.name
    return typeof name === 'string' && name ? name.toLowerCase() : null
  } catch {
    return null
  }
}

async function planNote(ctx: ProviderContext, plan: string | null): Promise<string> {
  if (!plan) return "The account's plan could not be read."
  if (plan === 'free')
    return 'The account is on the Free plan, which has a monthly build allowance.'
  const p = await priceLookup(ctx, 'expo', `plan:${plan}`, null)
  return p
    ? `The account's ${plan} plan costs ${dollars(p.unitCents)} a month (list price) and includes build credit.`
    : `The account's plan is ${plan}; its price is set by contract.`
}

export async function expoProjectEstimate(
  ctx: ProviderContext,
  _desired: DesiredResource | null,
  _observed: Observed | null
): Promise<CostEstimate> {
  try {
    const plan = await readPlan(ctx)
    if (!plan) return unknownEstimate("The account's plan could not be read.")
    return estimateOf({
      basis: 'plan_price',
      confidence: 'exact',
      lines: [],
      priceAsOf: EXPO_PRICES_AS_OF,
      note: `Adds no fixed charge: ${await planNote(ctx, plan)} Builds are billed per build.`
    })
  } catch {
    return unknownEstimate('The price could not be worked out.')
  }
}

export async function expoBuildEstimate(
  ctx: ProviderContext,
  desired: DesiredResource | null,
  observed: Observed | null
): Promise<CostEstimate> {
  try {
    const platform = String(
      desired?.fields.platform ?? observed?.fields.platform ?? ''
    ).toLowerCase()
    if (platform !== 'ios' && platform !== 'android')
      return unknownEstimate('Pick a platform to see the price of a build.')
    const p = await priceLookup(ctx, 'expo', `build:${platform}:medium`, null)
    if (!p) return unknownEstimate(`No price is known for an ${platform} build.`)
    const plan = await readPlan(ctx)
    // A build that already ran has no price still to pay: "what it costs now" is nothing.
    const done = !desired && !!observed
    return estimateOf({
      basis: 'usage',
      confidence: plan ? 'list_price' : 'usage_varies',
      lines: [],
      oneTimeCents: done ? 0 : Math.round(p.unitCents),
      priceAsOf: p.asOf,
      note: done
        ? 'A build that ran is billed once, on the month it ran.'
        : `One ${platform === 'ios' ? 'iOS' : 'Android'} build on a medium worker at ${dollars(
            p.unitCents
          )} (on-demand list price); build credit included in the plan is used first. ${await planNote(ctx, plan)}`
    })
  } catch {
    return unknownEstimate('The price could not be worked out.')
  }
}
