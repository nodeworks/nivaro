// Matching names someone typed (a pasted column list, #2616) or a block's
// fields from another collection (#2584 / #2594 / #2606) to this collection's
// fields: exact name, then the same words (case, spaces, _ and - ignored)
// against names and labels, then the closest spelling. Pure, so tested apart.

export interface MatchField {
  field: string
  label?: string | null
}

export type MatchHow = 'exact' | 'same' | 'label' | 'close'

export interface NameMatch {
  input: string
  field: string | null
  how: MatchHow | null
}

/** "Unit Price", "unit_price", "unit-price" and "UnitPrice" all read "unitprice". */
export const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

/** "UnitPrice", "unit_price", "Unit price" → ['unit', 'price']. */
const words = (s: string) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)

/** Edit distance, capped: anything past `max` is "too far". */
function distance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    let best = i
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
      best = Math.min(best, cur[j])
    }
    if (best > max) return max + 1
    prev = cur
  }
  return prev[b.length]
}

/**
 * The field each name matches, never one field twice (first come, first
 * served — the list's order wins). `exclude`: fields that may not be picked
 * (already used elsewhere).
 */
export function matchNames(
  names: string[],
  fields: MatchField[],
  exclude: Iterable<string> = []
): NameMatch[] {
  const used = new Set(exclude)
  const byName = new Map(fields.map((f) => [f.field, f]))
  const out: NameMatch[] = []
  const take = (input: string, field: string | null, how: MatchHow | null) => {
    if (field) used.add(field)
    out.push({ input, field, how: field ? how : null })
  }
  for (const raw of names) {
    const input = raw.trim()
    if (!input) continue
    const free = fields.filter((f) => !used.has(f.field))
    if (byName.has(input) && !used.has(input)) {
      take(input, input, 'exact')
      continue
    }
    const s = squash(input)
    const same = free.find((f) => squash(f.field) === s)
    if (same) {
      take(input, same.field, 'same')
      continue
    }
    const label = free.find((f) => f.label && squash(f.label) === s)
    if (label) {
      take(input, label.field, 'label')
      continue
    }
    // Closest spelling: a typo or two in a long name, one in a short one.
    const max = s.length >= 8 ? 2 : s.length >= 4 ? 1 : 0
    let best: { field: string; d: number } | null = null
    for (const f of free)
      for (const cand of [f.field, f.label ?? '']) {
        if (!cand) continue
        const d = distance(s, squash(cand), max)
        if (d <= max && (!best || d < best.d)) best = { field: f.field, d }
      }
    // Same words, fewer of them ("Price" → "Unit price"): only when exactly one field fits.
    if (!best) {
      const want = words(input)
      const fits = want.length
        ? free.filter((f) =>
            [f.field, f.label ?? ''].some((c) => {
              const have = new Set(words(c))
              return want.every((w) => have.has(w))
            })
          )
        : []
      if (fits.length === 1) best = { field: fits[0].field, d: 0 }
    }
    take(input, best?.field ?? null, best ? 'close' : null)
  }
  return out
}

/**
 * A pasted or uploaded list of field names: one per line, or separated by
 * commas, semicolons or tabs (a CSV header row works). Quotes are dropped and
 * repeats kept once, in their first place.
 */
export function parseFieldList(text: string): string[] {
  const parts = text
    .replace(/^﻿/, '')
    .split(/[\r\n,;\t]+/)
    .map((s) =>
      s
        .trim()
        .replace(/^["']|["']$/g, '')
        .trim()
    )
    .filter(Boolean)
  return [...new Set(parts)]
}

/**
 * A starting field map for a block from another collection: each source field
 * the target lacks gets its best match (or null: left out). Fields the target
 * has by the same name need no entry.
 */
export function suggestFieldMap(
  source: Array<string | MatchField>,
  target: MatchField[]
): Record<string, string | null> {
  const names = new Set(target.map((f) => f.field))
  const src = source.map((s) => (typeof s === 'string' ? { field: s } : s))
  const missing = src.filter((s) => !names.has(s.field))
  const taken = src.filter((s) => names.has(s.field)).map((s) => s.field)
  const matches = matchNames(
    missing.map((s) => s.field),
    target,
    taken
  )
  const map: Record<string, string | null> = {}
  missing.forEach((s, i) => {
    let m = matches[i]?.field ?? null
    // A source label can match where its name does not.
    if (!m && s.label)
      m =
        matchNames([s.label], target, [
          ...taken,
          ...(Object.values(map).filter(Boolean) as string[])
        ])[0]?.field ?? null
    map[s.field] = m
  })
  return map
}
