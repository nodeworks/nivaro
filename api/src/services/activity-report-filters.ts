import type { Knex } from 'knex'
import {
  type ActivityFilters,
  applyActivityFilters,
  normalizeActivityFilters,
  resolveRange
} from './activity-filters.js'
import { type ReportWindow, summaryWindow } from './activity-report.js'

/**
 * The Audit report's filters on GET /api/reports/summary and the readable CSV export
 * (GET /api/reports/activity?format=csv&readable=1). Both speak GET /api/activity's filter
 * shape (services/activity-filters.ts); the summary keeps its own rule that it never runs
 * unbounded — no window → the last 30 days.
 */

/** Query keys that turn the summary from "everything in the window" into a filtered summary. */
const FILTER_KEYS = [
  'user',
  'action',
  'action[]',
  'actions',
  'exclude_actions',
  'exclude_action',
  'collection',
  'collection[]',
  'collections',
  'item',
  'range',
  'q'
]

export function hasReportFilterParams(q: Record<string, unknown>): boolean {
  return FILTER_KEYS.some((k) => q[k] != null && q[k] !== '')
}

export interface ReportFilterResult {
  /** The window the summary counts (a relative range resolved, else from/to, else 30 days). */
  win: ReportWindow
  /** The rest of the filters, window removed. */
  filters: ActivityFilters
  range: string | null
}

/** Query → the summary's window + the other filters, or a 400 message. */
export function reportFilters(
  q: Record<string, unknown>,
  now: Date = new Date()
): ReportFilterResult | { error: string } {
  const parsed = normalizeActivityFilters(q)
  if (parsed.errors.length) return { error: parsed.errors.join('; ') }
  const { range, from, to, ...rest } = parsed.filters
  let win: ReportWindow
  if (range) {
    const r = resolveRange(range, now)
    win = { from: r.from, to: r.to, defaulted: false }
  } else {
    const w = summaryWindow({ from: from ?? undefined, to: to ?? undefined }, now)
    if ('error' in w) return { error: w.error }
    win = w
  }
  return { win, filters: rest, range: range ?? null }
}

/**
 * Applies the non-window filters to a query over `nivaro_activity as a`. The window is pinned
 * as from/to so a text search never adds its own 90-day default on top of it.
 */
export function applyReportFilters<T extends Knex.QueryBuilder>(
  qb: T,
  r: ReportFilterResult,
  opts: { mssql: boolean; now?: Date }
): T {
  return applyActivityFilters(
    qb,
    {
      ...r.filters,
      from: r.win.from.toISOString(),
      to: r.win.to ? r.win.to.toISOString() : null
    },
    opts
  )
}
