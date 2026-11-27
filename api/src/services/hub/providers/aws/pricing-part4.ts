import { awsSkuKey } from '../pricing/aws-price-list.js'
import {
  estimateOf,
  freeEstimate,
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
import { awsFixedJson } from './client.js'
import { AWS_PRICES_AS_OF, fieldsOf, regionOf, safeEstimate } from './pricing.js'

/**
 * Cost estimates of SNS, AWS Budgets, cost allocation tags and Route 53 Domains (Task 40).
 *
 *  - SNS topic: free for the first million requests a month, then a price per million. A
 *    subscription, the SMS settings and the SMS user cost nothing by themselves; what is sent
 *    through them is billed per message (SMS by destination country) — the estimate says so.
 *  - Budgets and cost allocation tags: no charge for a budget without actions.
 *  - Route 53 Domains: the registrar's own list prices (`ListPrices`, per TLD) — registration is a
 *    ONE-TIME amount (the first year, more years at the renewal price) plus a yearly renewal.
 *
 * UNVERIFIED (like 44b): the SNS sku attributes and the ListPrices answer shape are written from
 * memory of the public docs and need one live check on a throwaway account. A miss falls back to
 * the bundled table (dated) or "No estimate" — never a wrong figure shown silently.
 */

export const SNS_REQUEST_SKU = awsSkuKey('AmazonSNS', { productFamily: 'API Request' })

/** Dated list prices (us-east-1) merged into the AWS adapter's bundled table. */
export const AWS_PART4_BUNDLED_PRICES: BundledPriceTable = {
  asOf: AWS_PRICES_AS_OF,
  currency: 'USD',
  items: {
    // $0.50 per million requests = 0.00005 cents a request (first million free every month).
    [SNS_REQUEST_SKU]: {
      unit: 'Requests',
      unitCents: 0.00005,
      regions: { 'us-east-1': 0.00005 },
      regionsOnly: true
    }
  }
}

const usd = (cents: number) => `$${(cents / 100).toFixed(cents < 1 ? 4 : 2)}`

const sourceNote = (p: PriceLookupAnswer | null): string | undefined =>
  p?.source === 'bundled'
    ? `Prices are the Hub's bundled list of ${p.asOf ?? 'an earlier date'} (AWS's live list was not read).`
    : undefined

const join = (...parts: Array<string | null | undefined | false>): string | undefined => {
  const s = parts.filter((p): p is string => !!p).join(' ')
  return s || undefined
}

// ── SNS ──

export function snsTopicEstimate(
  ctx: ProviderContext,
  desired: DesiredResource | null,
  observed: Observed | null
): Promise<CostEstimate> {
  return safeEstimate(async () => {
    const f = fieldsOf(desired, observed)
    const region = regionOf(ctx, f)
    if (!region) return unknownEstimate('Pick a region to see a price.')
    const p = await priceLookup(ctx, 'aws', SNS_REQUEST_SKU, region)
    return estimateOf({
      basis: 'usage',
      confidence: 'usage_varies',
      lines: [],
      priceAsOf: p?.asOf ?? null,
      note: join(
        'A topic is free; publishing is billed by use.',
        p
          ? `The first million requests a month are free, then ${usd(p.unitCents * 1_000_000)} per million.`
          : 'The first million requests a month are free, then a price per million.',
        'Delivery is billed per message (email, https, and texts by destination country).',
        sourceNote(p)
      )
    })
  })
}

export const snsSubscriptionEstimate = (): Promise<CostEstimate> =>
  Promise.resolve(
    freeEstimate(
      'A subscription is free. Each delivery is billed on the topic: email and https by volume, texts by destination country.'
    )
  )

export const snsSmsSettingsEstimate = (): Promise<CostEstimate> =>
  Promise.resolve(
    freeEstimate(
      'The settings are free. Each text costs by destination country (a US text is under a cent); the monthly spend limit caps the total.'
    )
  )

export const snsSmsUserEstimate = (): Promise<CostEstimate> =>
  Promise.resolve(
    freeEstimate(
      'An IAM user is free. Texts sent with its key are billed per message by destination country.'
    )
  )

// ── Budgets and cost allocation tags ──

export const budgetEstimate = (): Promise<CostEstimate> =>
  Promise.resolve(freeEstimate('A budget without actions is free.'))

export const costTagEstimate = (): Promise<CostEstimate> =>
  Promise.resolve(freeEstimate('Activating a cost allocation tag is free.'))

// ── Route 53 Domains ──

interface TldPrice {
  registrationCents: number
  renewalCents: number
  currency: string
}

const cents = (p: unknown): number | null => {
  const n = Number((p as { Price?: unknown } | null | undefined)?.Price)
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null
}

/** The registrar's list price for one TLD (`com`, `co.uk`), or null. */
export async function domainTldPrice(ctx: ProviderContext, tld: string): Promise<TldPrice | null> {
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(tld)) return null
  const r = await awsFixedJson(ctx, 'route53domains', 'ListPrices', { Tld: tld })
  const row = (r.Prices as Array<Record<string, any>> | undefined)?.find(
    (x) => String(x?.Name ?? '').toLowerCase() === tld
  )
  if (!row) return null
  const registration = cents(row.RegistrationPrice)
  const renewal = cents(row.RenewalPrice)
  if (registration === null || renewal === null) return null
  const currency = String(row.RegistrationPrice?.Currency ?? 'USD').toUpperCase()
  return { registrationCents: registration, renewalCents: renewal, currency }
}

/** The TLD of a registered domain name: everything after the first label. */
export const tldOf = (domain: string): string => domain.split('.').slice(1).join('.').toLowerCase()

export function domainEstimate(
  ctx: ProviderContext,
  desired: DesiredResource | null,
  observed: Observed | null
): Promise<CostEstimate> {
  return safeEstimate(async () => {
    const f = fieldsOf(desired, observed)
    const name = String(f?.name ?? observed?.externalId ?? '').toLowerCase()
    const tld = tldOf(name)
    if (!tld) return unknownEstimate('Enter the domain name to see a price.')
    const price = await domainTldPrice(ctx, tld)
    if (!price) return unknownEstimate(`AWS lists no price for .${tld} domains.`)
    const renewing = f?.auto_renew !== false
    const registering = !!desired && !observed
    const years = Math.min(10, Math.max(1, Math.trunc(Number(f?.years ?? 1)) || 1))
    return estimateOf({
      basis: 'price_list',
      confidence: 'list_price',
      currency: price.currency,
      lines: [],
      // Registering charges the registration price for the first year (+ renewal prices for more).
      oneTimeCents: registering ? price.registrationCents + (years - 1) * price.renewalCents : 0,
      yearlyCents: renewing ? price.renewalCents : 0,
      priceAsOf: ctx.now().toISOString().slice(0, 10),
      note: join(
        registering
          ? `Registration is charged once, now (${years} year${years === 1 ? '' : 's'}); ${renewing ? 'it then renews each year at the renewal price' : 'auto-renew is off, so it expires unless renewed'}.`
          : renewing
            ? 'Renews each year at the renewal price.'
            : 'Auto-renew is off: the domain expires unless renewed.',
        'A hosted zone for it is billed separately ($0.50 a month).'
      )
    })
  })
}
