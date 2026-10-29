import type { NivaroClient } from '@nivaro/sdk'
import { useEffect, useState } from 'react'
import { useOptionalNivaroClient } from '../context'
import { get } from './commands'
import { CORE_GLOSSARY, mergeGlossary } from './core-glossary'

// The shared glossary (#1899): business terms an admin defined once
// (GET /api/ai-knowledge/glossary). Labels and Ask AI answers mark a term
// where it appears and show its definition on hover (#1997). One fetch per
// client, kept for five minutes; a host whose API has no glossary route
// simply gets none.

export interface GlossaryTerm {
  id: number
  term: string
  slug: string
  aliases: string[]
  definition: string
  query_slug: string | null
  query_note: string | null
  collection: string | null
  updated_at: string | null
  /** One-line tooltip text; instance rows derive it from the definition (uiHint). */
  ui_hint?: string
  /** A built-in Nivaro term (lib/core-glossary.ts), not an instance row. */
  builtin?: boolean
  /** The built-in slug this instance entry replaces (mergeGlossary). */
  overrides?: string
}

export type GlossarySegment = { text: string; term?: GlossaryTerm }

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const matchers = new WeakMap<GlossaryTerm[], { re: RegExp; byForm: Map<string, GlossaryTerm> }>()

function matcherFor(terms: GlossaryTerm[]) {
  let m = matchers.get(terms)
  if (!m) {
    const byForm = new Map<string, GlossaryTerm>()
    for (const t of terms)
      for (const f of [t.term, ...(t.aliases ?? [])]) {
        const k = f.trim().toLowerCase()
        if (k.length >= 2 && !byForm.has(k)) byForm.set(k, t)
      }
    // Longest first, so "open unbilled" wins over "open".
    const forms = [...byForm.keys()].sort((a, b) => b.length - a.length)
    const re = forms.length
      ? new RegExp(`(?<![\\p{L}\\p{N}])(${forms.map(escapeRe).join('|')})(?![\\p{L}\\p{N}])`, 'giu')
      : /$^/g
    m = { re, byForm }
    matchers.set(terms, m)
  }
  return m
}

/**
 * Split text into plain runs and glossary terms (whole words, case-insensitive,
 * aliases included). `collection` set = a term scoped to another collection is
 * not marked; `once` = each term is marked at its first occurrence only. Pure.
 */
export function glossarySegments(
  text: string,
  terms: GlossaryTerm[],
  opts: { collection?: string | null; once?: Set<number> } = {}
): GlossarySegment[] {
  if (!text || !terms.length) return [{ text }]
  const { re, byForm } = matcherFor(terms)
  const out: GlossarySegment[] = []
  let last = 0
  re.lastIndex = 0
  for (const m of text.matchAll(re)) {
    const term = byForm.get(m[1].toLowerCase())
    if (!term) continue
    if (opts.collection !== undefined && term.collection && term.collection !== opts.collection)
      continue
    if (opts.once) {
      if (opts.once.has(term.id)) continue
      opts.once.add(term.id)
    }
    const at = m.index ?? 0
    if (at > last) out.push({ text: text.slice(last, at) })
    out.push({ text: m[0], term })
    last = at + m[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last) })
  return out.length ? out : [{ text }]
}

/** The hover text for a term: its definition, plus the rule behind it. */
export function glossaryTip(t: GlossaryTerm): string {
  return `${t.term}: ${t.definition}${t.query_note ? ` (${t.query_note})` : ''}`
}

const TTL_MS = 5 * 60_000
const cache = new WeakMap<NivaroClient, { at: number; promise: Promise<GlossaryTerm[]> }>()
const EMPTY: GlossaryTerm[] = []

export function loadGlossary(client: NivaroClient): Promise<GlossaryTerm[]> {
  const hit = cache.get(client)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.promise
  const promise = client
    .request<{ data: GlossaryTerm[] }>(get('/ai-knowledge/glossary'))
    .then((r) => (Array.isArray(r?.data) ? r.data : EMPTY))
    .catch(() => EMPTY)
  cache.set(client, { at: Date.now(), promise })
  return promise
}

/** Drop the cached glossary (after an admin edits it). */
export function invalidateGlossary(client: NivaroClient): void {
  cache.delete(client)
}

const merged = new WeakMap<GlossaryTerm[], GlossaryTerm[]>()

/** Built-in terms with the instance's laid over them — memoized per fetched list. */
export function withCoreGlossary(instance: GlossaryTerm[]): GlossaryTerm[] {
  let m = merged.get(instance)
  if (!m) {
    m = mergeGlossary(CORE_GLOSSARY, instance)
    merged.set(instance, m)
  }
  return m
}

/**
 * The glossary for the current NivaroProvider (one cached read per client).
 * Default: the instance's own terms only (empty without a provider) — what
 * labels and Ask AI answers auto-mark. `{ withCore: true }`: the built-in
 * Nivaro terms too, the instance's entries replacing them (what <Term> uses);
 * works without a provider, an API glossary route or AI configured.
 */
export function useGlossary(opts: { withCore?: boolean } = {}): GlossaryTerm[] {
  const client = useOptionalNivaroClient()
  const [terms, setTerms] = useState<GlossaryTerm[]>(EMPTY)
  useEffect(() => {
    if (!client) return
    let live = true
    loadGlossary(client).then((t) => {
      if (live) setTerms(t)
    })
    return () => {
      live = false
    }
  }, [client])
  return opts.withCore ? withCoreGlossary(terms) : terms
}
