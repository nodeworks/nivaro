import { excerpt, searchTerms } from './help-video-search-rank.js'

// Ask AI's search_docs tool (#1803): the in-app docs — the same sections the
// admin Docs page renders, flattened by scripts/build-docs-index.ts into
// docs-index.json — searched and quoted server-side. The ranker is pure; the
// index loads lazily on the first search (it is ~1 MB of text).
//
// Audience: a section marked 'admin' (every nav group except overview / user
// guide / collaboration, unless the section says otherwise) is left out for a
// non-admin asker, so Ask AI never walks someone through a page they cannot
// open.

export interface DocsIndexBlock {
  h: string | null
  t: string
}

export interface DocsIndexSection {
  id: string
  label: string
  group: string
  group_label: string
  audience: 'all' | 'admin'
  blocks: DocsIndexBlock[]
}

export interface DocsHit {
  id: string
  label: string
  group: string
  /** The heading the quoted passage sits under. */
  heading: string | null
  /** Up to ~500 characters around the first matched word. */
  snippet: string
  /** Share of the searched words found in the section (0–1). */
  coverage: number
  score: number
  /** In-app path of the Docs page scrolled to the section. */
  path: string
  /** Ready markdown link for the answer. */
  cite: string
}

/** Below this share of searched words the docs do not answer the question. */
export const DOCS_ANSWER_COVERAGE = 0.6

function words(text: string): string[] {
  return (
    String(text ?? '')
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  )
}

function matched(ws: string[], terms: string[]): Set<string> {
  const out = new Set<string>()
  for (const t of terms) if (ws.some((w) => w.startsWith(t))) out.add(t)
  return out
}

function occurrences(ws: string[], terms: string[]): number {
  let n = 0
  for (const w of ws) for (const t of terms) if (w.startsWith(t)) n++
  return n
}

interface Prepared {
  section: DocsIndexSection
  label: string[]
  group: string[]
  blocks: Array<{ block: DocsIndexBlock; head: string[]; body: string[] }>
}

const prepared = new WeakMap<DocsIndexSection[], Prepared[]>()

function prepare(index: DocsIndexSection[]): Prepared[] {
  let p = prepared.get(index)
  if (!p) {
    p = index.map((section) => ({
      section,
      label: words(section.label),
      group: words(section.group_label),
      blocks: section.blocks.map((block) => ({
        block,
        head: words(block.h ?? ''),
        body: words(block.t)
      }))
    }))
    prepared.set(index, p)
  }
  return p
}

function linkLabel(s: string): string {
  return s.replace(/[[\]()]/g, '').trim() || 'Docs'
}

export function docsPath(sectionId: string): string {
  return `/docs?section=${encodeURIComponent(sectionId)}`
}

/**
 * Rank docs sections for a question. Score: words in the section label count
 * most, then the heading of the best passage, then the passage itself; a hit
 * must hold at least half the searched words. `answered` says whether the
 * best hit holds enough of them to answer the question (the docs-gaps signal).
 */
export function rankDocs(
  index: DocsIndexSection[],
  query: string,
  opts: { admin: boolean; limit?: number }
): { terms: string[]; hits: DocsHit[]; answered: boolean } {
  const terms = searchTerms(query)
  if (!terms.length) return { terms, hits: [], answered: false }
  const limit = Math.max(1, Math.min(opts.limit ?? 3, 5))
  const scored: DocsHit[] = []
  for (const p of prepare(index)) {
    if (p.section.audience === 'admin' && !opts.admin) continue
    const inLabel = matched(p.label, terms)
    const inGroup = matched(p.group, terms)
    let best: { block: DocsIndexBlock; score: number; found: Set<string> } | null = null
    for (const b of p.blocks) {
      const inHead = matched(b.head, terms)
      const inBody = matched(b.body, terms)
      const found = new Set([...inHead, ...inBody])
      if (!found.size) continue
      const score =
        (found.size / terms.length) * 2 +
        (inHead.size / terms.length) * 1 +
        Math.min(occurrences(b.body, terms), 8) * 0.04
      if (!best || score > best.score) best = { block: b.block, score, found }
    }
    const all = new Set([...inLabel, ...inGroup, ...(best?.found ?? [])])
    const coverage = all.size / terms.length
    if (coverage < 0.5) continue
    const score =
      (inLabel.size / terms.length) * 3 + (inGroup.size / terms.length) * 0.5 + (best?.score ?? 0)
    const passage = best?.block ?? p.section.blocks[0]
    scored.push({
      id: p.section.id,
      label: p.section.label,
      group: p.section.group_label,
      heading: passage?.h ?? null,
      snippet: passage ? excerpt(passage.t, terms, 500) : '',
      coverage: Math.round(coverage * 100) / 100,
      score: Math.round(score * 1000) / 1000,
      path: docsPath(p.section.id),
      cite: `[Docs: ${linkLabel(p.section.label)}](${docsPath(p.section.id)})`
    })
  }
  scored.sort((a, b) => b.score - a.score || b.coverage - a.coverage)
  const hits = scored.slice(0, limit)
  return { terms, hits, answered: (hits[0]?.coverage ?? 0) >= DOCS_ANSWER_COVERAGE }
}

let indexPromise: Promise<DocsIndexSection[]> | null = null

/** The generated index; an empty list when it is missing or unreadable. */
export function loadDocsIndex(): Promise<DocsIndexSection[]> {
  if (!indexPromise) {
    indexPromise = import('./docs-index.json', { with: { type: 'json' } })
      .then((m) => {
        const data = (m as { default?: { sections?: DocsIndexSection[] } }).default
        return Array.isArray(data?.sections) ? data.sections : []
      })
      .catch(() => [] as DocsIndexSection[])
  }
  return indexPromise
}

export function normalizeQuery(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 500)
}
