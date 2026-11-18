/**
 * `_sum_into` — a total the SERVER derives on an item PATCH (realtime gaps R1,
 * 2026-11-17). A month-columnar grid (record-grid editor: forecasts, budgets)
 * used to send its own total, summed from the months it had loaded: when
 * someone else had saved other months since, the stored total was wrong.
 * The grid now sends only the months it changed plus
 * `_sum_into: { field: 'total', of: ['january', …] }`, and the total is
 * summed from the row AS IT WILL BE STORED (the stored row + this write).
 *
 * The total never makes the mid-air check (`_base_revision`) refuse a write
 * that only changed other months than the newer save. After that check it IS
 * one of the caller's written fields: the edit lock, change reason, row and
 * section locks and validation judge it like any other (security review
 * 2026-11-17 — a total written after those steps bypassed them).
 *
 * Accepted only when:
 * - the target is the `computed_total_field` of a record-grid widget a page
 *   (nivaro_pages) configures for this collection, and `of` is that grid's
 *   first month set (never any other field);
 * - the caller may write the target AND every `of` field (field-level policy).
 * Anything else is ignored: no total is written.
 */

import { db } from '../db/index.js'
import { currentTenantKey } from './tenant-rooms.js'

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december'
]

const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const MAX_OF = 120

export interface SumInto {
  field: string
  of: string[]
}

/** Read and strip `_sum_into` from a payload. Anything malformed (bad
 *  names, the target among its own inputs, too many inputs) is ignored. */
export function takeSumInto(data: Record<string, unknown>): SumInto | null {
  const raw = data._sum_into
  delete data._sum_into
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const field = (raw as { field?: unknown }).field
  const of = (raw as { of?: unknown }).of
  if (typeof field !== 'string' || !IDENT.test(field) || field.startsWith('_')) return null
  if (!Array.isArray(of) || of.length === 0 || of.length > MAX_OF) return null
  const names = [...new Set(of)]
  if (!names.every((f) => typeof f === 'string' && IDENT.test(f) && !f.startsWith('_'))) return null
  if (names.includes(field)) return null
  return { field, of: names as string[] }
}

/** Every field the total names (target and inputs) is one the caller may
 *  write; `writable` null / `*` = every field. */
export function sumFieldsWritable(sum: SumInto, writable: string[] | null): boolean {
  if (writable === null || writable.includes('*')) return true
  const ok = new Set(writable)
  return ok.has(sum.field) && sum.of.every((f) => ok.has(f))
}

/** target field → the input fields a grid sums into it, for one collection. */
export type GridTotals = Map<string, Set<string>>

/** The record-grid totals the page layouts configure for `collection`
 *  (any nesting: a grid inside tabs or a drawer is found too). */
export function gridTotalsFromLayouts(layouts: unknown[], collection: string): GridTotals {
  const out: GridTotals = new Map()
  const visit = (node: unknown, depth: number) => {
    if (!node || typeof node !== 'object' || depth > 12) return
    if (Array.isArray(node)) {
      for (const n of node) visit(n, depth + 1)
      return
    }
    const o = node as Record<string, unknown>
    const sets = o.month_sets
    if (
      o.collection === collection &&
      typeof o.computed_total_field === 'string' &&
      Array.isArray(sets) &&
      sets.length > 0
    ) {
      const suffix = (sets[0] as { suffix?: unknown })?.suffix
      if (typeof suffix === 'string') {
        const of = out.get(o.computed_total_field) ?? new Set<string>()
        for (const m of MONTHS) of.add(`${m}${suffix}`)
        out.set(o.computed_total_field, of)
      }
    }
    for (const v of Object.values(o)) visit(v, depth + 1)
  }
  for (const l of layouts) {
    let parsed = l
    if (typeof l === 'string') {
      try {
        parsed = JSON.parse(l)
      } catch {
        continue
      }
    }
    visit(parsed, 0)
  }
  return out
}

/** Whether a page's grid sums exactly these inputs into this target. */
export function isGridTotal(sum: SumInto, totals: GridTotals): boolean {
  const allowed = totals.get(sum.field)
  return !!allowed && sum.of.every((f) => allowed.has(f))
}

const TOTALS_TTL_MS = 60_000
const totalsCache = new Map<string, { at: number; layouts: Promise<unknown[]> }>()

/** The page layouts, read at most once a minute per tenant. */
async function pageLayouts(): Promise<unknown[]> {
  const key = currentTenantKey()
  const hit = totalsCache.get(key)
  if (hit && Date.now() - hit.at < TOTALS_TTL_MS) return hit.layouts
  const layouts = (async () => {
    try {
      const rows = (await db('nivaro_pages').select('layout')) as Array<{ layout: unknown }>
      return rows.map((r) => r.layout)
    } catch {
      return []
    }
  })()
  totalsCache.set(key, { at: Date.now(), layouts })
  return layouts
}

/** The grid totals configured for `collection` (page layouts, cached a minute). */
export async function gridTotalsFor(collection: string): Promise<GridTotals> {
  return gridTotalsFromLayouts(await pageLayouts(), collection)
}

/** Tests only. */
export function clearGridTotalsCache(): void {
  totalsCache.clear()
}

/** The total over the row as it will be stored: this write's value where it
 *  sends one, else the stored value. Empty / non-numeric values count 0. */
export function sumOver(
  of: string[],
  payload: Record<string, unknown>,
  stored: Record<string, unknown> | null | undefined
): number {
  let total = 0
  for (const f of of) {
    const v = Object.hasOwn(payload, f) ? payload[f] : stored?.[f]
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : 0
    if (Number.isFinite(n)) total += n
  }
  // Month amounts are money: keep the sum free of binary-float tails.
  return Math.round(total * 1e6) / 1e6
}
