import { db } from '../db/index.js'
import { cosineSim, embedText } from './embeddings.js'

/**
 * Group similar issues (#1861). Open issues are clustered by the meaning of their message and
 * route: each issue is embedded (message with ids and numbers folded away, plus its route),
 * and an issue joins the first group whose lead is close enough. Ten variants of one bug
 * ("Invalid column name 'x'", "...'y'") therefore read as one problem with the variants under it.
 *
 * Read-only for now: the grouping is recomputed on demand (10 minute cache). Admin split/merge
 * overrides need somewhere to live and are not built yet.
 */

export interface IssueGroup {
  lead: { id: number; title: string; severity: string; occurrences: number }
  total_occurrences: number
  variants: Array<{
    id: number
    title: string
    severity: string
    occurrences: number
    similarity: number
  }>
}

/** The text that is embedded: volatile parts (uuids, numbers, quoted names) folded away. */
export function normalizeForGrouping(title: string): string {
  return title
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    .replace(/'[^']{1,80}'/g, "'<x>'")
    .replace(/"[^"]{1,80}"/g, '"<x>"')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400)
}

/** Greedy clustering over embeddings; pure so it can be tested without a provider. */
export function clusterByVectors<T extends { vec: number[] }>(
  items: T[],
  threshold: number
): Array<{ lead: T; members: Array<{ item: T; sim: number }> }> {
  const groups: Array<{ lead: T; members: Array<{ item: T; sim: number }> }> = []
  for (const item of items) {
    let best: { g: (typeof groups)[number]; sim: number } | null = null
    for (const g of groups) {
      const sim = cosineSim(g.lead.vec, item.vec)
      if (sim >= threshold && (!best || sim > best.sim)) best = { g, sim }
    }
    if (best) best.g.members.push({ item, sim: best.sim })
    else groups.push({ lead: item, members: [] })
  }
  return groups
}

let cache: { at: number; value: IssueGroup[] } | null = null

export async function groupSimilarIssues(threshold = 0.8): Promise<IssueGroup[]> {
  if (cache && Date.now() - cache.at < 10 * 60_000) return cache.value
  const rows = (await db('nivaro_issues')
    .whereIn('status', ['open', 'in_progress'])
    .orderBy('occurrence_count', 'desc')
    .limit(150)
    .select('id', 'title', 'severity', 'occurrence_count', 'source')) as Array<{
    id: number
    title: string
    severity: string
    occurrence_count: number | null
    source: string | null
  }>
  const embedded: Array<{ row: (typeof rows)[number]; vec: number[] }> = []
  for (const row of rows) {
    try {
      embedded.push({ row, vec: await embedText(normalizeForGrouping(row.title)) })
    } catch {
      /* an issue that cannot be embedded stands alone below */
      embedded.push({ row, vec: [] })
    }
  }
  const out = clusterByVectors(embedded, threshold)
    .map((g) => {
      const shape = (r: (typeof rows)[number]) => ({
        id: r.id,
        title: r.title,
        severity: r.severity,
        occurrences: Number(r.occurrence_count) || 1
      })
      const lead = shape(g.lead.row)
      return {
        lead,
        total_occurrences:
          lead.occurrences +
          g.members.reduce((s, m) => s + (Number(m.item.row.occurrence_count) || 1), 0),
        variants: g.members.map((m) => ({
          ...shape(m.item.row),
          similarity: Math.round(m.sim * 100) / 100
        }))
      }
    })
    .sort((a, b) => b.total_occurrences - a.total_occurrences)
  cache = { at: Date.now(), value: out }
  return out
}
