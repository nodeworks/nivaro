import { db } from '../../../../db/index.js'
import type { PriceAnswer } from '../types.js'
import { centsToMicros, microsToCents } from './bundled.js'

/**
 * The price cache (migration 585, `nivaro_hub_price_cache`): one row per provider + sku key +
 * region. Written only by the price book (pricing/index.ts) — never by an adapter. A row younger
 * than PRICE_CACHE_DAYS is used as it is; an older one is fetched again (and kept as the last
 * resort when the provider's API and the bundled table both have nothing). Every read and write
 * swallows its error: a cache that cannot be read is a miss, never a failed plan.
 */

export const PRICE_CACHE = 'nivaro_hub_price_cache'
export const PRICE_CACHE_DAYS = 7
export const PRICE_CACHE_MS = PRICE_CACHE_DAYS * 86_400_000

export interface CachedPrice extends PriceAnswer {
  fetchedAt: Date
}

const iso = (v: unknown): Date | null => {
  if (v == null) return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isFinite(d.getTime()) ? d : null
}

/** Keys are cut to the column widths, so a long one can never fail an insert. */
const keyOf = (provider: string, skuKey: string, region: string) => ({
  provider: provider.slice(0, 32),
  sku_key: skuKey.slice(0, 200),
  region: (region || '*').slice(0, 32)
})

export async function readCachedPrice(
  provider: string,
  skuKey: string,
  region: string
): Promise<CachedPrice | null> {
  try {
    const row = (await db(PRICE_CACHE)
      .where(keyOf(provider, skuKey, region))
      .first()) as Record<string, unknown> | undefined
    if (!row) return null
    const micros = Number(row.unit_micros)
    const fetchedAt = iso(row.fetched_at)
    if (!Number.isFinite(micros) || micros < 0 || !fetchedAt) return null
    return {
      unitCents: microsToCents(micros),
      unit: String(row.unit ?? 'unit'),
      currency: String(row.currency ?? 'USD'),
      asOf: row.as_of == null ? null : String(row.as_of),
      fetchedAt
    }
  } catch {
    return null
  }
}

export async function writeCachedPrice(
  provider: string,
  skuKey: string,
  region: string,
  price: PriceAnswer,
  now: Date
): Promise<void> {
  const key = keyOf(provider, skuKey, region)
  const values = {
    unit: String(price.unit).slice(0, 32),
    unit_micros: centsToMicros(price.unitCents),
    currency: String(price.currency || 'USD')
      .slice(0, 3)
      .toUpperCase(),
    as_of: price.asOf == null ? null : String(price.asOf).slice(0, 32),
    fetched_at: now
  }
  try {
    const n = await db(PRICE_CACHE).where(key).update(values)
    if (!n) await db(PRICE_CACHE).insert({ ...key, ...values })
  } catch {
    // A second writer won the insert (unique key): its row is as good as ours.
  }
}
