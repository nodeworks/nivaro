import { estimateOf, priceLookup, unknownEstimate } from '../pricing/index.js'
import type {
  BundledPriceTable,
  CostEstimate,
  DesiredResource,
  Observed,
  PriceAnswer,
  ProviderContext
} from '../types.js'
import { xmlAttr, xmlChild, xmlList } from '../xml.js'
import { ncCall, tldOf } from './client.js'

/**
 * Namecheap domain prices (Task 44a contract). The account's own price comes from
 * `users.getPricing` (`priceApi`, sku `domain:register:<tld>` / `domain:renew:<tld>`, one year);
 * when that cannot be read, the dated table below (public list prices, copied by hand: verify
 * before relying on them). Prices include the ICANN fee Namecheap adds (`AdditionalCost`).
 */

export const NAMECHEAP_PRICES_AS_OF = '2026-11-27'

const tlds: Record<string, [number, number]> = {
  // tld: [register 1 year, renew 1 year] in cents (list price incl. ICANN fee)
  com: [1128, 1898],
  net: [1298, 1798],
  org: [798, 1548],
  io: [3498, 6298],
  dev: [1298, 1798],
  app: [1498, 1998],
  co: [1298, 3298]
}

export const NAMECHEAP_BUNDLED: BundledPriceTable = {
  asOf: NAMECHEAP_PRICES_AS_OF,
  currency: 'USD',
  items: Object.fromEntries(
    Object.entries(tlds).flatMap(([tld, [reg, renew]]) => [
      [`domain:register:${tld}`, { unit: 'year', unitCents: reg, label: `.${tld} registration` }],
      [`domain:renew:${tld}`, { unit: 'year', unitCents: renew, label: `.${tld} renewal` }]
    ])
  )
}

const SKU_RE = /^domain:(register|renew):([a-z0-9-]+(\.[a-z0-9-]+)*)$/

/** One price from the account's price list (null = Namecheap lists none). */
export async function namecheapPriceApi(
  ctx: ProviderContext,
  skuKey: string
): Promise<PriceAnswer | null> {
  const m = SKU_RE.exec(skuKey)
  if (!m) return null
  const r = await ncCall(ctx, 'namecheap.users.getPricing', {
    ProductType: 'DOMAIN',
    ProductCategory: m[1].toUpperCase(),
    ProductName: m[2]
  })
  const result = xmlChild(r.response, 'UserGetPricingResult')
  for (const type of xmlList(result, 'ProductType'))
    for (const cat of xmlList(type, 'ProductCategory'))
      for (const prod of xmlList(cat, 'Product')) {
        if (xmlAttr(prod, 'Name').toLowerCase() !== m[2]) continue
        const one = xmlList(prod, 'Price').find(
          (p) => xmlAttr(p, 'Duration') === '1' && /^year$/i.test(xmlAttr(p, 'DurationType'))
        )
        if (!one) continue
        const price = Number(xmlAttr(one, 'YourPrice') || xmlAttr(one, 'Price'))
        const extra = Number(
          xmlAttr(one, 'YourAdditonalCost') || xmlAttr(one, 'AdditionalCost') || 0
        )
        if (!Number.isFinite(price) || price < 0) return null
        return {
          unitCents: Math.round((price + (Number.isFinite(extra) ? extra : 0)) * 100),
          unit: 'year',
          currency: (xmlAttr(one, 'Currency') || 'USD').toUpperCase(),
          asOf: ctx.now().toISOString().slice(0, 10)
        }
      }
  return null
}

const fieldsOf = (desired: DesiredResource | null, observed: Observed | null) =>
  desired?.fields ?? observed?.fields ?? {}

/** What a registration costs: the registration now (one time), the renewal each year. */
export async function domainEstimate(
  ctx: ProviderContext,
  desired: DesiredResource | null,
  observed: Observed | null
): Promise<CostEstimate> {
  try {
    const f = fieldsOf(desired, observed)
    const name = String(f.name ?? observed?.externalId ?? '').toLowerCase()
    const tld = tldOf(name)
    if (!tld) return unknownEstimate('Enter the domain name to see a price.')
    const registering = !!desired && !observed
    const renew = await priceLookup(ctx, 'namecheap', `domain:renew:${tld}`, null)
    const reg = registering
      ? await priceLookup(ctx, 'namecheap', `domain:register:${tld}`, null)
      : null
    if (!renew || (registering && !reg))
      return unknownEstimate(`No Namecheap price found for .${tld} domains.`)
    const years = Math.min(10, Math.max(1, Math.trunc(Number(f.years ?? 1)) || 1))
    const autoRenew = observed?.fields.auto_renew === true
    const fromApi = renew.source !== 'bundled'
    return estimateOf({
      basis: 'price_list',
      confidence: 'list_price',
      currency: renew.currency,
      lines: [],
      oneTimeCents: registering && reg ? reg.unitCents + (years - 1) * renew.unitCents : 0,
      yearlyCents: renew.unitCents,
      priceAsOf: renew.asOf,
      note: [
        registering
          ? `Registration is charged once, now (${years} year${years === 1 ? '' : 's'}); it then costs the renewal price each year it is renewed.`
          : autoRenew
            ? 'Renews each year at the renewal price.'
            : 'Auto-renew is off at Namecheap: the renewal is charged only when someone renews it.',
        fromApi
          ? 'Prices are this account’s.'
          : 'List prices from a dated table; the account’s own may differ.'
      ].join(' ')
    })
  } catch {
    return unknownEstimate('No Namecheap price could be read.')
  }
}
