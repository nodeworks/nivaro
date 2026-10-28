/**
 * One search-text vocabulary for every client surface that matches typed text
 * against labels: pickers (RelationCombobox, CatalogPickerField), the command
 * palettes and full search pages (2026-10-28 search program, item 22).
 *
 * - `tokenize(q)`: words, lower-cased and accent-folded; "quoted phrases" stay
 *   one token. Duplicates drop.
 * - `matchesSearch(text, q)`: every token (or one of its synonyms) is a
 *   substring of the text — `matchesAllTokens` (lib/utils.ts) semantics, plus
 *   accent folding, phrases and synonyms.
 * - `highlightParts(text, q)`: the text cut into matched / unmatched parts for
 *   rendering `<mark>`s (multi-token, case- and accent-insensitive, overlaps
 *   merged, indices mapped back to the ORIGINAL text).
 * - Synonyms are a hook, never fetched here: pass `synonyms` (groups of
 *   interchangeable words, e.g. the search-analytics synonym list the server's
 *   `searchPhrases` reads) and each token also matches the others in its group.
 *
 * `searchRankTier` is the client twin of the API's `search_rank=1` ORDER BY
 * (api/src/services/search-rank.ts) — change both together.
 */

export type SynonymGroups = ReadonlyArray<ReadonlyArray<string>>

export interface SearchTextOptions {
  /** Groups of interchangeable words/phrases; a token in a group also matches the rest. */
  synonyms?: SynonymGroups
}

export interface HighlightPart {
  text: string
  match: boolean
}

/** Lower-case + strip combining accents of ONE character (may change its length). */
function foldChar(ch: string): string {
  return ch.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

/** Case- and accent-folded text. */
export function foldSearchText(text: string): string {
  let out = ''
  for (const ch of text) out += foldChar(ch)
  return out
}

/** Folded text plus, for every folded index, the original index it came from. */
function foldWithMap(text: string): { folded: string; map: number[] } {
  let folded = ''
  const map: number[] = []
  let i = 0
  for (const ch of text) {
    const f = foldChar(ch)
    for (let k = 0; k < f.length; k++) map.push(i)
    folded += f
    i += ch.length
  }
  map.push(i)
  return { folded, map }
}

/** Typed text → tokens: whitespace-split words, "quoted phrases" kept whole; folded, unique. */
export function tokenize(q: string | null | undefined): string[] {
  const src = String(q ?? '')
  const out: string[] = []
  const re = /"([^"]*)"|(\S+)/g
  let m: RegExpExecArray | null
  // biome-ignore lint/suspicious/noAssignInExpressions: tokenizer loop
  while ((m = re.exec(src))) {
    const raw = m[1] !== undefined ? m[1] : m[2]
    const tok = foldSearchText(raw)
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^"+|"+$/g, '')
    if (tok && !out.includes(tok)) out.push(tok)
  }
  return out
}

/** Each token with its alternatives (itself first, then every synonym it shares a group with). */
export function expandTokens(tokens: string[], synonyms?: SynonymGroups): string[][] {
  if (!synonyms?.length) return tokens.map((t) => [t])
  const groups = synonyms.map((g) => g.map((w) => foldSearchText(String(w)).trim()).filter(Boolean))
  return tokens.map((t) => {
    const alts = [t]
    for (const g of groups) {
      if (!g.includes(t)) continue
      for (const w of g) if (!alts.includes(w)) alts.push(w)
    }
    return alts
  })
}

/**
 * Every token (or one of its synonyms) occurs in the text. An empty query
 * matches everything — same contract as `matchesAllTokens`.
 */
export function matchesSearch(
  text: string | null | undefined,
  q: string | null | undefined,
  opts: SearchTextOptions = {}
): boolean {
  const tokens = tokenize(q)
  if (tokens.length === 0) return true
  const t = foldSearchText(String(text ?? ''))
  return expandTokens(tokens, opts.synonyms).every((alts) => alts.some((a) => t.includes(a)))
}

/**
 * The text split into matched / unmatched runs for every token and synonym
 * found in it. Overlapping or touching matches merge into one run. No query,
 * or nothing found, returns the whole text as one unmatched part.
 */
export function highlightParts(
  text: string | null | undefined,
  q: string | null | undefined,
  opts: SearchTextOptions = {}
): HighlightPart[] {
  const src = String(text ?? '')
  const tokens = tokenize(q)
  if (!src || tokens.length === 0) return src ? [{ text: src, match: false }] : []
  const { folded, map } = foldWithMap(src)
  const ranges: Array<[number, number]> = []
  for (const alts of expandTokens(tokens, opts.synonyms)) {
    for (const a of alts) {
      if (!a) continue
      let from = 0
      for (;;) {
        const at = folded.indexOf(a, from)
        if (at === -1) break
        ranges.push([map[at], map[at + a.length]])
        from = at + a.length
      }
    }
  }
  if (ranges.length === 0) return [{ text: src, match: false }]
  ranges.sort((x, y) => x[0] - y[0] || y[1] - x[1])
  const merged: Array<[number, number]> = []
  for (const r of ranges) {
    const last = merged[merged.length - 1]
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1])
    else merged.push([r[0], r[1]])
  }
  const parts: HighlightPart[] = []
  let pos = 0
  for (const [s, e] of merged) {
    if (s > pos) parts.push({ text: src.slice(pos, s), match: false })
    if (e > s) parts.push({ text: src.slice(s, e), match: true })
    pos = e
  }
  if (pos < src.length) parts.push({ text: src.slice(pos), match: false })
  return parts
}

// ─── Ranking twin of the API's search_rank=1 ─────────────────────────────────

/** Words the rank tiers look at: whitespace-split, lower-cased, unique, at most 5. */
export const SEARCH_RANK_MAX_WORDS = 5

export function searchRankWords(q: string | null | undefined): string[] {
  const out: string[] = []
  for (const w of String(q ?? '')
    .toLowerCase()
    .split(/\s+/)) {
    if (w && !out.includes(w)) out.push(w)
    if (out.length === SEARCH_RANK_MAX_WORDS) break
  }
  return out
}

/** The whole typed text the exact / prefix tiers compare: trimmed, inner whitespace single. */
export function searchRankPhrase(q: string | null | undefined): string {
  return String(q ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The API's `search_rank=1` tier for one row, from its searched values in
 * request order (`values[0]` = the primary column, e.g. the item number):
 * 0 primary equals the text · 1 another column equals it · 2 primary starts
 * with it · 3 another column starts with it · 4 every word starts a word of
 * some column (start, or after a non-letter/digit) · 5 anything else.
 * Case-insensitive like the database collation; accents are compared as-is
 * (SQL Server *_CI_AS), so this never folds them.
 */
export function searchRankTier(
  values: ReadonlyArray<unknown>,
  q: string | null | undefined
): number {
  const phrase = searchRankPhrase(q).toLowerCase()
  if (!phrase) return 5
  const vals = values.map((v) =>
    v == null || typeof v === 'object' ? '' : String(v).toLowerCase().trimEnd()
  )
  if (vals[0] === phrase) return 0
  if (vals.slice(1).some((v) => v === phrase)) return 1
  if (vals[0]?.startsWith(phrase)) return 2
  if (vals.slice(1).some((v) => v.startsWith(phrase))) return 3
  const words = searchRankWords(q)
  if (
    words.length > 0 &&
    words.every((w) => {
      const re = new RegExp(`(^|[^a-z0-9])${escapeRe(w)}`)
      return vals.some((v) => re.test(v))
    })
  )
    return 4
  return 5
}
