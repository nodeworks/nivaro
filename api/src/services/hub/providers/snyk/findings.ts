import type { Observed } from '../types.js'

/**
 * What Snyk found, in the shape the Hub vulnerability tab keeps per source (source `snyk`).
 * Pure: it only sums `snyk.project` observations (the counts the adapter puts in their `fields`),
 * so it never calls Snyk and never sees a token.
 *
 * Task 43 hooks this into the tab: per Snyk connection it lists `snyk.project` (adapter `list`,
 * counts only), optionally fills `fixable` through `readSnykFixable` (index.ts), and calls
 * `snykFindingsFor(items)` for the tab's row.
 */

export interface SnykFindings {
  source: 'snyk'
  critical: number
  high: number
  medium: number
  low: number
  /** Open issues Snyk can fix by an upgrade, patch or pin; null = not read for any project. */
  fixable: number | null
  /** Projects counted (monitored or not). */
  projects: number
  /** Projects Snyk no longer monitors: their counts may be old. */
  unmonitored: number
}

const num = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

/** Sums the severity counts and the fixable count of the given `snyk.project` observations. */
export function snykFindingsFor(projects: Observed[]): SnykFindings {
  const out: SnykFindings = {
    source: 'snyk',
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    fixable: null,
    projects: 0,
    unmonitored: 0
  }
  for (const p of projects) {
    if (p.type !== 'snyk.project') continue
    out.projects += 1
    out.critical += num(p.fields.critical)
    out.high += num(p.fields.high)
    out.medium += num(p.fields.medium)
    out.low += num(p.fields.low)
    if (p.fields.monitored === false) out.unmonitored += 1
    if (p.fields.fixable !== null && p.fields.fixable !== undefined)
      out.fixable = (out.fixable ?? 0) + num(p.fields.fixable)
  }
  return out
}
