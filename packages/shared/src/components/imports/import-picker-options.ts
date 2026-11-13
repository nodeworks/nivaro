/**
 * Options for the collection import's two pickers (Rob 2026-11-13: they listed every raw
 * table and field name). People pick by name: a collection by its display name, grouped by
 * the same folders as the Collections page; a field by its label. Junk stays out — system
 * tables, folder rows, link tables, hidden collections; fields that cannot take a value
 * (hidden, read-only, calculated, automatic stamps, one-to-many lists).
 */

export interface PickOption {
  value: string
  /** What a person reads. */
  label: string
  /** The technical name, shown small (and searched). */
  hint?: string
  /** Heading the option sits under. */
  group?: string
}

export interface ImportCollectionRow {
  collection: string
  display_name?: string | null
  plural?: string | null
  hidden?: boolean | null
  singleton?: boolean | null
  group?: string | null
  sort?: number | null
}

export interface ImportFieldRow {
  field: string
  type?: string | null
  interface?: string | null
  hidden?: boolean | null
  readonly?: boolean | null
  special?: string[] | string | null
  computed_type?: string | null
  sort?: number | null
}

export const titleCase = (s: string) =>
  s
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (m) => m.toUpperCase())

const SYSTEM = /^(nivaro_|directus_)/i

export const collectionName = (
  r: Pick<ImportCollectionRow, 'collection' | 'display_name' | 'plural'>
) => (r.display_name || r.plural || '').trim() || titleCase(r.collection)

/**
 * Pickable collections, in folders (folder order, then A–Z inside), then "Other". `links` =
 * collections known to be link tables (from /collections/overview-stats, when available).
 * The current value always stays pickable, whatever it is.
 */
export function collectionPickerOptions(
  rows: ImportCollectionRow[],
  links: Set<string> = new Set(),
  current = ''
): PickOption[] {
  const usable = rows.filter((r) => r?.collection && !SYSTEM.test(r.collection))
  const folderNames = new Set(usable.map((r) => r.group).filter((g): g is string => !!g))
  const folders = new Map(
    usable.filter((r) => folderNames.has(r.collection)).map((r) => [r.collection, r])
  )
  const keep = (r: ImportCollectionRow) =>
    r.collection === current ||
    (!folderNames.has(r.collection) && !r.hidden && !r.singleton && !links.has(r.collection))
  const folderLabel = (key: string | null | undefined) =>
    key && folderNames.has(key) ? collectionName(folders.get(key) ?? { collection: key }) : 'Other'
  const folderSort = (key: string) => folders.get(key)?.sort ?? 9999
  const order = [...folderNames].sort(
    (a, b) => folderSort(a) - folderSort(b) || folderLabel(a).localeCompare(folderLabel(b))
  )
  const rank = new Map(order.map((k, i) => [k, i]))
  return usable
    .filter(keep)
    .map((r) => ({
      value: r.collection,
      label: collectionName(r),
      hint: r.collection,
      group: folderLabel(r.group),
      _rank: r.group && rank.has(r.group) ? (rank.get(r.group) as number) : 1e6
    }))
    .sort((a, b) => a._rank - b._rank || a.label.localeCompare(b.label))
    .map(({ _rank, ...o }) => o)
}

const specialsOf = (f: ImportFieldRow): string[] =>
  (Array.isArray(f.special) ? f.special : String(f.special ?? '').split(','))
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)

const AUTOMATIC = new Set(['user-created', 'user-updated', 'date-created', 'date-updated', 'uuid'])

/** What kind of value a field takes, for the hint ("links several", "date"). */
function fieldKind(f: ImportFieldRow): string {
  const sp = specialsOf(f)
  const iface = String(f.interface ?? '').toLowerCase()
  if (sp.includes('m2m') || iface.includes('m2m')) return 'links several'
  if (sp.includes('m2o') || iface.includes('m2o')) return 'link'
  if (sp.includes('cast-boolean') || f.type === 'boolean') return 'yes / no'
  if (/date|time/.test(String(f.type ?? ''))) return 'date'
  if (/integer|decimal|float|bigint/.test(String(f.type ?? ''))) return 'number'
  return ''
}

/**
 * Fields a file can fill, by label in form order. Out: hidden, read-only, calculated,
 * automatic stamps (created/updated by/at), one-to-many lists (they are their own rows).
 * `id` stays when shown — an import can match on it. The current value always stays.
 */
export function fieldPickerOptions(fields: ImportFieldRow[], current = ''): PickOption[] {
  return fields
    .filter((f) => {
      if (!f?.field) return false
      if (f.field === current) return true
      const sp = specialsOf(f)
      const iface = String(f.interface ?? '').toLowerCase()
      if (f.hidden || f.readonly || f.computed_type) return false
      if (sp.some((s) => AUTOMATIC.has(s))) return false
      if (sp.includes('o2m') || iface.includes('o2m')) return false
      if (sp.includes('alias') && !sp.includes('m2m')) return false
      return true
    })
    .map((f, i) => ({ f, i }))
    .sort((a, b) => (a.f.sort ?? 1e6) - (b.f.sort ?? 1e6) || a.i - b.i)
    .map(({ f }) => {
      const kind = fieldKind(f)
      return {
        value: f.field,
        label: titleCase(f.field),
        hint: kind ? `${f.field} · ${kind}` : f.field
      }
    })
}
