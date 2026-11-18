import type { LabelOptions, SyncOptions } from './connections.js'
import { normalizeSeverity, type SeverityName } from './rules.js'

/**
 * GitLab labels Nivaro puts on an issue: the connection's label settings (always / by severity /
 * by source / on a new example), the priority and lane maps, and the helpers the outbound and
 * inbound sides use to swap one mapped label for another. Pure — no I/O.
 */

const LABEL_MAX = 255
/** Labels on one create or one change, at most. */
export const LABELS_MAX = 50

/**
 * One GitLab label from any source (template, rule, override, settings). GitLab splits the labels
 * field on commas, so a comma would smuggle in an extra label; line breaks and comment openers go
 * too. Returns '' when nothing is left.
 */
export function safeLabel(raw: unknown): string {
  return String(raw ?? '')
    .replace(/<!--/g, '')
    .replace(/[\r\n,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, LABEL_MAX)
    .trim()
}

/** Label-safe, de-duplicated (case-insensitively, first spelling kept), at most 50. */
export function safeLabels(list: unknown[]): string[] {
  return mergeLabels(list.map(safeLabel))
}

/** Trim, drop empty, de-duplicate case-insensitively keeping the first spelling, at most 50. */
export function mergeLabels(...lists: Array<string[] | undefined>): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const list of lists) {
    if (!Array.isArray(list)) continue
    for (const raw of list) {
      if (typeof raw !== 'string') continue
      const v = raw.trim()
      const key = v.toLowerCase()
      if (!v || seen.has(key)) continue
      seen.add(key)
      out.push(v)
      if (out.length >= LABELS_MAX) return out
    }
  }
  return out
}

const own = <T>(rec: Record<string, T> | undefined, key: string): T | undefined =>
  rec && Object.hasOwn(rec, key) ? rec[key] : undefined

/** Connection labels for one issue: always + by its severity + by its source. */
export function labelsFor(
  issue: { severity: string; source: string },
  opts: Partial<LabelOptions> | undefined
): string[] {
  const source = String(issue.source ?? '')
    .trim()
    .toLowerCase()
  return mergeLabels(
    opts?.always,
    own(opts?.by_severity, normalizeSeverity(issue.severity)),
    own(opts?.by_source, source)
  )
}

/** Issue-log priority (= severity) with the legacy aliases: info→low, warning→medium, error→high. */
export function normalizePriority(sev: string): SeverityName {
  return normalizeSeverity(sev)
}

export const LANE_KEYS = ['open', 'in_progress', 'resolved', 'closed'] as const
export type LaneKey = (typeof LANE_KEYS)[number]

/** The mapped priority label and lane label for an issue (either may be missing). */
export function mappedLabelsFor(
  issue: { severity: string; status: string },
  s: Partial<Pick<SyncOptions, 'priority_map' | 'lane_map'>> | undefined
): string[] {
  const priority = own(
    s?.priority_map as Record<string, string | undefined>,
    normalizePriority(issue.severity)
  )
  const lane = own(s?.lane_map as Record<string, string | undefined>, String(issue.status ?? ''))
  return mergeLabels([priority ?? '', lane ?? ''])
}

/**
 * Labels to add and remove when a map's key changes to `newKey`: add its label, remove every other
 * label of the same map (so lanes never stack, also where scoped labels are not exclusive). A key
 * with no label still removes the others.
 */
export function labelSwap(
  map: Record<string, string | undefined>,
  newKey: string
): { add: string[]; remove: string[] } {
  const added = own(map, newKey)?.trim() ?? ''
  const add = added ? [added] : []
  const remove = mergeLabels(
    Object.entries(map)
      .filter(([k, v]) => k !== newKey && typeof v === 'string')
      .map(([, v]) => v as string)
  ).filter((l) => l.toLowerCase() !== added.toLowerCase())
  return { add, remove }
}

/**
 * The map key whose label was added in this event and is still on the issue, else null. When two
 * mapped labels were added at once the first one in `labelsAdded` wins.
 */
export function readMapped(
  labelsAdded: string[],
  currentLabels: string[],
  map: Record<string, string | undefined>
): string | null {
  const current = new Set(currentLabels.map((l) => String(l).trim().toLowerCase()))
  const byLabel = new Map<string, string>()
  for (const [k, v] of Object.entries(map)) {
    const key = typeof v === 'string' ? v.trim().toLowerCase() : ''
    if (key && !byLabel.has(key)) byLabel.set(key, k)
  }
  for (const raw of labelsAdded) {
    const l = String(raw).trim().toLowerCase()
    if (current.has(l) && byLabel.has(l)) return byLabel.get(l) ?? null
  }
  return null
}
