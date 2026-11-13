/**
 * The quick-filter bar's stored shape (`nivaro_collections.browser_config.quick_filters`)
 * and the pure rules every editor of it shares: the list's in-place editor, the
 * Data model → Settings editor and anything else that writes the list.
 *
 * Normalizers here SPREAD each filter rather than rebuilding it, so a key this
 * UI does not know about (added by a later release or by hand in JSON) is never
 * dropped by a save — see gotchas "Parsers that rebuild config objects drop new keys".
 */

export interface QuickFilterDef {
  /** Unique key for this filter's selection state. People's picks, shared
   *  links and default-scope matching follow the key, not the label. */
  key: string
  label: string
  /** Server condition path — supports M2O chains and O2M/M2M alias hops
   *  (e.g. ['funding_years'], ['project', 'project_type']). */
  path: string[]
  /** When set, the selection matches if ANY of these paths hits (server _or
   *  group) — e.g. project.project_type OR car_project_type. Overrides path. */
  or_paths?: string[][]
  /** Collection the options list loads from. */
  collection: string
  /** Option value column (default 'id'). */
  value_field?: string
  /** Option label column. */
  label_field: string
  sort?: string
}

export const slugKey = (s: string): string =>
  s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')

/** `base`, or `base_2`, `base_3`… — whichever no other filter uses. */
export function uniqueKey(base: string, others: QuickFilterDef[]): string {
  const taken = new Set(others.map((f) => (f.key ?? '').trim()))
  const root = base || 'filter'
  if (!taken.has(root)) return root
  for (let i = 2; i < 1000; i++) if (!taken.has(`${root}_${i}`)) return `${root}_${i}`
  return `${root}_${Date.now()}`
}

const hasPath = (f: QuickFilterDef): boolean =>
  (f.path?.length ?? 0) > 0 || (!!f.or_paths?.length && f.or_paths.every((p) => p.length > 0))

/** What still stops this filter from working, in the words the editors show. */
export function quickFilterProblems(f: QuickFilterDef, all: QuickFilterDef[]): string[] {
  const out: string[] = []
  const key = (f.key ?? '').trim()
  if (!key) out.push('needs a key')
  else if (all.filter((o) => (o.key ?? '').trim() === key).length > 1) out.push('duplicate key')
  if (!f.label?.trim()) out.push('needs a name')
  if (!hasPath(f)) out.push('needs a field')
  if (!f.collection?.trim()) out.push('needs an options source')
  if (!f.label_field?.trim()) out.push('needs a column to show')
  return out
}

/**
 * The list as it is stored: complete filters only (a half-built one would draw
 * a dropdown that filters nothing), text trimmed, empty optional parts left
 * out. Every other key on a filter rides along untouched.
 */
export function cleanQuickFilters(list: QuickFilterDef[]): QuickFilterDef[] {
  const out: QuickFilterDef[] = []
  for (const raw of list ?? []) {
    if (!raw || typeof raw !== 'object') continue
    const f: QuickFilterDef = {
      ...raw,
      key: (raw.key ?? '').trim(),
      label: (raw.label ?? '').trim(),
      collection: (raw.collection ?? '').trim(),
      label_field: (raw.label_field ?? '').trim(),
      path: Array.isArray(raw.path) ? raw.path.filter(Boolean) : []
    }
    if (!f.value_field?.trim()) delete f.value_field
    if (!f.sort?.trim()) delete f.sort
    if (f.or_paths) {
      const paths = f.or_paths.filter((p) => Array.isArray(p) && p.length > 0)
      if (paths.length > 0) f.or_paths = paths
      else delete f.or_paths
    }
    if (quickFilterProblems(f, [f]).length > 0) continue
    out.push(f)
  }
  return out
}

/**
 * The collection's browser_config with `quick_filters` replaced and EVERY other
 * key kept — the PATCH route stores browser_config whole, so a save that
 * forgot one would wipe settings edited elsewhere. Null when nothing is left.
 */
export function mergeQuickFilters(
  browserConfig: Record<string, unknown> | null | undefined,
  next: QuickFilterDef[]
): Record<string, unknown> | null {
  const out: Record<string, unknown> = { ...(browserConfig ?? {}) }
  if (next.length > 0) out.quick_filters = next
  else delete out.quick_filters
  return Object.keys(out).length > 0 ? out : null
}

export function moveFilter<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= list.length || to < 0 || to >= list.length) return list
  const next = [...list]
  const [row] = next.splice(from, 1)
  next.splice(to, 0, row)
  return next
}

export function quickFiltersEqual(a: QuickFilterDef[], b: QuickFilterDef[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** The parts that decide what a pick MEANS: change one and old picks would filter something else. */
const meaningOf = (f: QuickFilterDef): string =>
  JSON.stringify([f.or_paths?.length ? f.or_paths : f.path, f.collection, f.value_field || 'id'])

/**
 * People's picks after the bar changed: a removed filter's picks go, and so do
 * picks of a filter that now reaches another field or other options. A rename,
 * a reorder or a new sort keeps them. Keys of filters this edit never held
 * (a host's own) are left alone.
 */
export function pruneQuickSelection<V>(
  sel: Record<string, V[]>,
  prev: QuickFilterDef[],
  next: QuickFilterDef[]
): Record<string, V[]> {
  const before = new Map(prev.map((f) => [f.key, meaningOf(f)]))
  const after = new Map(next.map((f) => [f.key, meaningOf(f)]))
  const out: Record<string, V[]> = {}
  for (const [k, v] of Object.entries(sel)) {
    if (before.has(k) && (!after.has(k) || after.get(k) !== before.get(k))) continue
    out[k] = v
  }
  return out
}
