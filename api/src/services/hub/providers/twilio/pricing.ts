import { estimateOf, lineOf, priceLookup, unknownEstimate } from '../pricing/index.js'
import type {
  BundledPriceTable,
  CostEstimate,
  DesiredResource,
  Observed,
  ProviderContext
} from '../types.js'

/**
 * Twilio phone-number rental estimates (Task 26). Twilio's price list is a web page, so prices are
 * this dated table (monthly rental per number, USD). Messaging bills per message on top: the
 * estimate is the rental with a "plus usage" note (basis `plan_price`, confidence `list_price`).
 * A country or number type the table has no price for is "No estimate".
 */

export const TWILIO_PRICES_AS_OF = '2026-11-26'

export const TWILIO_BUNDLED: BundledPriceTable = {
  asOf: TWILIO_PRICES_AS_OF,
  currency: 'USD',
  items: {
    'number:local': {
      unit: 'month',
      unitCents: 115,
      regionsOnly: true,
      regions: { US: 115, CA: 115 },
      label: 'Local phone number rental'
    },
    'number:toll_free': {
      unit: 'month',
      unitCents: 215,
      regionsOnly: true,
      regions: { US: 215, CA: 215 },
      label: 'Toll-free phone number rental'
    }
  }
}

const TOLL_FREE = /^\+1(800|833|844|855|866|877|888)\d{7}$/

/** What a number is by its digits; only North American numbers are told apart. */
export function numberKind(e164: unknown): { country: string; type: 'local' | 'toll_free' } | null {
  const n = String(e164 ?? '')
  if (TOLL_FREE.test(n)) return { country: 'US', type: 'toll_free' }
  if (/^\+1\d{10}$/.test(n)) return { country: 'US', type: 'local' }
  return null
}

export async function twilioNumberEstimate(
  ctx: ProviderContext,
  desired: DesiredResource | null,
  observed: Observed | null
): Promise<CostEstimate> {
  try {
    const known = numberKind(observed?.fields.phone_number ?? desired?.fields.phone_number)
    const country = String(
      known?.country ?? desired?.fields.country ?? observed?.fields.country ?? ''
    ).toUpperCase()
    const type =
      known?.type ?? (desired?.fields.number_type === 'toll_free' ? 'toll_free' : 'local')
    if (!country)
      return unknownEstimate('The number’s country is not known, so its rental is not priced.')
    const price = await priceLookup(ctx, 'twilio', `number:${type}`, country)
    if (!price)
      return unknownEstimate(
        `Twilio’s ${type === 'toll_free' ? 'toll-free' : 'local'} rental price for ${country} is not in the Hub’s price table.`
      )
    return estimateOf({
      basis: 'plan_price',
      confidence: 'list_price',
      lines: [
        lineOf(
          `${type === 'toll_free' ? 'Toll-free' : 'Local'} number rental (${country})`,
          1,
          'month',
          price.unitCents,
          'plan_price'
        )
      ],
      priceAsOf: price.asOf ?? TWILIO_PRICES_AS_OF,
      note: 'Number rental, plus per-message usage (billed per SMS segment sent and received).'
    })
  } catch {
    return unknownEstimate('The price could not be worked out.')
  }
}
