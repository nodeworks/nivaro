/**
 * The restore drill's smoke check (#2801) — pure: the counts read from the live database and
 * from the restored copy → a verdict. The copy is a point in the past, so counts and checksums
 * that differ from the live database are expected (recorded, never judged). The verdict is only:
 * the restored database opened, every key table that exists live exists in the copy, and none
 * that holds rows live is empty in the copy.
 */

/** nivaro_* tables every instance has: counted (cheap, from sys.partitions) in both databases. */
export const KEY_TABLES = [
  'nivaro_collections',
  'nivaro_fields',
  'nivaro_relations',
  'nivaro_roles',
  'nivaro_policies',
  'nivaro_users',
  'nivaro_settings',
  'nivaro_migrations',
  'nivaro_workflow_templates',
  'nivaro_activity',
  'nivaro_revisions'
]

/** Small config tables whose whole content is checksummed in both databases. */
export const CHECKSUM_TABLES = [
  'nivaro_collections',
  'nivaro_relations',
  'nivaro_roles',
  'nivaro_migrations'
]

export interface TableCount {
  ref: string
  exists: boolean
  rows: number | null
}

export interface ChecksumRead {
  ref: string
  live: number | null
  restored: number | null
  /** Why a side could not be read, if it could not. */
  error?: string | null
}

export type TableVerdict = 'ok' | 'missing' | 'empty' | 'not_live'

export interface SmokeTable {
  ref: string
  live_rows: number | null
  restored_rows: number | null
  verdict: TableVerdict
  /** Rows differ from live (expected: the copy is older). */
  changed: boolean
}

export interface SmokeResult {
  passed: boolean
  opened: boolean
  tables: SmokeTable[]
  checksums: Array<ChecksumRead & { match: boolean | null }>
  failures: string[]
  /** One sentence for people. */
  summary: string
}

export function judgeSmoke(input: {
  opened: boolean
  openError?: string | null
  live: TableCount[]
  restored: TableCount[]
  checksums: ChecksumRead[]
}): SmokeResult {
  const failures: string[] = []
  if (!input.opened)
    failures.push(
      `The restored database did not open${input.openError ? `: ${input.openError}` : ''}`
    )
  const restored = new Map(input.restored.map((t) => [t.ref.toLowerCase(), t]))
  const tables: SmokeTable[] = input.live.map((l) => {
    const r = restored.get(l.ref.toLowerCase())
    const rRows = r?.exists ? r.rows : null
    let verdict: TableVerdict = 'ok'
    if (!l.exists) verdict = 'not_live'
    else if (!r?.exists) verdict = 'missing'
    else if ((l.rows ?? 0) > 0 && (rRows ?? 0) === 0) verdict = 'empty'
    if (input.opened && verdict === 'missing')
      failures.push(`${l.ref} is missing from the restored copy`)
    if (input.opened && verdict === 'empty')
      failures.push(`${l.ref} is empty in the restored copy but holds ${l.rows} rows live`)
    return {
      ref: l.ref,
      live_rows: l.exists ? l.rows : null,
      restored_rows: rRows,
      verdict,
      changed: l.exists && !!r?.exists && l.rows !== rRows
    }
  })
  const checksums = input.checksums.map((c) => ({
    ...c,
    match: c.live == null || c.restored == null ? null : c.live === c.restored
  }))
  const counted = tables.filter((t) => t.verdict !== 'not_live')
  const changed = counted.filter((t) => t.changed).length
  const passed = failures.length === 0
  const summary = passed
    ? `Restored copy opened; all ${counted.length} key tables present${
        changed
          ? ` (${changed} with fewer or more rows than live, as expected for an older copy)`
          : ''
      }.`
    : failures.slice(0, 3).join('; ')
  return { passed, opened: input.opened, tables, checksums, failures, summary }
}
