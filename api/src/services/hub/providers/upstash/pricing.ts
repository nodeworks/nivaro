import { estimateOf, freeEstimate, priceLookup, unknownEstimate } from '../pricing/index.js'
import type {
  BundledPriceTable,
  CostEstimate,
  DesiredResource,
  Observed,
  ProviderContext
} from '../types.js'

/**
 * Upstash Redis cost estimates (Task 17). Upstash has no price API, so prices are the dated table
 * below. A pay-as-you-go database has no fixed monthly price: it bills commands and stored data
 * (past a small free allowance), so the figure is the known base of zero with a "plus usage" note
 * that names the unit prices (basis `usage`). A free database is free. Any other plan (a fixed
 * plan the account chose in the console) is "No estimate": the plan's size is not in the
 * database record, so the Hub does not guess a price.
 */

export const UPSTASH_PRICES_AS_OF = '2026-11-26'

export const UPSTASH_BUNDLED: BundledPriceTable = {
  asOf: UPSTASH_PRICES_AS_OF,
  currency: 'USD',
  items: {
    'payg:commands_100k': {
      unit: '100K commands',
      unitCents: 20,
      label: 'Pay as you go, per 100,000 commands'
    },
    'payg:storage_gb': {
      unit: 'GB-month',
      unitCents: 25,
      label: 'Pay as you go, stored data'
    }
  }
}

const dollars = (cents: number) => `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`

/** 'free' | 'payg' | 'other' from a database's plan name (`database_type`). */
export function planKind(type: unknown): 'free' | 'payg' | 'other' | 'unknown' {
  const t = String(type ?? '')
    .trim()
    .toLowerCase()
  if (!t) return 'unknown'
  if (t === 'free') return 'free'
  if (t.includes('pay') || t === 'payg') return 'payg'
  return 'other'
}

export async function upstashEstimate(
  ctx: ProviderContext,
  desired: DesiredResource | null,
  observed: Observed | null
): Promise<CostEstimate> {
  try {
    // A new database is made on the account's current default plan: pay as you go.
    const kind = observed ? planKind(observed.fields.plan) : desired ? 'payg' : 'unknown'
    if (kind === 'free')
      return freeEstimate('On the Upstash free plan (a small command and storage allowance).')
    if (kind === 'other' || kind === 'unknown')
      return unknownEstimate('This database is on a plan whose price the Hub cannot read.')
    const [cmd, store] = await Promise.all([
      priceLookup(ctx, 'upstash', 'payg:commands_100k', null),
      priceLookup(ctx, 'upstash', 'payg:storage_gb', null)
    ])
    const rates =
      cmd && store
        ? `${dollars(cmd.unitCents)} per 100,000 commands and ${dollars(store.unitCents)} per GB stored, after the free monthly allowance.`
        : 'Billed per command and per GB stored.'
    return estimateOf({
      basis: 'usage',
      confidence: 'usage_varies',
      lines: [],
      priceAsOf: cmd?.asOf ?? store?.asOf ?? UPSTASH_PRICES_AS_OF,
      note: `Pay as you go: nothing fixed each month, plus usage. ${rates}`
    })
  } catch {
    return unknownEstimate('The price could not be worked out.')
  }
}
