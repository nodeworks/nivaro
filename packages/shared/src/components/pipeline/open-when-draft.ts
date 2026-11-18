import type { ConditionRule, OpenWhen } from './types'

/**
 * The transition editor's "Anyone can make this move when…" draft (migration
 * 533, api services/transition-open-when.ts). Per collection the editor holds
 * one of three plain choices, so "no entry" and "an empty list" can never be
 * mistaken for each other:
 *   owner  — no entry: only the step's owner (today's rule)
 *   anyone — an empty list: anyone who can otherwise make the move, always
 *   when   — rules: anyone, while every rule holds for the record
 * With no collection known (an unbound template) there is one draft under
 * ALL, saved as a plain rule list (which applies to every collection).
 */
export type OpenWhenMode = 'owner' | 'anyone' | 'when'
export type OpenWhenDraft = Record<string, { mode: OpenWhenMode; rules: ConditionRule[] }>
export const ALL_COLLECTIONS = '*'

const NO_VALUE_OPS = new Set(['null', 'nnull', 'related_some', 'related_none'])

/** A rule the server can use: a field, and a value unless the op needs none. */
export function ruleComplete(r: ConditionRule): boolean {
  if (!r.field?.trim()) return false
  if (NO_VALUE_OPS.has(r.op)) return true
  return r.value != null && String(r.value).trim() !== ''
}

export function draftFromOpenWhen(
  value: OpenWhen | undefined,
  collections: string[]
): OpenWhenDraft {
  const keys = collections.length > 0 ? collections : [ALL_COLLECTIONS]
  const draft: OpenWhenDraft = {}
  if (Array.isArray(value)) {
    for (const k of keys)
      draft[k] =
        value.length > 0 ? { mode: 'when', rules: [...value] } : { mode: 'owner', rules: [] }
    return draft
  }
  const map = value && typeof value === 'object' ? value : {}
  const find = (c: string) => Object.keys(map).find((k) => k.toLowerCase() === c.toLowerCase())
  for (const k of keys) {
    const hit = k === ALL_COLLECTIONS ? undefined : find(k)
    const list = hit !== undefined ? map[hit] : undefined
    draft[k] = !Array.isArray(list)
      ? { mode: 'owner', rules: [] }
      : list.length === 0
        ? { mode: 'anyone', rules: [] }
        : { mode: 'when', rules: [...list] }
  }
  // A stored entry for a collection the template no longer lists is kept as it is.
  for (const [k, list] of Object.entries(map)) {
    if (keys.some((c) => c.toLowerCase() === k.toLowerCase()) || !Array.isArray(list)) continue
    draft[k] =
      list.length === 0 ? { mode: 'anyone', rules: [] } : { mode: 'when', rules: [...list] }
  }
  return draft
}

/** The stored value: per collection, only complete rules; "when" with none → owner (fail closed). */
export function openWhenFromDraft(draft: OpenWhenDraft): OpenWhen {
  const keys = Object.keys(draft)
  if (keys.length === 1 && keys[0] === ALL_COLLECTIONS) {
    const d = draft[ALL_COLLECTIONS]
    const rules = d.mode === 'when' ? d.rules.filter(ruleComplete) : []
    return rules.length > 0 ? rules : null
  }
  const out: Record<string, ConditionRule[]> = {}
  for (const k of keys) {
    if (k === ALL_COLLECTIONS) continue
    const d = draft[k]
    if (d.mode === 'anyone') out[k] = []
    else if (d.mode === 'when') {
      const rules = d.rules.filter(ruleComplete)
      if (rules.length > 0) out[k] = rules
    }
  }
  return Object.keys(out).length > 0 ? out : null
}

/** Collections set to "When…" without one complete rule (Save waits on them). */
export function incompleteOpenWhen(draft: OpenWhenDraft): string[] {
  return Object.entries(draft)
    .filter(([, d]) => d.mode === 'when' && !d.rules.some(ruleComplete))
    .map(([k]) => k)
}
