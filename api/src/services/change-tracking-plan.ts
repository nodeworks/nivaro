import { COLUMN_TRACKED, SYSTEM_TABLES } from './outside-write-system.js'

/** What change-tracking-setup.ts would track (pure; kept out of the script so tests can import it). */

const SYSTEM = /^(nivaro_|directus_|sysdiagrams$)/i

export interface TablePlan {
  collection: string
  action: 'enable' | 'skip'
  reason?: 'not-table' | 'no-pk' | 'tracked'
  /** TRACK_COLUMNS_UPDATED = ON (system tables whose changed columns matter). */
  columns?: boolean
  system?: boolean
}

/**
 * The system allowlist plus the file-link junctions, planned like collections (pure). Only
 * names on the allowlist or found as a junction to the files table are ever planned.
 */
export function planSystemTables(
  junctions: string[],
  tables: Map<string, { pk: boolean; tracked: boolean }>
): TablePlan[] {
  const names = [...new Set([...SYSTEM_TABLES, ...junctions])]
  return names.map((name) => {
    const t = tables.get(name.toLowerCase())
    const base = { collection: name, system: true, columns: COLUMN_TRACKED.has(name) }
    if (!t) return { ...base, action: 'skip', reason: 'not-table' } as TablePlan
    if (t.tracked) return { ...base, action: 'skip', reason: 'tracked' } as TablePlan
    if (!t.pk) return { ...base, action: 'skip', reason: 'no-pk' } as TablePlan
    return { ...base, action: 'enable' } as TablePlan
  })
}

/** Junction tables with a leg to the files table (pure; from nivaro_relations rows). */
export function fileJunctions(
  rels: Array<{
    many_collection?: string | null
    one_collection?: string | null
    junction_field?: string | null
  }>
): string[] {
  const out = new Set<string>()
  for (const r of rels)
    if (
      r.junction_field &&
      r.many_collection &&
      /^(nivaro_files|directus_files)$/i.test(r.one_collection ?? '')
    )
      out.add(r.many_collection)
  return [...out].sort()
}

/** What to do with each registered collection (pure). */
export function planTables(
  collections: string[],
  tables: Map<string, { pk: boolean; tracked: boolean }>
): TablePlan[] {
  const seen = new Set<string>()
  const out: TablePlan[] = []
  for (const c of collections) {
    const k = c.toLowerCase()
    if (!c || SYSTEM.test(c) || seen.has(k)) continue
    seen.add(k)
    const t = tables.get(k)
    if (!t) out.push({ collection: c, action: 'skip', reason: 'not-table' })
    else if (t.tracked) out.push({ collection: c, action: 'skip', reason: 'tracked' })
    else if (!t.pk) out.push({ collection: c, action: 'skip', reason: 'no-pk' })
    else out.push({ collection: c, action: 'enable' })
  }
  return out
}
