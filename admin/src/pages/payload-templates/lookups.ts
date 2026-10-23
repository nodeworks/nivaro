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

// ─── Editing a template's own lookups (Data tab) ────────────────────────────

/** One lookup as the editor holds it: plain inputs, filter / expand as JSON text. */
export interface LookupRow {
  uid: string
  name: string
  collection: string
  filterText: string
  sort: string
  limit: string
  expandText: string
  /** Settings the editor has no input for (e.g. junction_filter), carried through untouched. */
  extra: Record<string, unknown>
}

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const SORT_RE = /^-?[A-Za-z_][A-Za-z0-9_]*$/
let uidSeq = 0
const nextUid = () => `lk${++uidSeq}`

export function emptyLookupRow(): LookupRow {
  return {
    uid: nextUid(),
    name: '',
    collection: '',
    filterText: '',
    sort: '',
    limit: '',
    expandText: '',
    extra: {}
  }
}

const jsonText = (v: unknown) => (v === undefined ? '' : JSON.stringify(v, null, 2))

export function rowsFromLookups(raw: unknown): LookupRow[] {
  if (!isObj(raw)) return []
  return Object.entries(raw).map(([name, d]) => {
    const def = isObj(d) ? d : {}
    const { collection, filter, sort, limit, expand, ...extra } = def
    return {
      uid: nextUid(),
      name,
      collection: typeof collection === 'string' ? collection : '',
      filterText: jsonText(filter),
      sort: typeof sort === 'string' ? sort : '',
      limit: limit === undefined ? '' : String(limit),
      expandText: jsonText(expand),
      extra
    }
  })
}

export type BuiltLookups = {
  value: Record<string, unknown> | null
  /** Per row uid: what is wrong with it, in words. */
  errors: Record<string, string[]>
}

function parseObject(
  text: string,
  what: string,
  errs: string[]
): Record<string, unknown> | undefined {
  if (!text.trim()) return undefined
  try {
    const v = JSON.parse(text)
    if (!isObj(v)) errs.push(`${what} must be a JSON object`)
    else return v
  } catch (e) {
    errs.push(`${what} isn't valid JSON (${e instanceof Error ? e.message : String(e)})`)
  }
  return undefined
}

/** The rows as the route's `lookups` (null when there are none), with the client-side errors. */
export function buildLookups(rows: LookupRow[]): BuiltLookups {
  const errors: Record<string, string[]> = {}
  const out: Record<string, unknown> = {}
  const seen = new Set<string>()
  for (const r of rows) {
    const errs: string[] = []
    const name = r.name.trim()
    if (!NAME_RE.test(name)) errs.push('Name: letters, digits and _, not starting with a digit')
    else if (seen.has(name)) errs.push(`Another lookup is already named ${name}`)
    seen.add(name)
    if (!r.collection) errs.push('Pick the collection it reads')
    const filter = parseObject(r.filterText, 'Filter', errs)
    const expand = parseObject(r.expandText, 'Expand', errs)
    const sort = r.sort.trim()
    if (sort && !SORT_RE.test(sort)) errs.push("Sort: a field name, '-' first for newest first")
    let limit: number | undefined
    if (r.limit.trim()) {
      limit = Number(r.limit)
      if (!Number.isInteger(limit) || limit < 1 || limit > 2000)
        errs.push('Limit: a whole number from 1 to 2000')
    }
    if (errs.length) errors[r.uid] = errs
    out[name] = {
      collection: r.collection,
      ...(filter ? { filter } : {}),
      ...r.extra,
      ...(sort ? { sort } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(expand ? { expand } : {})
    }
  }
  return { value: rows.length ? out : null, errors }
}
