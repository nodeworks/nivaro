// ─── Data lookups, described in plain words (Data tab) ──────────────────────
// Same shape as an erp_submit action's `context` (workflow-actions.ts
// ContextQueryDef): each named lookup reads rows of a collection.

export interface LookupDef {
  collection?: string
  filter?: Record<string, unknown>
  junction_filter?: { junction?: string; fk_to_row?: string; field?: string; value?: unknown }
  limit?: number
  expand?: Record<string, { collection?: string; fields?: string[] }>
  sort?: string
}

export interface LookupLine {
  name: string
  collection: string
  /** "where workflow = this record, status = $record.status" … */
  details: string[]
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

function filterValue(v: unknown): string {
  if (v === '$id') return 'this record'
  if (v === '$user') return 'the person who moved it'
  if (typeof v === 'string' && v.startsWith('$record.')) return `its ${v.slice(8)}`
  if (v === null) return 'empty'
  return JSON.stringify(v)
}

/** The lookups in a context/lookups object, each with plain-word details. */
export function describeLookups(raw: unknown): LookupLine[] {
  if (!isObj(raw)) return []
  const out: LookupLine[] = []
  for (const [name, d] of Object.entries(raw)) {
    if (!isObj(d)) continue
    const def = d as LookupDef
    const details: string[] = []
    const filters = Object.entries(def.filter ?? {}).map(([f, v]) => `${f} = ${filterValue(v)}`)
    if (filters.length) details.push(`where ${filters.join(', ')}`)
    const jf = def.junction_filter
    if (jf?.junction && jf.field)
      details.push(`linked through ${jf.junction} where ${jf.field} = ${filterValue(jf.value)}`)
    if (def.sort)
      details.push(
        def.sort.startsWith('-') ? `newest ${def.sort.slice(1)} first` : `sorted by ${def.sort}`
      )
    details.push(`up to ${Math.min(Number(def.limit ?? 500), 2000)} rows`)
    for (const [fk, exp] of Object.entries(def.expand ?? {})) {
      if (!exp?.collection) continue
      const fields = (exp.fields ?? []).join(', ')
      details.push(`adds ${fk}_data from ${exp.collection}${fields ? ` (${fields})` : ''}`)
    }
    out.push({ name, collection: String(def.collection ?? '?'), details })
  }
  return out
}

/** The erp_submit action on a transition that sends `key`, if any. */
export function findErpAction(
  actions: unknown,
  key: string
): { context?: Record<string, unknown> } | null {
  if (!Array.isArray(actions)) return null
  for (const a of actions) {
    if (isObj(a) && a.type === 'erp_submit' && a.payload_template_key === key)
      return a as { context?: Record<string, unknown> }
  }
  return null
}
