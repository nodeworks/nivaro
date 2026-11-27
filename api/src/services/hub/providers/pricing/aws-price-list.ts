import { awsPriceList } from '../aws/client.js'
import type { PriceAnswer, ProviderContext } from '../types.js'

/**
 * AWS list prices through the Price List Query API (`AWSPriceListService.GetProducts`, free,
 * signed with the connection's own credentials; the role needs `pricing:GetProducts`). Task 44a
 * lays the client and the answer parser; Task 44b maps each costed `aws.*` type to its filters
 * (providers/aws/pricing.ts) through `awsSkuKey`.
 *
 * A sku key names the service and the TERM_MATCH filters, canonically:
 *   `AmazonEC2?instanceType=t3.micro&operatingSystem=Linux&preInstalledSw=NA&tenancy=Shared`
 * The region is added as a `regionCode` filter unless the key already names a place
 * (`regionCode`, `fromRegionCode`, `location`, `fromLocation`).
 *
 * The answer: the first product's On-Demand USD price dimension that starts at 0 (the first tier).
 * More than one matching product (an incomplete filter) is still answered from the first, so the
 * figure stays a list price; 44b's filters are precise per type.
 */

const SERVICE_RE = /^[A-Za-z][A-Za-z0-9]{1,63}$/
const FIELD_RE = /^[A-Za-z][A-Za-z0-9]{0,63}$/
const PLACE_FIELDS = ['regionCode', 'fromRegionCode', 'location', 'fromLocation']

export interface AwsSku {
  serviceCode: string
  filters: Record<string, string>
}

/** The canonical sku key (filters sorted). Throws on a key that would not be one. */
export function awsSkuKey(serviceCode: string, filters: Record<string, string>): string {
  if (!SERVICE_RE.test(serviceCode)) throw new Error(`Bad AWS service code ${serviceCode}.`)
  const parts = Object.keys(filters)
    .sort()
    .map((k) => {
      if (!FIELD_RE.test(k)) throw new Error(`Bad price filter ${k}.`)
      return `${k}=${encodeURIComponent(String(filters[k]))}`
    })
  const key = `${serviceCode}?${parts.join('&')}`
  if (key.length > 200) throw new Error('The price key is too long.')
  return key
}

/** A sku key back into its parts; null when it is not one. */
export function parseAwsSkuKey(key: string): AwsSku | null {
  if (typeof key !== 'string' || key.length > 200) return null
  const q = key.indexOf('?')
  const serviceCode = q < 0 ? key : key.slice(0, q)
  if (!SERVICE_RE.test(serviceCode)) return null
  const filters: Record<string, string> = {}
  if (q >= 0 && key.length > q + 1)
    for (const part of key.slice(q + 1).split('&')) {
      const eq = part.indexOf('=')
      if (eq <= 0) return null
      const k = part.slice(0, eq)
      if (!FIELD_RE.test(k)) return null
      try {
        filters[k] = decodeURIComponent(part.slice(eq + 1))
      } catch {
        return null
      }
    }
  return { serviceCode, filters }
}

/** The GetProducts request body for a sku in a region. */
export function getProductsBody(sku: AwsSku, region: string | null): Record<string, unknown> {
  const filters = { ...sku.filters }
  if (region && !PLACE_FIELDS.some((f) => f in filters)) filters.regionCode = region
  return {
    ServiceCode: sku.serviceCode,
    FormatVersion: 'aws_v1',
    MaxResults: 10,
    Filters: Object.keys(filters)
      .sort()
      .map((Field) => ({ Type: 'TERM_MATCH', Field, Value: filters[Field] }))
  }
}

const isObj = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

/** The unit and USD price of one price-list item (a JSON string or object); null = none. */
export function parseAwsPriceItem(item: unknown): PriceAnswer | null {
  let doc: unknown = item
  if (typeof item === 'string') {
    try {
      doc = JSON.parse(item)
    } catch {
      return null
    }
  }
  if (!isObj(doc)) return null
  const onDemand = isObj(doc.terms) && isObj(doc.terms.OnDemand) ? doc.terms.OnDemand : null
  if (!onDemand) return null
  const dims: Array<Record<string, any>> = []
  for (const term of Object.values(onDemand))
    if (isObj(term) && isObj(term.priceDimensions))
      for (const d of Object.values(term.priceDimensions)) if (isObj(d)) dims.push(d)
  const first =
    dims.find((d) => String(d.beginRange ?? '0') === '0' && isObj(d.pricePerUnit)) ??
    dims.find((d) => isObj(d.pricePerUnit))
  const usd = first ? Number(first.pricePerUnit.USD) : Number.NaN
  if (!first || !Number.isFinite(usd) || usd < 0) return null
  const pub = typeof doc.publicationDate === 'string' ? doc.publicationDate.slice(0, 10) : null
  return {
    unitCents: usd * 100,
    unit: String(first.unit ?? 'unit').slice(0, 32),
    currency: 'USD',
    asOf: pub
  }
}

/** The AWS price of one sku key in one region (null = AWS lists no price for it). */
export async function awsPriceListLookup(
  ctx: ProviderContext,
  skuKey: string,
  region: string
): Promise<PriceAnswer | null> {
  const sku = parseAwsSkuKey(skuKey)
  if (!sku) return null
  const answer = await awsPriceList(ctx, 'GetProducts', getProductsBody(sku, region || null))
  const list = Array.isArray(answer.PriceList) ? answer.PriceList : []
  for (const item of list) {
    const p = parseAwsPriceItem(item)
    if (p) return p
  }
  return null
}
