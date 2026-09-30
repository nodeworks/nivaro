import { db } from '../db/index.js'
import { logActivity } from './activity.js'
import { type ImportDefinition, listImportDefinitions, lockGroupOf } from './staged-imports.js'

/**
 * #846 — staging tables hold the last file forever: a 2M-row invoice sheet
 * sits there long after the procedure consumed it. OPT-IN per definition: a
 * staging table is emptied `staging_purge_days` after its newest completed
 * run only when a definition sets a window (NULL or 0 = keep — the default,
 * because diagnostics such as re-running a procedure over the persisted
 * staging rows read those tables). Never while a run of the same lock group
 * is queued or running. Several definitions may share one table: the table is
 * purged only when EVERY definition that uses it has a window and is due (the
 * longest window wins; one that keeps it keeps it).
 */
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

export interface StagingTableInfo {
  table: string
  exists: boolean
  rows: number
  size_kb: number
  definitions: Array<{ id: number; key: string; label: string | null }>
  purge_days: number
  last_completed_at: string | null
  purge_due_at: string | null
  purged_at: string | null
  /** A run of the table's group is queued or running now. */
  busy: boolean
  /** Why it is not purged (yet), in words. */
  reason: string
}

const tableOf = (d: ImportDefinition): string => d.staging_table || `staging_${d.key}`
const daysOf = (d: ImportDefinition): number =>
  d.staging_purge_days == null ? 0 : Math.max(0, Number(d.staging_purge_days) || 0)

async function tableSizes(tables: string[]): Promise<Map<string, { rows: number; kb: number }>> {
  const out = new Map<string, { rows: number; kb: number }>()
  if (tables.length === 0) return out
  const rows = (await db.raw(
    `SELECT t.name AS name,
            SUM(CASE WHEN p.index_id IN (0, 1) THEN p.row_count ELSE 0 END) AS row_count,
            SUM(p.reserved_page_count) * 8 AS kb
       FROM sys.tables t
       JOIN sys.dm_db_partition_stats p ON p.object_id = t.object_id
      WHERE t.name IN (${tables.map(() => '?').join(', ')})
      GROUP BY t.name`,
    tables
  )) as Array<{ name: string; row_count: number; kb: number }>
  for (const r of rows) {
    out.set(String(r.name).toLowerCase(), { rows: Number(r.row_count ?? 0), kb: Number(r.kb ?? 0) })
  }
  return out
}

export async function describeStagingTables(): Promise<StagingTableInfo[]> {
  const defs = (await listImportDefinitions(false)).filter((d) => IDENT.test(tableOf(d)))
  const byTable = new Map<string, ImportDefinition[]>()
  for (const d of defs) {
    const t = tableOf(d)
    const list = byTable.get(t.toLowerCase()) ?? []
    list.push(d)
    byTable.set(t.toLowerCase(), list)
  }
  const tables = [...byTable.values()].map((l) => tableOf(l[0]))
  const sizes = await tableSizes(tables)

  const keys = defs.map((d) => d.key)
  const lastDone = keys.length
    ? ((await db('nivaro_import_queue')
        .whereIn('import_key', keys)
        .where('status', 'completed')
        .groupBy('import_key')
        .select('import_key')
        .max({ at: 'finished_at' })) as Array<{ import_key: string; at: Date | null }>)
    : []
  const lastByKey = new Map(lastDone.map((r) => [String(r.import_key).toLowerCase(), r.at]))
  const active = keys.length
    ? ((await db('nivaro_import_queue')
        .whereIn('status', ['queued', 'running'])
        .distinct('import_key')) as Array<{ import_key: string }>)
    : []
  const busyGroups = new Set(
    active
      .map((r) => defs.find((d) => d.key.toLowerCase() === String(r.import_key).toLowerCase()))
      .filter((d): d is ImportDefinition => !!d)
      .map((d) => lockGroupOf(d))
  )

  const now = Date.now()
  const out: StagingTableInfo[] = []
  for (const list of byTable.values()) {
    const table = tableOf(list[0])
    const size = sizes.get(table.toLowerCase())
    const keep = list.some((d) => daysOf(d) === 0)
    const days = Math.max(...list.map(daysOf))
    const lasts = list
      .map((d) => lastByKey.get(d.key.toLowerCase()))
      .filter((x): x is Date => !!x)
      .map((x) => new Date(x).getTime())
    const last = lasts.length ? Math.max(...lasts) : null
    const due = !keep && last != null ? last + days * 86_400_000 : null
    const busy = list.some((d) => busyGroups.has(lockGroupOf(d)))
    const purgedAt = list
      .map((d) => d.staging_purged_at)
      .filter(Boolean)
      .map((x) => new Date(x as string).getTime())
    const rows = size?.rows ?? 0
    let reason: string
    if (!size) reason = 'The table does not exist yet.'
    else if (keep) reason = 'Kept — no purge window set.'
    else if (rows === 0) reason = 'Empty.'
    else if (last == null) reason = 'No completed run yet.'
    else if (busy) reason = 'A run is queued or running.'
    else if (due != null && due > now)
      reason = `Empties ${new Date(due).toISOString().slice(0, 10)}.`
    else reason = 'Due now.'
    out.push({
      table,
      exists: !!size,
      rows,
      size_kb: size?.kb ?? 0,
      definitions: list.map((d) => ({ id: d.id, key: d.key, label: d.label })),
      purge_days: keep ? 0 : days,
      last_completed_at: last != null ? new Date(last).toISOString() : null,
      purge_due_at: due != null ? new Date(due).toISOString() : null,
      purged_at: purgedAt.length ? new Date(Math.max(...purgedAt)).toISOString() : null,
      busy,
      reason
    })
  }
  return out.sort((a, b) => b.size_kb - a.size_kb)
}

/** Empty one staging table. TRUNCATE when the login may, DELETE otherwise. */
async function emptyTable(table: string): Promise<void> {
  if (!IDENT.test(table)) throw new Error(`Unsafe staging table name: ${table}`)
  try {
    await db.raw(`TRUNCATE TABLE [${table}]`)
  } catch {
    await db(table).del()
  }
}

export async function purgeStagingTable(
  info: StagingTableInfo,
  userId: string | null,
  why: string
): Promise<void> {
  await emptyTable(info.table)
  await db('nivaro_import_definitions')
    .whereIn(
      'id',
      info.definitions.map((d) => d.id)
    )
    .update({ staging_purged_at: new Date() })
  await logActivity({
    action: 'import-staging-purge',
    user: userId,
    collection: 'nivaro_import_definitions',
    item: info.definitions.map((d) => d.key).join(','),
    comment: `${info.table}: ${info.rows.toLocaleString()} rows (${Math.round(info.size_kb / 1024)} MB) — ${why}`
  })
}

/** The daily sweep. `dryRun` reports what would be emptied. */
export async function runStagingPurge(opts: { dryRun?: boolean } = {}): Promise<{
  purged: Array<{ table: string; rows: number; size_kb: number }>
}> {
  const infos = await describeStagingTables()
  const now = Date.now()
  const due = infos.filter(
    (i) =>
      i.exists &&
      i.rows > 0 &&
      i.purge_days > 0 &&
      !i.busy &&
      i.purge_due_at != null &&
      new Date(i.purge_due_at).getTime() <= now
  )
  const purged: Array<{ table: string; rows: number; size_kb: number }> = []
  for (const info of due) {
    if (!opts.dryRun) {
      // Re-check right before emptying: a run may have been queued since.
      const fresh = (await describeStagingTables()).find((x) => x.table === info.table)
      if (!fresh || fresh.busy) continue
      await purgeStagingTable(info, null, `${info.purge_days} days after the last completed run`)
    }
    purged.push({ table: info.table, rows: info.rows, size_kb: info.size_kb })
  }
  return { purged }
}
