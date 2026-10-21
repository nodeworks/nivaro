/**
 * Glossary wording on a form (#2677). The AI knowledge glossary names each
 * business term once (`term`) with the other words people use for it
 * (`aliases`). Form text that says an alias instead of the term is "off the
 * glossary": the label should say the term. Pure.
 */

export interface GlossaryWord {
  id: number
  term: string
  aliases: string[]
}

export interface OffGlossaryUse {
  entry: GlossaryWord
  /** The alias as written in the text. */
  found: string
  index: number
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Matcher over every term and alias, longest first, whole words only. */
function formsOf(entries: GlossaryWord[]): {
  re: RegExp | null
  byForm: Map<string, { entry: GlossaryWord; isTerm: boolean }>
} {
  const byForm = new Map<string, { entry: GlossaryWord; isTerm: boolean }>()
  // Terms first: a word that is one entry's term is never another entry's alias.
  for (const e of entries) {
    const k = e.term.trim().toLowerCase()
    if (k && !byForm.has(k)) byForm.set(k, { entry: e, isTerm: true })
  }
  for (const e of entries)
    for (const a of e.aliases) {
      const k = a.trim().toLowerCase()
      if (k && !byForm.has(k)) byForm.set(k, { entry: e, isTerm: false })
    }
  if (byForm.size === 0) return { re: null, byForm }
  const forms = [...byForm.keys()].sort((a, b) => b.length - a.length)
  return {
    re: new RegExp(
      `(?<![\\p{L}\\p{N}])(${forms.map(escapeRe).join('|')})(?![\\p{L}\\p{N}])`,
      'giu'
    ),
    byForm
  }
}

/**
 * Every alias the text uses where the glossary has a term. A match on the
 * term itself (or on a longer form containing the alias, such as "PUB'd" for
 * the alias "PUB") is fine: the longest form wins at each position.
 */
export function offGlossaryUses(text: string, entries: GlossaryWord[]): OffGlossaryUse[] {
  const t = String(text ?? '')
  if (!t || entries.length === 0) return []
  const { re, byForm } = formsOf(entries)
  if (!re) return []
  const out: OffGlossaryUse[] = []
  for (const m of t.matchAll(re)) {
    const hit = byForm.get(m[1].toLowerCase())
    if (hit && !hit.isTerm) out.push({ entry: hit.entry, found: m[1], index: m.index ?? 0 })
  }
  return out
}

/** The text with every off-glossary alias replaced by its term. */
export function toGlossaryWording(text: string, entries: GlossaryWord[]): string {
  const uses = offGlossaryUses(text, entries)
  if (uses.length === 0) return text
  let out = ''
  let last = 0
  for (const u of uses) {
    out += text.slice(last, u.index) + u.entry.term
    last = u.index + u.found.length
  }
  return out + text.slice(last)
}

/** Whether a rewrite still says an alias somewhere, or dropped a term the fix needs. */
export function followsGlossary(
  rewrite: string,
  needed: GlossaryWord[],
  entries: GlossaryWord[]
): boolean {
  if (offGlossaryUses(rewrite, entries).length > 0) return false
  const lower = rewrite.toLowerCase()
  return needed.every((e) => lower.includes(e.term.toLowerCase()))
}
