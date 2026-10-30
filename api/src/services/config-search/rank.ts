import { type ConfigDoc, type ConfigKind, KIND_INFO } from './builders.js'

/**
 * Keyword ranking over the config index (pure). Plain-words questions work
 * because question words are dropped ("where is the … set up"), plurals fold
 * ("IRs" → "ir", "POs" → "po"), collections answer to their acronyms, and a
 * kind word ("rule", "push", "flow") counts toward coverage without being
 * enough on its own when the query names something else too.
 */

/** Question and filler words that never name config. */
const STOPWORDS = new Set(
  (
    'a an the is are was were be been am do does did done where which what who whom whose how ' +
    'why when there here this that these those it its of on in at to for from by with and or ' +
    'not no set setup up configured configure config defined define make makes made making ' +
    'find show me my i we you our your can could should would will please get gets got ' +
    'happen happens happening work works handled handle live lives sits kept called named any ' +
    'all some one so if then than as into about'
  ).split(' ')
)

export function stem(w: string): string {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`
  if (w.length > 2 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1)
  return w
}

/** Lower-cased word stems of a text (snake_case and camelCase split). */
export function tokens(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/'s\b/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map(stem)
}

/** The words of a query worth matching (stopwords dropped, de-duplicated). */
export function queryTerms(q: string): string[] {
  return [...new Set(tokens(q).filter((t) => !STOPWORDS.has(t)))].slice(0, 12)
}

interface Prepared {
  doc: ConfigDoc
  label: Set<string>
  context: Set<string>
  details: Array<{ text: string; words: Set<string> }>
  kind: Set<string>
}

export interface ConfigIndex {
  docs: ConfigDoc[]
  prepared: Prepared[]
  builtAt: number
}

const kindWordCache = new Map<ConfigKind, Set<string>>()
function kindWords(kind: ConfigKind): Set<string> {
  let set = kindWordCache.get(kind)
  if (!set) {
    set = new Set(KIND_INFO[kind].words.flatMap(tokens))
    kindWordCache.set(kind, set)
  }
  return set
}

export function prepareIndex(docs: ConfigDoc[], builtAt = Date.now()): ConfigIndex {
  return {
    docs,
    builtAt,
    prepared: docs.map((doc) => ({
      doc,
      label: new Set(tokens(doc.label)),
      context: new Set(doc.context.flatMap(tokens)),
      details: doc.details.map((text) => ({ text, words: new Set(tokens(text)) })),
      kind: kindWords(doc.kind)
    }))
  }
}

const hasWord = (set: Set<string>, term: string) => {
  if (set.has(term)) return true
  if (term.length < 4) return false
  for (const w of set) if (w.length > term.length && w.startsWith(term)) return true
  return false
}

export interface RankOptions {
  isAdmin: boolean
  /** Kinds the question is about (AI rewrite): a boost, a filter when it leaves hits. */
  kinds?: ConfigKind[]
  /** The collection the question is about (AI rewrite): same. */
  collection?: string | null
  limit?: number
}

export interface RankedConfig {
  doc: ConfigDoc
  score: number
  coverage: number
  /** Detail lines the query matched (placed fields, states, steps…). */
  matched: string[]
}

/** Docs the caller may see, best first. Admin-only config never reaches a
 *  non-admin, whatever the query. */
export function rankConfig(index: ConfigIndex, q: string, opts: RankOptions): RankedConfig[] {
  const terms = queryTerms(q)
  if (terms.length === 0) return []
  const phrase = q.trim().toLowerCase()
  const kindHint = new Set(opts.kinds ?? [])
  const colHint = opts.collection ? opts.collection.toLowerCase() : null
  const out: RankedConfig[] = []
  for (const p of index.prepared) {
    if (p.doc.adminOnly && !opts.isAdmin) continue
    let score = 0
    let matchedTerms = 0
    let named = 0
    let namedTerms = 0
    const matched = new Set<string>()
    for (const t of terms) {
      const isKindWord = p.kind.has(t)
      if (!isKindWord) namedTerms++
      let s = 0
      if (hasWord(p.label, t)) s = 4
      else if (hasWord(p.context, t)) s = 2
      else {
        for (const d of p.details) {
          if (hasWord(d.words, t)) {
            s = Math.max(s, 1.5)
            if (matched.size < 3) matched.add(d.text)
          }
        }
      }
      if (s === 0 && isKindWord) s = 0.75
      if (s > 0) {
        matchedTerms++
        if (!isKindWord) named++
      }
      score += s
    }
    if (matchedTerms === 0) continue
    // A query that names something must match at least one of those names.
    if (namedTerms > 0 && named === 0) continue
    const coverage = matchedTerms / terms.length
    if (terms.length > 1 && coverage < 0.5) continue
    if (phrase.length >= 3 && p.doc.label.toLowerCase().includes(phrase)) score += 3
    if (kindHint.has(p.doc.kind)) score += 2
    if (colHint && p.doc.collection?.toLowerCase() === colHint) score += 2
    out.push({ doc: p.doc, score: score + coverage * 5, coverage, matched: [...matched] })
  }
  out.sort(
    (a, b) =>
      b.coverage - a.coverage ||
      b.score - a.score ||
      a.doc.label.length - b.doc.label.length ||
      a.doc.label.localeCompare(b.doc.label)
  )
  // The AI's kinds / collection narrow the answer when anything is left.
  let ranked = out
  if (kindHint.size) {
    const only = ranked.filter((r) => kindHint.has(r.doc.kind))
    if (only.length) ranked = only
  }
  if (colHint) {
    const only = ranked.filter(
      (r) => !r.doc.collection || r.doc.collection.toLowerCase() === colHint
    )
    if (only.length) ranked = only
  }
  // One hit per screen: a field and its validation doc share a link.
  const seen = new Set<string>()
  const unique: RankedConfig[] = []
  for (const r of ranked) {
    if (seen.has(r.doc.href)) continue
    seen.add(r.doc.href)
    unique.push(r)
    if (unique.length >= (opts.limit ?? 20)) break
  }
  return unique
}

/** A good-enough keyword answer: no AI rewrite needed. */
export function keywordAnswerIsGood(ranked: RankedConfig[]): boolean {
  return ranked.filter((r) => r.coverage >= 0.75).length >= 2
}
