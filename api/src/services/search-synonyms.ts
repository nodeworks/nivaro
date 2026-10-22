import { db } from '../db/index.js'
import { hasColumn } from '../lib/column-probe.js'
import { tenantState } from './ai-tenant-state.js'

/**
 * Search synonyms (#1581). A group of words that mean the same thing to the
 * people searching — "po" and "purchase order", "laptop" and "notebook". A
 * search for any word in a group also looks for the others: the collection
 * search box and pickers (readItems' `search`), Cmd+K (/global-search) and the
 * cross-collection /search. A group with a collection applies to that
 * collection's searches only; without one it applies everywhere.
 *
 * Expansion only ever WIDENS the LIKE patterns a search tries. The columns
 * searched and every permission, row filter and user scope stay exactly as
 * they were, so a synonym can never show anyone a row they could not already
 * find by typing the other word.
 *
 * Groups are cached per tenant for 30 s (another replica sees an edit within
 * that window; this process sees it at once).
 */

export interface SynonymGroup {
  id: number
  terms: string[]
  collection: string | null
  note?: string | null
}

/** One slot of a search: the word (or phrase) typed plus what it may also match. */
export type Slot = string[]
/** One way to read the search: every slot must match. */
export type Variant = Slot[]

export const MAX_TERMS = 10
export const MAX_TERM_LENGTH = 100
const MAX_VARIANTS = 4
const MAX_ALTS = 6
const MAX_PHRASES = 6
const TTL_MS = 30_000

export function normalizeTerm(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, MAX_TERM_LENGTH).trim()
  return t.length >= 1 ? t : null
}

/** Clean, dedupe and cap a list of terms; `null` when fewer than two remain. */
export function cleanTerms(v: unknown): string[] | null {
  const raw = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : []
  const out: string[] = []
  for (const r of raw) {
    const t = normalizeTerm(r)
    if (t && !out.includes(t)) out.push(t)
  }
  return out.length >= 2 ? out.slice(0, MAX_TERMS) : null
}

export function parseTerms(raw: unknown): string[] {
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw
    return Array.isArray(v) ? (v.map(normalizeTerm).filter(Boolean) as string[]) : []
  } catch {
    return []
  }
}

const tableReady = () => hasColumn('nivaro_search_synonyms', 'id')

const cache = tenantState(() => ({
  at: 0,
  groups: [] as SynonymGroup[],
  inflight: null as Promise<SynonymGroup[]> | null
}))

export async function listSynonymGroups(): Promise<SynonymGroup[]> {
  if (!(await tableReady())) return []
  const rows = (await db('nivaro_search_synonyms')
    .select('id', 'terms', 'collection', 'note')
    .orderBy('id')) as Array<{
    id: number
    terms: string
    collection: string | null
    note: string | null
  }>
  return rows
    .map((r) => ({
      id: Number(r.id),
      terms: parseTerms(r.terms),
      collection: r.collection || null,
      note: r.note
    }))
    .filter((g) => g.terms.length >= 2)
}

/** Cached groups for search expansion. Never throws: a failed read = no synonyms. */
export async function synonymGroups(): Promise<SynonymGroup[]> {
  const c = cache()
  if (Date.now() - c.at < TTL_MS) return c.groups
  if (!c.inflight) {
    c.inflight = listSynonymGroups()
      .catch(() => [] as SynonymGroup[])
      .then((groups) => {
        c.groups = groups
        c.at = Date.now()
        c.inflight = null
        return groups
      })
  }
  return c.inflight
}

export function forgetSynonymCache(): void {
  const c = cache()
  c.at = 0
}

const inScope = (g: SynonymGroup, collection: string | null | undefined) =>
  g.collection == null || (collection != null && g.collection === collection)

/** term → the other terms of every group it belongs to, for one collection's searches. */
export function synonymIndex(
  groups: SynonymGroup[],
  collection: string | null | undefined
): Map<string, string[]> {
  const idx = new Map<string, string[]>()
  for (const g of groups) {
    if (!inScope(g, collection)) continue
    for (const t of g.terms) {
      const list = idx.get(t) ?? []
      for (const o of g.terms) if (o !== t && !list.includes(o)) list.push(o)
      idx.set(t, list)
    }
  }
  return idx
}

/**
 * The ways to read a search once synonyms apply. Variant 0 is the search as
 * typed, one slot per word, each word also matching its single-word synonyms'
 * groups. A multi-word term found in the search ("purchase order 12") adds a
 * variant where those words become one slot ("purchase order" | "po"). The
 * typed word is always first in its slot. No synonyms → one variant of
 * one-word slots, exactly the search as before.
 */
export function expandSearch(search: string, index: Map<string, string[]>): Variant[] {
  const tokens = search.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return []
  const lower = tokens.map((t) => t.toLowerCase())
  const slot = (typed: string, key: string): Slot => [
    typed,
    ...(index.get(key) ?? []).filter((a) => a !== key).slice(0, MAX_ALTS - 1)
  ]
  const variants: Variant[] = [tokens.map((t, i) => slot(t, lower[i]))]
  const multi = [...index.keys()].filter((k) => k.includes(' '))
  for (const term of multi) {
    if (variants.length >= MAX_VARIANTS) break
    const words = term.split(' ')
    for (let i = 0; i + words.length <= lower.length; i++) {
      if (!words.every((w, j) => lower[i + j] === w)) continue
      variants.push([
        ...tokens.slice(0, i).map((t, j) => slot(t, lower[j])),
        slot(tokens.slice(i, i + words.length).join(' '), term),
        ...tokens.slice(i + words.length).map((t, j) => slot(t, lower[i + words.length + j]))
      ])
      break
    }
  }
  return variants
}

/** LIKE patterns a variant list costs, times the columns each one is tried on. */
export function patternCount(variants: Variant[]): number {
  return variants.reduce((n, v) => n + v.reduce((m, s) => m + s.length, 0), 0)
}

/**
 * Keep an expansion under a bound-parameter budget (SQL Server allows ~2100 per
 * statement): drop extra variants first, then alternatives from the widest
 * slots. The search as typed is never trimmed.
 */
export function fitExpansion(variants: Variant[], perPattern: number, budget: number): Variant[] {
  let out = variants.map((v) => v.map((s) => [...s]))
  const cost = () => patternCount(out) * Math.max(1, perPattern)
  while (out.length > 1 && cost() > budget) out = out.slice(0, -1)
  while (cost() > budget) {
    const widest = out[0].reduce((w, s, i, all) => (s.length > all[w].length ? i : w), 0)
    if (out[0][widest].length <= 1) break
    out[0][widest].pop()
  }
  return out
}

/** Whole-phrase forms of a search (the typed text first), for surfaces that LIKE the phrase. */
export function phraseAlternatives(search: string, index: Map<string, string[]>): string[] {
  const typed = search.trim()
  if (!typed) return []
  const out = [typed]
  const add = (p: string) => {
    if (out.length < MAX_PHRASES && !out.some((o) => o.toLowerCase() === p.toLowerCase()))
      out.push(p)
  }
  for (const alt of index.get(typed.toLowerCase().replace(/\s+/g, ' ')) ?? []) add(alt)
  for (const v of expandSearch(typed, index)) {
    // One substitution at a time keeps the list short and each form readable.
    v.forEach((s, i) => {
      for (const alt of s.slice(1)) add(v.map((x, j) => (j === i ? alt : x[0])).join(' '))
    })
  }
  return out
}

/** Expansion for one collection's search (or Cmd+K with collection omitted). */
export async function searchVariants(search: string, collection?: string | null) {
  const groups = await synonymGroups()
  return expandSearch(search, synonymIndex(groups, collection))
}

export async function searchPhrases(search: string, collection?: string | null) {
  const groups = await synonymGroups()
  if (groups.length === 0) return [search.trim()]
  return phraseAlternatives(search, synonymIndex(groups, collection))
}

/** Is this search already covered by a synonym group in its scope? */
export function coveredBy(
  groups: SynonymGroup[],
  query: string,
  collection: string | null
): SynonymGroup | null {
  const q = normalizeTerm(query)
  if (!q) return null
  const words = new Set(q.split(' '))
  return (
    groups.find(
      (g) =>
        (collection == null ? g.collection == null : inScope(g, collection)) &&
        g.terms.some((t) => t === q || words.has(t))
    ) ?? null
  )
}

// ─── writes (admin) ──────────────────────────────────────────────────────────

export class SynonymError extends Error {
  constructor(
    message: string,
    public status = 400
  ) {
    super(message)
  }
}

function cleanCollection(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, 100) : null
}

/**
 * Add a group. When one of its terms already belongs to a group of the same
 * scope, the terms are merged into that group instead — "add a synonym" from a
 * zero-result search should grow the existing group, not start a rival one.
 */
export async function createSynonymGroup(
  userId: string | null,
  b: { terms?: unknown; collection?: unknown; note?: unknown }
): Promise<{ group: SynonymGroup; merged: boolean }> {
  if (!(await tableReady())) throw new SynonymError('Search synonyms are not set up yet', 503)
  const terms = cleanTerms(b.terms)
  if (!terms) throw new SynonymError('A synonym needs at least two different words')
  const collection = cleanCollection(b.collection)
  const note = typeof b.note === 'string' ? b.note.trim().slice(0, 500) || null : null
  const existing = (await listSynonymGroups()).find(
    (g) => g.collection === collection && g.terms.some((t) => terms.includes(t))
  )
  if (existing) {
    const merged = [...existing.terms, ...terms.filter((t) => !existing.terms.includes(t))]
    if (merged.length > MAX_TERMS)
      throw new SynonymError(`A synonym group holds at most ${MAX_TERMS} words`)
    await db('nivaro_search_synonyms')
      .where({ id: existing.id })
      .update({
        terms: JSON.stringify(merged),
        ...(note && !existing.note ? { note } : {}),
        updated_by: userId,
        updated_at: new Date()
      })
    forgetSynonymCache()
    return { group: { ...existing, terms: merged }, merged: true }
  }
  const [row] = (await db('nivaro_search_synonyms')
    .insert({
      terms: JSON.stringify(terms),
      collection,
      note,
      created_by: userId,
      created_at: new Date()
    })
    .returning('id')) as Array<{ id: number } | number>
  forgetSynonymCache()
  return {
    group: { id: Number(typeof row === 'object' ? row.id : row), terms, collection, note },
    merged: false
  }
}

export async function updateSynonymGroup(
  id: number,
  userId: string | null,
  b: { terms?: unknown; collection?: unknown; note?: unknown }
): Promise<SynonymGroup> {
  if (!(await tableReady())) throw new SynonymError('Search synonyms are not set up yet', 503)
  if (!Number.isSafeInteger(id)) throw new SynonymError('Synonym not found', 404)
  const patch: Record<string, unknown> = { updated_by: userId, updated_at: new Date() }
  if (b.terms !== undefined) {
    const terms = cleanTerms(b.terms)
    if (!terms) throw new SynonymError('A synonym needs at least two different words')
    patch.terms = JSON.stringify(terms)
  }
  if (b.collection !== undefined) patch.collection = cleanCollection(b.collection)
  if (b.note !== undefined)
    patch.note = typeof b.note === 'string' ? b.note.trim().slice(0, 500) || null : null
  const n = await db('nivaro_search_synonyms').where({ id }).update(patch)
  if (!n) throw new SynonymError('Synonym not found', 404)
  forgetSynonymCache()
  const group = (await listSynonymGroups()).find((g) => g.id === id)
  if (!group) throw new SynonymError('Synonym not found', 404)
  return group
}

export async function deleteSynonymGroup(id: number): Promise<boolean> {
  if (!Number.isSafeInteger(id) || !(await tableReady())) return false
  const n = await db('nivaro_search_synonyms').where({ id }).delete()
  forgetSynonymCache()
  return n > 0
}
