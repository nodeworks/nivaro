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
import { neonCall, orgIdOf, seg } from './client.js'

/**
 * Neon cost estimates (Task 16). Neon bills the ORGANISATION on a plan with usage prices: compute
 * by CU-hour (only while a compute runs), storage by GB-month, and a small monthly minimum on the
 * paid plans. So a project's base figure is its storage (when the Hub has read it) and the rest
 * is usage; an endpoint that never suspends is a known figure at its minimum size, one that
 * autosuspends is usage with the always-on figure in the note. The plan comes from the project's
 * owner (`owner.subscription_type`); the prices are the dated table below (Neon has no price API).
 * A plan that cannot be read is "No estimate".
 */

export const NEON_PRICES_AS_OF = '2026-11-26'

const HOURS_PER_MONTH = 730

export const NEON_BUNDLED: BundledPriceTable = {
  asOf: NEON_PRICES_AS_OF,
  currency: 'USD',
  items: {
    'compute:launch': { unit: 'CU-hour', unitCents: 10.6, label: 'Launch plan compute' },
    'compute:scale': { unit: 'CU-hour', unitCents: 22.2, label: 'Scale plan compute' },
    'storage:gb-month': { unit: 'GB-month', unitCents: 35, label: 'Storage' },
    'plan:minimum': { unit: 'month', unitCents: 500, label: 'Monthly minimum on a paid plan' }
  }
}

export type NeonKind = 'project' | 'endpoint'
export type NeonPlan = 'free' | 'launch' | 'scale' | 'enterprise' | 'other'

/** Neon's subscription type words (old and new) → the plan whose prices apply. */
export function planFromSubscription(raw: unknown): NeonPlan | null {
  const s = String(raw ?? '').toLowerCase()
  if (!s) return null
  if (s.includes('free')) return 'free'
  if (s.includes('launch') || s === 'pro' || s.startsWith('pro_') || s.includes('legacy_pro'))
    return 'launch'
  if (s.includes('scale') || s.includes('business')) return 'scale'
  if (s.includes('enterprise') || s.includes('custom')) return 'enterprise'
  return 'other'
}

/** The plan of the organisation, read from a project's owner (or the first project listed). */
async function readPlan(ctx: ProviderContext, projectId: string | null): Promise<NeonPlan | null> {
  try {
    if (projectId) {
      const r = await neonCall(ctx, 'GET', `/projects/${seg(projectId)}`, { allow: [403, 404] })
      if (r.status === 200) return planFromSubscription(r.body?.project?.owner?.subscription_type)
    }
    const r = await neonCall(ctx, 'GET', '/projects', {
      query: { org_id: orgIdOf(ctx), limit: 1 },
      allow: [403, 404]
    })
    if (r.status !== 200) return null
    return planFromSubscription(r.body?.projects?.[0]?.owner?.subscription_type)
  } catch {
    return null
  }
}

/** 10.6 → "$0.106", 35 → "$0.35", 500 → "$5.00". */
const dollars = (cents: number) => `$${(cents / 100).toFixed(3).replace(/0$/, '')}`

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

function projectOf(desired: DesiredResource | null, observed: Observed | null): string | null {
  const ref = desired?.refs?.project
  if (typeof ref === 'string' && ref) return ref
  const have = observed?.fields?.project
  if (typeof have === 'string' && have) return have
  return observed?.type === 'neon.project' ? observed.externalId : (desired?.externalId ?? null)
}

export function neonEstimate(kind: NeonKind) {
  return async function estimate(
    ctx: ProviderContext,
    desired: DesiredResource | null,
    observed: Observed | null
  ): Promise<CostEstimate> {
    try {
      const plan = await readPlan(ctx, projectOf(desired, observed))
      if (!plan) return unknownEstimate("The organisation's plan could not be read.")
      if (plan === 'free')
        return estimateOf({
          basis: 'plan_price',
          confidence: 'exact',
          lines: [],
          priceAsOf: NEON_PRICES_AS_OF,
          note: 'On the Free plan: no charge, within its compute and storage allowance.'
        })
      if (plan === 'enterprise' || plan === 'other')
        return unknownEstimate("The organisation's plan is priced by contract.")

      const compute: PriceLookupAnswer | null = await priceLookup(
        ctx,
        'neon',
        `compute:${plan}`,
        null
      )
      const storage = await priceLookup(ctx, 'neon', 'storage:gb-month', null)
      const minimum = await priceLookup(ctx, 'neon', 'plan:minimum', null)
      if (!compute || !storage) return unknownEstimate('No Neon price was found.')
      const asOf = compute.asOf ?? NEON_PRICES_AS_OF
      const usage = `Plus usage: ${dollars(compute.unitCents)} per CU-hour while a compute runs and ${dollars(storage.unitCents)} per GB-month stored${minimum ? `; the paid plan has a ${dollars(minimum.unitCents)} monthly minimum` : ''}.`

      const lines: CostLine[] = []
      if (kind === 'project') {
        const gb = num(observed?.fields?.storageGb)
        if (gb && gb > 0)
          lines.push(
            lineOf(
              'Storage',
              Math.round(gb * 1000) / 1000,
              'GB-month',
              storage.unitCents,
              'price_list'
            )
          )
        return estimateOf({
          basis: 'usage',
          confidence: 'usage_varies',
          lines,
          priceAsOf: asOf,
          note: usage
        })
      }

      // An endpoint: compute by CU-hour at the size it runs.
      const minCu = num(desired?.fields?.minCu ?? observed?.fields?.minCu) ?? 0.25
      const suspend = num(
        desired?.fields?.suspendTimeoutSeconds ?? observed?.fields?.suspendTimeoutSeconds
      )
      const alwaysOn = lineOf(
        `Compute always on at ${minCu} CU`,
        Math.round(minCu * HOURS_PER_MONTH * 100) / 100,
        'CU-hour',
        compute.unitCents,
        'price_list'
      )
      if (suspend === -1)
        return estimateOf({
          basis: 'price_list',
          confidence: 'list_price',
          lines: [alwaysOn],
          priceAsOf: asOf,
          note: `Never suspends, so it runs all month at its minimum size; autoscaling above it and storage are extra. ${usage}`
        })
      return estimateOf({
        basis: 'usage',
        confidence: 'usage_varies',
        lines: [],
        priceAsOf: asOf,
        note: `Billed only while it runs (it suspends when idle); always on at ${minCu} CU it would be about ${dollars(alwaysOn.monthlyCents)} a month. ${usage}`
      })
    } catch {
      return unknownEstimate('The price could not be worked out.')
    }
  }
}
