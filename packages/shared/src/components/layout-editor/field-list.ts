import {
  applyLayoutOps,
  HEADER_GROUP_KEY,
  type LayoutBundle,
  type LayoutOp
} from '../../lib/layout-ops'
import { titleCase } from '../../lib/utils'
import { fieldSpot } from './add-target'
import { sectionLabel } from './canvas-diff'
import type { DesignTarget } from './design-context'
import { normalizedBundle, plural } from './field-zones'
import { refuse, type StructurePlan } from './structure-ops'
import { humanizeOpError } from './useLayoutDraft'

/**
 * Paste field names to place (#3201): a list of field names, keys or labels
 * (one per line, or split by commas, semicolons or tabs — straight out of a
 * spreadsheet column or a spec) becomes every matched field placed after the
 * selection, in the list's order, as ONE undo step. What matches nothing is
 * listed back, and fields already in that section are left where they are.
 */

export interface ListField {
  field: string
  label?: string | null
}

const MAX_NAMES = 200

/** The names in pasted text, in order, once each. Bullets, numbering and quotes are dropped. */
export function parseFieldList(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of text.split(/[\n\r,;\t]+/)) {
    const name = raw
      .trim()
      .replace(/^(?:[-*•·]|\d+[.)])\s+/, '')
      .replace(/^["'`“‘]+|["'`”’]+$/g, '')
      .trim()
    if (!name) continue
    const k = name.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(name)
    if (out.length >= MAX_NAMES) break
  }
  return out
}

/** Does pasted text read as a list of names (not a sentence, not a clip, not code)? */
export function looksLikeFieldList(text: string): boolean {
  const t = text.trim()
  if (!t || t.length > 20_000 || t.startsWith('{') || t.startsWith('[')) return false
  const names = parseFieldList(t)
  if (names.length === 0) return false
  return names.every((n) => n.length <= 80 && n.split(/\s+/).length <= 8)
}

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '')

export interface ListMatch {
  matched: Array<{ name: string; field: string }>
  unmatched: string[]
}

/**
 * Each name to a field of the collection: the key exactly, then ignoring case,
 * then the label, then either with spaces, dashes and underscores ignored
 * ("PO number" → po_number). A name two fields share by label alone is
 * matched to neither (listed as unmatched) rather than guessed.
 */
export function matchFieldNames(names: string[], fields: ListField[]): ListMatch {
  const real = fields.filter((f) => f.field && !f.field.startsWith('__'))
  const exact = new Map(real.map((f) => [f.field, f.field]))
  const index = (key: (f: ListField) => string | null) => {
    const m = new Map<string, string | null>()
    for (const f of real) {
      const k = key(f)
      if (!k) continue
      m.set(k, m.has(k) && m.get(k) !== f.field ? null : f.field)
    }
    return m
  }
  const byKey = index((f) => f.field.toLowerCase())
  const byLabel = index((f) => (f.label || titleCase(f.field)).toLowerCase())
  const bySquashKey = index((f) => squash(f.field))
  const bySquashLabel = index((f) => squash(f.label || titleCase(f.field)))
  const matched: ListMatch['matched'] = []
  const unmatched: string[] = []
  const used = new Set<string>()
  for (const name of names) {
    const lower = name.toLowerCase()
    const s = squash(name)
    const field =
      exact.get(name) ??
      byKey.get(lower) ??
      byLabel.get(lower) ??
      (s ? (bySquashKey.get(s) ?? bySquashLabel.get(s)) : undefined) ??
      null
    if (!field) unmatched.push(name)
    else if (!used.has(field)) {
      used.add(field)
      matched.push({ name, field })
    }
  }
  return { matched, unmatched }
}

export type ListPlan = StructurePlan & {
  /** Names that matched no field. */
  unmatched: string[]
  /** Fields already in the section they would go in. */
  already: string[]
  /** Fields the plan places, in order. */
  placed: string[]
}

/** Every matched field placed after the selection, in order: one batch. */
export function placeListPlan(
  bundle: LayoutBundle,
  text: string,
  fields: ListField[],
  selected: DesignTarget | null,
  to: 'form' | 'header' = 'form'
): ListPlan {
  const names = parseFieldList(text)
  const { matched, unmatched } = matchFieldNames(names, fields)
  const label = (f: string) => fields.find((x) => x.field === f)?.label || titleCase(f)
  const empty = { unmatched, already: [] as string[], placed: [] as string[] }
  if (names.length === 0) return { ...refuse('Paste or type field names first'), ...empty }
  if (matched.length === 0)
    return {
      ...refuse(
        `No field matches ${unmatched.slice(0, 3).join(', ')}${unmatched.length > 3 ? '…' : ''}`
      ),
      ...empty
    }
  const b = normalizedBundle(bundle)
  const spot = fieldSpot(b, selected, to)
  let w = b
  let index = spot.index
  const ops: LayoutOp[] = []
  const already: string[] = []
  const placed: string[] = []
  const failed: string[] = []
  for (const m of matched) {
    if (w.placements.some((p) => p.field === m.field && p.group_key === spot.group_key)) {
      already.push(label(m.field))
      continue
    }
    const op: LayoutOp = { op: 'place', field: m.field, group_key: spot.group_key, index }
    try {
      w = applyLayoutOps(w, [op])
      ops.push(op)
      placed.push(m.field)
      index++
    } catch (e) {
      failed.push(`${label(m.field)}: ${humanizeOpError((e as Error).message)}`)
    }
  }
  const where = sectionLabel(b.groups, spot.group_key)
  if (ops.length === 0)
    return {
      ...refuse(
        already.length
          ? `${already.join(', ')} ${already.length === 1 ? 'is' : 'are'} already in ${where}`
          : (failed[0] ?? 'Nothing to place')
      ),
      unmatched,
      already,
      placed
    }
  const notes: string[] = []
  if (already.length) notes.push(`Already in ${where}: ${already.join(', ')}`)
  if (unmatched.length) notes.push(`No field matches: ${unmatched.join(', ')}`)
  notes.push(...failed)
  const first = placed[0]
  return {
    ok: true,
    ops,
    label: `Place ${plural(placed.length, 'field')} in ${where}`,
    notes,
    select:
      spot.group_key === HEADER_GROUP_KEY
        ? { kind: 'header', field: first }
        : { kind: 'field', field: first, group_key: spot.group_key },
    unmatched,
    already,
    placed
  }
}
