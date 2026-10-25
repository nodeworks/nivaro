import type { ActiveFilter } from '../CollectionBrowserView'

/**
 * The highlight-rule pills ("On hold", "Sent back", "Priority") are their own
 * list state, not filter chips, so "Save view" used to drop them: the saved view
 * reopened on every record. A view carries them as ONE `$at_risk` filter entry —
 * the client's filtersToConditions and the server's view compiler
 * (services/view-subscriptions.ts) both pass it through unchanged as
 * `{path: ['$at_risk'], op: '_eq', value: [ruleIds]}` (OR across rules), so view
 * counts, subscriptions and dashboard view widgets read the same rows.
 */
export const RISK_FILTER_ID = '__at_risk__'

const isRiskEntry = (f: ActiveFilter) => f.path.length === 1 && f.path[0] === '$at_risk'

/** The saved-view filter entry for the pressed pills (null when none). */
export function riskFilterEntry(
  ruleIds: number[],
  rules: Array<{ id: number; name: string }>
): ActiveFilter | null {
  if (ruleIds.length === 0) return null
  return {
    id: RISK_FILTER_ID,
    path: ['$at_risk'],
    pathLabels: ['Highlight'],
    fieldType: 'at_risk',
    op: '_eq',
    value: [...ruleIds],
    valueLabels: ruleIds.map((id) => rules.find((r) => r.id === id)?.name ?? String(id))
  }
}

/** A saved view's filters split back into chip filters and pressed pills. */
export function splitRiskFilter(filters: ActiveFilter[]): {
  filters: ActiveFilter[]
  riskIds: number[]
} {
  const riskIds: number[] = []
  const rest: ActiveFilter[] = []
  for (const f of filters) {
    if (!isRiskEntry(f)) {
      rest.push(f)
      continue
    }
    const raw = Array.isArray(f.value) ? f.value : [f.value]
    for (const v of raw) {
      const n = Number(v)
      if (Number.isFinite(n) && !riskIds.includes(n)) riskIds.push(n)
    }
  }
  return { filters: rest, riskIds }
}
