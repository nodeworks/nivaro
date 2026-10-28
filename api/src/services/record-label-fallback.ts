/**
 * What search shows for a record whose label is unknown. A primary key (`id`)
 * is a database detail and never visible text: a record is shown by its label
 * (display template / label columns, read as the viewer), else a business id
 * column the caller's row carries (workflow_id, cifa_number…), else the
 * collection's display name alone ("Inventory Request"). Ids stay in URLs,
 * keys and data attributes only.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const titleCase = (s: string) =>
  s
    .replace(/_/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase())

/** The collection's display name, else its key in title case. */
export function collectionTitle(collection: string, displayName?: string | null): string {
  const d = String(displayName ?? '').trim()
  return d || titleCase(collection) || 'Record'
}

/** A label that only restates the primary key: blank, "32832", "#32832", or a
 *  collection name + the pk ("Workflow 370973", "Cifa Items #39") — the shapes old
 *  fallbacks built. `names` are the collection's names (key, display name,
 *  singular; a plural's naive singular counts too); a label like "Zone 5" counts
 *  only when "Zone" is one of them. */
export function isPkLabel(label: unknown, id: unknown, names: readonly unknown[] = []): boolean {
  const l = String(label ?? '').trim()
  if (!l) return true
  const pk = String(id ?? '').trim()
  if (!pk) return false
  const norm = (v: unknown) =>
    String(v ?? '')
      .replace(/_/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase()
  const lower = norm(l)
  const p = pk.toLowerCase()
  if (lower === p || lower === `#${p}`) return true
  for (const n of names) {
    const full = norm(n)
    if (!full) continue
    // "workflows" → "Workflow 370973": a plural key with its naive singular too.
    for (const name of new Set([full, full.replace(/ies$/, 'y'), full.replace(/s$/, '')]))
      if (lower === `${name} ${p}` || lower === `${name} #${p}` || lower === `${name}#${p}`)
        return true
  }
  return false
}

/** The first business id among `columns` on the caller's row (never `id`, never a uuid). */
export function businessIdOf(
  row: Record<string, unknown> | null | undefined,
  columns: readonly string[]
): string | null {
  if (!row) return null
  for (const c of columns) {
    if (c === 'id') continue
    const v = row[c]
    if (v == null || typeof v === 'object') continue
    const s = String(v).trim()
    if (!s || UUID.test(s) || s === String(row.id ?? '')) continue
    return s
  }
  return null
}

/** `label` unless it is blank or only the pk; then a business id, then the collection name. */
export function safeRecordLabel(
  label: unknown,
  rec: {
    collection: string
    id: unknown
    display_name?: string | null
    row?: Record<string, unknown> | null
    columns?: readonly string[]
  }
): string {
  const names = [
    rec.collection,
    rec.display_name,
    collectionTitle(rec.collection, rec.display_name)
  ]
  if (!isPkLabel(label, rec.id, names)) return String(label).trim()
  return (
    businessIdOf(rec.row, rec.columns ?? []) ?? collectionTitle(rec.collection, rec.display_name)
  )
}
