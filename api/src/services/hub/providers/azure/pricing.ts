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
  PriceAnswer,
  ProviderContext
} from '../types.js'
import { API, armCall, armVersion, parseArmId, serverId } from './client.js'

/**
 * Azure SQL database estimates (Task 39). Prices come from the Azure Retail Prices API
 * (`prices.azure.com`, public, no sign-in; list prices, pay-as-you-go, USD) through the price
 * book's `priceApi` hook, with a small dated table of the DTU tiers as the fallback. The region is
 * the server's. Not part of the estimate: reserved capacity or hybrid benefit discounts, backup
 * storage above the free allowance, data transfer, tax (the engine's lines).
 *
 *  - DTU tiers (Basic, S0–S3, P1): a monthly price.
 *  - vCore (General Purpose, Business Critical): vCores × 730 hours × the vCore-hour price, plus
 *    the allocated storage by GB-month.
 *  - Serverless (`GP_S_…`): billed per vCore-second used while online, so only storage is a
 *    figure; the always-on cost is in the note.
 */

export const AZURE_PRICES_AS_OF = '2026-11-26'
const HOURS_PER_MONTH = 730
const DAYS_PER_MONTH = 365 / 12

/**
 * Approximate US list prices of the DTU tiers, copied from the pricing page on the date above;
 * used only when the Retail Prices API cannot be read.
 */
export const AZURE_BUNDLED: BundledPriceTable = {
  asOf: AZURE_PRICES_AS_OF,
  currency: 'USD',
  items: {
    'sql:dtu:Basic': { unit: 'month', unitCents: 490, label: 'SQL Database Basic' },
    'sql:dtu:S0': { unit: 'month', unitCents: 1473, label: 'SQL Database Standard S0' },
    'sql:dtu:S1': { unit: 'month', unitCents: 2945, label: 'SQL Database Standard S1' },
    'sql:dtu:S2': { unit: 'month', unitCents: 7363, label: 'SQL Database Standard S2' },
    'sql:dtu:S3': { unit: 'month', unitCents: 14726, label: 'SQL Database Standard S3' }
  }
}

export interface SqlSku {
  /** The value of the `sku_name` field. */
  name: string
  /** ARM `sku.name`, `sku.tier`, `sku.family`. */
  armName: string
  tier: 'Basic' | 'Standard' | 'Premium' | 'GeneralPurpose' | 'BusinessCritical' | 'Hyperscale'
  family: string | null
  /** 'dtu' | 'vcore' | 'serverless' */
  model: 'dtu' | 'vcore' | 'serverless'
}

export const SQL_SKUS: SqlSku[] = [
  { name: 'Basic', armName: 'Basic', tier: 'Basic', family: null, model: 'dtu' },
  { name: 'S0', armName: 'S0', tier: 'Standard', family: null, model: 'dtu' },
  { name: 'S1', armName: 'S1', tier: 'Standard', family: null, model: 'dtu' },
  { name: 'S2', armName: 'S2', tier: 'Standard', family: null, model: 'dtu' },
  { name: 'S3', armName: 'S3', tier: 'Standard', family: null, model: 'dtu' },
  { name: 'P1', armName: 'P1', tier: 'Premium', family: null, model: 'dtu' },
  { name: 'GP_Gen5', armName: 'GP_Gen5', tier: 'GeneralPurpose', family: 'Gen5', model: 'vcore' },
  {
    name: 'GP_S_Gen5',
    armName: 'GP_S_Gen5',
    tier: 'GeneralPurpose',
    family: 'Gen5',
    model: 'serverless'
  },
  { name: 'BC_Gen5', armName: 'BC_Gen5', tier: 'BusinessCritical', family: 'Gen5', model: 'vcore' }
]

export function skuOf(name: unknown): SqlSku | null {
  return SQL_SKUS.find((s) => s.name === name) ?? null
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

// ── The Retail Prices API ──

const REGION_RE = /^[a-z0-9]{2,40}$/
const WORD_RE = /^[A-Za-z0-9]{1,20}$/

const PRODUCT_WORDS: Record<string, string> = {
  GeneralPurpose: 'General Purpose - Provisioned - Gen5',
  BusinessCritical: 'Business Critical - Provisioned - Gen5'
}

interface RetailItem {
  retailPrice?: number
  unitPrice?: number
  unitOfMeasure?: string
  meterName?: string
  skuName?: string
  productName?: string
  effectiveStartDate?: string
  currencyCode?: string
  type?: string
}

async function retailItems(ctx: ProviderContext, filter: string): Promise<RetailItem[]> {
  const url = `https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview&$filter=${encodeURIComponent(filter)}`
  const res = await ctx.fetch(url, { method: 'GET', headers: { accept: 'application/json' } })
  if (!res.ok) return []
  const body: any = await res.json().catch(() => null)
  return Array.isArray(body?.Items) ? (body.Items as RetailItem[]) : []
}

const dateOf = (item: RetailItem): string | null =>
  typeof item.effectiveStartDate === 'string' ? item.effectiveStartDate.slice(0, 10) : null

/**
 * `priceApi` of the adapter: sku keys `sql:dtu:<tier name>`, `sql:vcore:<tier>` (price of one
 * vCore-hour) and `sql:storage:<tier>` (price of one GB-month). Prices in USD cents.
 */
export async function azurePriceApi(
  ctx: ProviderContext,
  skuKey: string,
  region: string
): Promise<PriceAnswer | null> {
  const [family, kind, name] = skuKey.split(':')
  if (family !== 'sql' || !kind || !name || !WORD_RE.test(name)) return null
  const reg = region.toLowerCase()
  if (!REGION_RE.test(reg)) return null
  const base = `serviceName eq 'SQL Database' and armRegionName eq '${reg}' and priceType eq 'Consumption'`
  if (kind === 'dtu') {
    const word = name === 'Basic' ? 'Basic' : name.startsWith('P') ? 'Premium' : 'Standard'
    const items = await retailItems(
      ctx,
      `${base} and skuName eq '${name}' and contains(productName, 'Single ${word}')`
    )
    const item = items.find(
      (i) => /day/i.test(String(i.unitOfMeasure)) && num(i.retailPrice) != null
    )
    if (!item) return null
    return {
      unitCents: (num(item.retailPrice) as number) * 100 * DAYS_PER_MONTH,
      unit: 'month',
      currency: item.currencyCode ?? 'USD',
      asOf: dateOf(item)
    }
  }
  const product = PRODUCT_WORDS[name]
  if (!product) return null
  if (kind === 'vcore') {
    const items = await retailItems(
      ctx,
      `${base} and meterName eq 'vCore' and contains(productName, '${product}')`
    )
    const item = items.find(
      (i) => /hour/i.test(String(i.unitOfMeasure)) && num(i.retailPrice) != null
    )
    if (!item) return null
    return {
      unitCents: (num(item.retailPrice) as number) * 100,
      unit: 'vCore-hour',
      currency: item.currencyCode ?? 'USD',
      asOf: dateOf(item)
    }
  }
  if (kind === 'storage') {
    const items = await retailItems(
      ctx,
      `${base} and meterName eq 'Data Stored' and contains(productName, '${product}')`
    )
    const item = items.find(
      (i) => /gb/i.test(String(i.unitOfMeasure)) && num(i.retailPrice) != null
    )
    if (!item) return null
    return {
      unitCents: (num(item.retailPrice) as number) * 100,
      unit: 'GB-month',
      currency: item.currencyCode ?? 'USD',
      asOf: dateOf(item)
    }
  }
  return null
}

// ── The estimate ──

/** The server's region: from the observed database, else read from the server's own record. */
async function regionOf(
  ctx: ProviderContext,
  desired: DesiredResource | null,
  observed: Observed | null
): Promise<string | null> {
  const seen = observed?.fields?.location
  if (typeof seen === 'string' && seen) return seen.toLowerCase().replace(/\s+/g, '')
  const ref = desired?.refs?.server ?? observed?.fields?.server
  const p = parseArmId(typeof ref === 'string' ? ref : null)
  if (!p?.server) return null
  const res = await armCall(ctx, 'GET', serverId(p.sub, p.group, p.server), {
    query: armVersion(API.sql),
    allow: [404]
  })
  const loc = res.status === 200 ? res.body?.location : null
  return typeof loc === 'string' && loc ? loc.toLowerCase().replace(/\s+/g, '') : null
}

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`

export async function sqlDatabaseEstimate(
  ctx: ProviderContext,
  desired: DesiredResource | null,
  observed: Observed | null
): Promise<CostEstimate> {
  try {
    const fields = { ...(observed?.fields ?? {}), ...(desired?.fields ?? {}) }
    const sku = skuOf(fields.sku_name)
    if (!sku) return unknownEstimate('The database size is not one the Hub can price.')
    const region = await regionOf(ctx, desired, observed)
    if (!region) return unknownEstimate('The server’s region could not be read.')
    if (!REGION_RE.test(region)) return unknownEstimate('The region could not be read.')

    if (sku.model === 'dtu') {
      const price: PriceLookupAnswer | null = await priceLookup(
        ctx,
        'azure',
        `sql:dtu:${sku.name}`,
        region
      )
      if (!price) return unknownEstimate('No Azure price was found for this tier.')
      return estimateOf({
        basis: 'price_list',
        confidence: 'list_price',
        lines: [lineOf(`SQL Database ${sku.name}`, 1, 'month', price.unitCents, 'price_list')],
        priceAsOf: price.asOf ?? AZURE_PRICES_AS_OF,
        note: `List price in ${region}${price.source === 'bundled' ? ' (the Hub’s dated table: the price API could not be read)' : ''}; backup storage above the free allowance and data out are extra.`
      })
    }

    const vcores = num(fields.capacity)
    if (!vcores || vcores <= 0) return unknownEstimate('The number of vCores is not set.')
    const tierKey = sku.tier
    const storage = await priceLookup(ctx, 'azure', `sql:storage:${tierKey}`, region)
    const gb = num(fields.max_size_gb)
    const lines: CostLine[] = []
    if (storage && gb && gb > 0)
      lines.push(lineOf('Allocated storage', gb, 'GB-month', storage.unitCents, 'price_list'))

    const compute = await priceLookup(ctx, 'azure', `sql:vcore:${tierKey}`, region)
    if (!compute) return unknownEstimate('No Azure price was found for this size.')
    const asOf = compute.asOf ?? AZURE_PRICES_AS_OF
    const alwaysOn = lineOf(
      `Compute, ${vcores} vCore${vcores === 1 ? '' : 's'}`,
      vcores * HOURS_PER_MONTH,
      'vCore-hour',
      compute.unitCents,
      'price_list'
    )
    if (sku.model === 'serverless')
      return estimateOf({
        basis: 'usage',
        confidence: 'usage_varies',
        lines,
        priceAsOf: asOf,
        note: `Serverless: billed per vCore-second only while the database is online; always on at ${vcores} vCores it would be about ${dollars(alwaysOn.monthlyCents)} a month. List price in ${region}.`
      })
    return estimateOf({
      basis: 'price_list',
      confidence: 'list_price',
      lines: [alwaysOn, ...lines],
      priceAsOf: asOf,
      note: `List price in ${region}, pay-as-you-go: no reserved capacity or hybrid benefit; backup storage above the free allowance and data out are extra.`
    })
  } catch {
    return unknownEstimate('The price could not be worked out.')
  }
}
