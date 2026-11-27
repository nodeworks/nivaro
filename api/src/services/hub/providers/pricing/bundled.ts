import type { BundledPriceTable, PriceAnswer, ProviderAdapter } from '../types.js'

/**
 * The bundled price snapshot (Task 44a): each adapter that bills a fixed plan, or wants a
 * fallback when its price API cannot be read, owns a dated table (`ProviderAdapter.bundledPrices`,
 * kept in the adapter's own folder). The price book reads it last, and the answer always carries
 * the table's date so the person sees how old the figure is. Pure.
 */

/** Cents → the integer micro-units the price cache stores (1 cent = 10,000 micros). */
export const centsToMicros = (cents: number): number => Math.round(cents * 10_000)
export const microsToCents = (micros: number): number => micros / 10_000

/** The table's price for one sku key in one region (a region entry beats the default). */
export function bundledLookup(
  table: BundledPriceTable | null | undefined,
  skuKey: string,
  region: string | null
): PriceAnswer | null {
  if (!table?.items || typeof skuKey !== 'string') return null
  const item = Object.hasOwn(table.items, skuKey) ? table.items[skuKey] : undefined
  if (!item) return null
  const regional =
    region && item.regions && Object.hasOwn(item.regions, region) ? item.regions[region] : undefined
  const unitCents = typeof regional === 'number' ? regional : item.unitCents
  if (typeof unitCents !== 'number' || !Number.isFinite(unitCents) || unitCents < 0) return null
  return {
    unitCents,
    unit: String(item.unit ?? 'unit'),
    currency: table.currency || 'USD',
    asOf: table.asOf ?? null
  }
}

/** The adapter's bundled table (null when it has none). */
export function bundledPrice(
  adapter: ProviderAdapter | null,
  skuKey: string,
  region: string | null
): PriceAnswer | null {
  return bundledLookup(adapter?.bundledPrices, skuKey, region)
}
