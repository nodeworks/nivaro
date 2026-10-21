import { KIND_WORDS, type NavNode, walk } from './tree'

// Find on canvas (#2620): the Add panel's matcher (any of the texts contains
// the typed words, case-insensitive) over every node of the outline — so a
// field hidden here or by a rule is found like any other.

/** The Add panel's matcher: true when any text contains the trimmed query. */
export function textMatcher(q: string) {
  const needle = q.trim().toLowerCase()
  return (...texts: Array<string | null | undefined>) =>
    !needle || texts.some((t) => t?.toLowerCase().includes(needle))
}

export interface FindHit {
  node: NavNode
  /** "Request › Billing": where it sits; '' at the top of the page. */
  where: string
}

/**
 * Fields, panels and widgets first (by label match, then key match, in page
 * order), then steps, tabs and sections. Empty query = no hits.
 */
export function findHits(nodes: NavNode[], q: string, limit = 50): FindHit[] {
  if (!q.trim()) return []
  const match = textMatcher(q)
  const needle = q.trim().toLowerCase()
  const hits = walk(nodes)
    .filter((e) => e.node.target != null && match(e.node.label, e.node.key))
    .map((e) => ({
      node: e.node,
      where: e.path.map((p) => p.label).join(' › '),
      rank:
        (e.node.kind === 'field' || e.node.kind === 'panel' || e.node.kind === 'widget' ? 0 : 2) +
        (e.node.label.toLowerCase().includes(needle) ? 0 : 1)
    }))
  return hits
    .map((h, i) => ({ ...h, i }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .slice(0, limit)
    .map(({ node, where }) => ({ node, where }))
}

export const kindWord = (n: NavNode) => KIND_WORDS[n.kind]
