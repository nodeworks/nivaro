/**
 * Queue totals row (2026-11-14): per number column, the figures a worklist's footer shows
 * over the WHOLE result the viewer sees with the current scope tab and column filters —
 * the same rows `GET /queues/:id/items` pages through, never just the loaded page.
 *
 * A queue's rows come from up to ten sources over different collections. Each row carries
 * its OWN source's value for a column (`extra[path]`: the path is read on that row's
 * collection), and a row whose source has no such column carries nothing and adds nothing.
 * Figures are kept per collection and combined: sums and counts add up, min / max take the
 * least / greatest, the average is the combined sum over the combined count (never an
 * average of averages). All four come back for every column, so switching Sum → Average
 * needs no second read.
 *
 * Numbers are read with `numberOfValue` — the reader the column filters, group sums and the
 * materialized cache's typed twins use — so the live and cached paths agree row for row.
 */
import { numberOfValue } from './column-filter-ops.js'

/** The figures for one column over some rows. min / max are null when nothing was filled in. */
export interface TotalPart {
  sum: number
  count: number
  min: number | null
  max: number | null
}

export interface QueueColumnTotal extends TotalPart {
  /** sum / count; null when nothing was filled in. */
  avg: number | null
  /** The same figures per source collection (only collections that filled something in). */
  by_collection: Record<string, TotalPart>
}

export type QueueTotals = Record<string, QueueColumnTotal>

/** Most columns one request may total (the materialized read selects two expressions each). */
export const QUEUE_TOTALS_MAX = 12

/**
 * `totals=amount,extra.qty` → plain extra-column paths. The `extra.` prefix is optional (the
 * worklist's column keys carry it); anything that is not a plain path is dropped.
 */
export function parseTotalsParam(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw.trim()) return []
  const out: string[] = []
  for (const part of raw.split(',')) {
    const p = part.trim().replace(/^extra\./, '')
    if (/^[A-Za-z_][\w.]*$/.test(p) && !p.includes('..') && !out.includes(p)) out.push(p)
  }
  return out.slice(0, QUEUE_TOTALS_MAX)
}

export function emptyPart(): TotalPart {
  return { sum: 0, count: 0, min: null, max: null }
}

/** Float sums drift (0.1 + 0.2); figures are kept to six decimals. */
const tidy = (n: number) => Math.round(n * 1e6) / 1e6

export function addValue(part: TotalPart, n: number): void {
  part.sum += n
  part.count++
  if (part.min == null || n < part.min) part.min = n
  if (part.max == null || n > part.max) part.max = n
}

/** Sums and counts add up; min / max take the least / greatest of the parts that have one. */
export function combineParts(parts: TotalPart[]): TotalPart {
  const out = emptyPart()
  for (const p of parts) {
    if (!p || p.count <= 0) continue
    out.sum += p.sum
    out.count += p.count
    if (p.min != null && (out.min == null || p.min < out.min)) out.min = p.min
    if (p.max != null && (out.max == null || p.max > out.max)) out.max = p.max
  }
  out.sum = tidy(out.sum)
  return out
}

/** One column's answer from its per-collection parts. */
export function finishTotal(byCollection: Record<string, TotalPart>): QueueColumnTotal {
  const kept: Record<string, TotalPart> = {}
  for (const [c, p] of Object.entries(byCollection)) {
    if (p.count > 0) kept[c] = { ...p, sum: tidy(p.sum) }
  }
  const all = combineParts(Object.values(kept))
  return {
    ...all,
    avg: all.count > 0 ? tidy(all.sum / all.count) : null,
    by_collection: kept
  }
}

/** The live path: totals over the rows already scoped and filtered in memory. */
export function totalsFromItems(
  items: Array<{ collection: string; extra?: Record<string, unknown> }>,
  paths: string[]
): QueueTotals {
  const acc = new Map<string, Record<string, TotalPart>>()
  for (const p of paths) acc.set(p, {})
  for (const item of items) {
    const extra = item.extra
    if (!extra) continue
    for (const p of paths) {
      if (!(p in extra)) continue
      const n = numberOfValue(extra[p])
      if (n == null) continue
      const byCol = acc.get(p) as Record<string, TotalPart>
      const part = byCol[item.collection] ?? emptyPart()
      addValue(part, n)
      byCol[item.collection] = part
    }
  }
  const out: QueueTotals = {}
  for (const [p, byCol] of acc) out[p] = finishTotal(byCol)
  return out
}

/**
 * The materialized path: one grouped SQL read answers `collection` plus, per requested
 * column i, `s{i}` (SUM), `c{i}` (COUNT of numbers), `n{i}` (MIN) and `x{i}` (MAX).
 */
export function totalsFromGroupedRows(
  rows: Array<Record<string, unknown>>,
  paths: string[]
): QueueTotals {
  const out: QueueTotals = {}
  paths.forEach((p, i) => {
    const byCol: Record<string, TotalPart> = {}
    for (const r of rows) {
      const count = Number(r[`c${i}`] ?? 0)
      if (!Number.isFinite(count) || count <= 0) continue
      const num = (v: unknown) => (v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null)
      byCol[String(r.collection ?? '')] = {
        sum: num(r[`s${i}`]) ?? 0,
        count,
        min: num(r[`n${i}`]),
        max: num(r[`x${i}`])
      }
    }
    out[p] = finishTotal(byCol)
  })
  return out
}
