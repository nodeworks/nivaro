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
import { awsJsonFor } from './client.js'
import { AWS_PRICES_AS_OF, fieldsOf, regionOf, safeEstimate } from './pricing.js'

/**
 * Cost estimates of ECR, SES and Secrets Manager (Task 30). List prices from the Price List
 * Query API through the price book (7-day cache, then the dated bundled table below, never a
 * throw). All three are USAGE priced: the estimate says what is fixed and names the usage price.
 *
 *  - ECR: storage per GB-month, measured from the repository's image sizes (DescribeImages).
 *  - Secrets Manager: a fixed price per secret-month, plus a price per 10,000 API calls (a note).
 *  - SES: the identity, configuration set and IAM user are free; mail is a price per 1,000 sent.
 *
 * UNVERIFIED (like the 44b filters): the attribute names in the sku keys below are written from
 * memory of the public Price List schema and need one live check on a throwaway account. A wrong
 * filter makes the lookup miss; the figure then comes from the bundled table (dated) or is "No
 * estimate" — never a wrong figure shown silently.
 */

export const ECR_STORAGE_SKU = awsSkuKey('AmazonECR', { productFamily: 'EC2 Container Registry' })
export const SECRET_MONTH_SKU = awsSkuKey('AWSSecretsManager', { productFamily: 'Secret' })
export const SECRET_API_SKU = awsSkuKey('AWSSecretsManager', { productFamily: 'API Request' })
export const SES_EMAIL_SKU = awsSkuKey('AmazonSES', { productFamily: 'Sending Email' })

const east = (unit: string, unitCents: number) => ({
  unit,
  unitCents,
  regions: { 'us-east-1': unitCents },
  regionsOnly: true
})

/** Dated list prices (us-east-1) merged into the AWS adapter's bundled table. */
export const AWS_PART3_BUNDLED_PRICES: BundledPriceTable = {
  asOf: AWS_PRICES_AS_OF,
  currency: 'USD',
  items: {
    [ECR_STORAGE_SKU]: east('GB-Mo', 10),
    [SECRET_MONTH_SKU]: east('Secret-Mo', 40),
    // $0.05 per 10,000 API calls = 0.0005 cents a call.
    [SECRET_API_SKU]: east('Requests', 0.0005),
    // $0.10 per 1,000 emails = 0.01 cents an email.
    [SES_EMAIL_SKU]: east('Emails', 0.01)
  }
}

const usd = (cents: number) => `$${(cents / 100).toFixed(cents < 1 ? 4 : 2)}`
const price = (ctx: ProviderContext, sku: string, region: string) =>
  priceLookup(ctx, 'aws', sku, region)

const sourceNote = (ps: Array<PriceLookupAnswer | null>): string | null => {
  const b = ps.find((p) => p?.source === 'bundled')
  return b
    ? `Prices are the Hub's bundled list of ${b.asOf ?? 'an earlier date'} (AWS's live list was not read).`
    : null
}

const join = (...parts: Array<string | null | undefined | false>): string | undefined => {
  const s = parts.filter((p): p is string => !!p).join(' ')
  return s || undefined
}

// ── aws.ecr_repository ──

/** Stored image bytes of a repository in GB (DescribeImages sizes, capped at 5 pages). */
async function ecrStoredGb(ctx: ProviderContext, name: string, region: string): Promise<number> {
  let bytes = 0
  let token: string | undefined
  for (let i = 0; i < 5; i++) {
    const r = await awsJsonFor(
      ctx,
      'ecr',
      'DescribeImages',
      { repositoryName: name, maxResults: 100, nextToken: token },
      { region }
    )
    for (const d of (r.imageDetails as Array<{ imageSizeInBytes?: number }> | undefined) ?? [])
      bytes += typeof d.imageSizeInBytes === 'number' ? d.imageSizeInBytes : 0
    token = (r.nextToken as string | undefined) || undefined
    if (!token) break
  }
  return bytes / 1024 ** 3
}

export function ecrRepositoryEstimate(
  ctx: ProviderContext,
  desired: DesiredResource | null,
  observed: Observed | null
): Promise<CostEstimate> {
  return safeEstimate(async () => {
    const f = fieldsOf(desired, observed)
    const region = regionOf(ctx, f)
    if (!region) return unknownEstimate('Pick a region to see a price.')
    const unit = await price(ctx, ECR_STORAGE_SKU, region)
    if (!unit) return unknownEstimate('AWS lists no ECR storage price for this region.')
    const name = observed?.externalId ?? ''
    let gb: number | null = null
    if (name) {
      try {
        gb = await ecrStoredGb(ctx, name, region)
      } catch {
        gb = null
      }
    }
    const per = `${usd(unit.unitCents)} per GB-month of images`
    return estimateOf({
      basis: 'usage',
      confidence: 'usage_varies',
      lines:
        gb == null
          ? []
          : [
              {
                label: 'Image storage',
                qty: Math.round(gb * 1000) / 1000,
                unit: 'GB-month',
                unitCents: unit.unitCents,
                monthlyCents: Math.round(gb * unit.unitCents),
                kind: 'base',
                source: 'measured'
              }
            ],
      priceAsOf: unit.asOf,
      note: join(
        gb == null
          ? `Billed by use: ${per}, plus data out. Nothing is counted until images are pushed.`
          : `Storage is the stored image size (${per}); data out to the internet is extra.`,
        sourceNote([unit])
      )
    })
  })
}

export function ecrLifecycleEstimate(): Promise<CostEstimate> {
  return Promise.resolve(
    freeEstimate('A lifecycle policy is free; it removes images, so it lowers storage.')
  )
}

// ── aws.secret ──

export function secretEstimate(
  ctx: ProviderContext,
  desired: DesiredResource | null,
  observed: Observed | null
): Promise<CostEstimate> {
  return safeEstimate(async () => {
    const f = fieldsOf(desired, observed)
    const region = regionOf(ctx, f)
    if (!region) return unknownEstimate('Pick a region to see a price.')
    const month = await price(ctx, SECRET_MONTH_SKU, region)
    if (!month) return unknownEstimate('AWS lists no Secrets Manager price for this region.')
    const api = await price(ctx, SECRET_API_SKU, region)
    // A secret waiting for deletion is not billed past its deletion date.
    const pending = observed?.status === 'pending_deletion' && !desired
    return estimateOf({
      basis: 'usage',
      confidence: 'usage_varies',
      lines: pending
        ? []
        : [
            {
              label: 'Secret',
              qty: 1,
              unit: 'secret-month',
              unitCents: month.unitCents,
              monthlyCents: Math.round(month.unitCents),
              kind: 'base',
              source: 'price_list'
            }
          ],
      priceAsOf: month.asOf,
      note: join(
        api
          ? `Plus ${usd(api.unitCents * 10_000)} per 10,000 API calls.`
          : 'Plus a price per 10,000 API calls.',
        sourceNote([month, api])
      )
    })
  })
}

// ── SES ──

export function sesIdentityEstimate(
  ctx: ProviderContext,
  desired: DesiredResource | null,
  observed: Observed | null
): Promise<CostEstimate> {
  return safeEstimate(async () => {
    const f = fieldsOf(desired, observed)
    const region = regionOf(ctx, f)
    if (!region) return unknownEstimate('Pick a region to see a price.')
    const mail = await price(ctx, SES_EMAIL_SKU, region)
    return estimateOf({
      basis: 'usage',
      confidence: 'usage_varies',
      lines: [],
      priceAsOf: mail?.asOf ?? null,
      note: join(
        'The identity is free; mail is billed by use.',
        mail
          ? `${usd(mail.unitCents * 1000)} per 1,000 emails sent, plus attachment data.`
          : 'A price per 1,000 emails applies.',
        sourceNote([mail])
      )
    })
  })
}

export function sesConfigurationSetEstimate(): Promise<CostEstimate> {
  return Promise.resolve(freeEstimate('A configuration set is free.'))
}

export function sesSmtpUserEstimate(): Promise<CostEstimate> {
  return Promise.resolve(
    freeEstimate('An IAM user is free. Mail sent through it is billed on the SES identity.')
  )
}
