/**
 * Legacy retirement list (#721).
 *
 * After cutover the database still carries the old platform's tables
 * (directus_*), backup copies scripts left behind (zz_*, *_backup*, *_bak*),
 * staging scratch tables no import definition owns any more, and columns the
 * dead-column registry says are finished. This lists every one of them with
 * what a DBA needs before dropping it — size, last read / write since the
 * last restart, who still reads it (stored procedures and views, plus a
 * source scan where the source tree is present), foreign keys pointing at
 * it, whether it is a replication article, whether Nivaro still registers it
 * as a collection — and generates a drop script for the ones with nothing
 * in the way.
 *
 * It NEVER drops anything. The script is text for a DBA to review and run.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DEAD_COLUMNS } from '../db/dead-columns.js'
import { db } from '../db/index.js'

export type RetirementKind = 'legacy-platform' | 'backup' | 'staging' | 'dead-column'

export interface RetirementCandidate {
  kind: RetirementKind
  table: string
  column?: string
  rows: number | null
  size_mb: number | null
  last_read: string | null
  last_write: string | null
  /** Stored procedures / views / functions whose text names it. */
  sql_readers: string[]
  /** Source files that name it (only when the source tree is present). */
  source_readers: string[]
  /** Foreign keys from OTHER tables that point at it. */
  referenced_by: string[]
  replication_article: boolean
  registered_collection: boolean
  /** An import definition that still stages into this table. */
  import_definition: string | null
  /** Why it cannot be dropped as-is; empty = ready for the script. */
  blockers: string[]
  note?: string
}

export interface RetirementReport {
  candidates: RetirementCandidate[]
  totals: { candidates: number; ready: number; blocked: number; size_mb: number }
  source_scanned: boolean
  usage_since: string | null
  computed_at: string
}

/** A read or write inside this window means something still uses the table. */
const RECENT_DAYS = 7

const CANDIDATE_SQL = `
  SELECT t.name,
         SUM(CASE WHEN ps.index_id IN (0, 1) THEN ps.row_count ELSE 0 END) AS row_count,
         CAST(SUM(ps.used_page_count) * 8.0 / 1024 AS decimal(12,2)) AS size_mb,
         MAX(COALESCE(us.last_user_seek, us.last_user_scan, us.last_user_lookup)) AS last_read,
         MAX(us.last_user_update) AS last_write
    FROM sys.tables t
    LEFT JOIN sys.dm_db_partition_stats ps ON ps.object_id = t.object_id
    LEFT JOIN sys.dm_db_index_usage_stats us ON us.object_id = t.object_id AND us.database_id = DB_ID()
   WHERE t.is_ms_shipped = 0
     AND (t.name LIKE 'directus[_]%' OR t.name LIKE 'zz[_]%' OR t.name LIKE '%[_]backup%'
          OR t.name LIKE '%[_]bak%' OR t.name LIKE 'staging[_]%')
   GROUP BY t.name`

function kindOf(name: string): RetirementKind {
  if (name.startsWith('directus_')) return 'legacy-platform'
  if (name.startsWith('staging_')) return 'staging'
  return 'backup'
}

/** Source roots scanned for table names (dev only — an image has no source). */
function sourceRoots(): { root: string; dirs: string[] } {
  const here = resolve(process.cwd())
  const root = existsSync(join(here, 'api', 'src')) ? here : resolve(here, '..')
  return {
    root,
    dirs: ['api/src', 'api/extensions', 'packages/shared/src', 'admin/src']
      .map((d) => join(root, d))
      .filter((d) => existsSync(d))
  }
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx|mjs|js|sql)$/.test(name) && !/\/migrations\//.test(p)) out.push(p)
  }
  return out
}

export async function legacyRetirement(): Promise<RetirementReport> {
  const tables = (await db.raw(CANDIDATE_SQL)) as Array<{
    name: string
    row_count: number | null
    size_mb: number | null
    last_read: Date | null
    last_write: Date | null
  }>

  // Every module's text once; each candidate is a word-boundary search.
  const modules = (await db.raw(`
    SELECT o.name, o.type_desc, m.definition
      FROM sys.sql_modules m JOIN sys.objects o ON o.object_id = m.object_id`)) as Array<{
    name: string
    type_desc: string
    definition: string | null
  }>

  const fks = (await db.raw(`
    SELECT rt.name AS referenced, pt.name AS parent, fk.name AS fk
      FROM sys.foreign_keys fk
      JOIN sys.tables rt ON rt.object_id = fk.referenced_object_id
      JOIN sys.tables pt ON pt.object_id = fk.parent_object_id
     WHERE rt.object_id <> pt.object_id`)) as Array<{
    referenced: string
    parent: string
    fk: string
  }>

  let articles = new Set<string>()
  try {
    const rows = (await db.raw(
      `IF OBJECT_ID('dbo.sysarticles') IS NOT NULL SELECT name FROM dbo.sysarticles ELSE SELECT CAST(NULL AS sysname) AS name WHERE 1 = 0`
    )) as Array<{ name: string }>
    articles = new Set(rows.map((r) => r.name.toLowerCase()))
  } catch {
    // not a publisher
  }

  const collections = new Set(
    ((await db('nivaro_collections').pluck('collection')) as string[]).map((c) => c.toLowerCase())
  )
  const stagingOwners = new Map<string, string>()
  try {
    const defs = (await db('nivaro_import_definitions').select(
      'key',
      'staging_table',
      'is_active'
    )) as Array<{
      key: string
      staging_table: string | null
      is_active: boolean | number
    }>
    for (const d of defs)
      if (d.staging_table && d.is_active) stagingOwners.set(d.staging_table.toLowerCase(), d.key)
  } catch {
    // no import definitions table
  }

  const { root, dirs: roots } = sourceRoots()
  const files = roots.flatMap((r) => walk(r))
  const fileText = new Map<string, string>()
  const textOf = (f: string) => {
    let t = fileText.get(f)
    if (t === undefined) {
      t = readFileSync(f, 'utf8')
      fileText.set(f, t)
    }
    return t
  }
  const rel = (f: string) => f.slice(root.length + 1)

  const readersOf = (name: string) => {
    const re = new RegExp(`(^|[^A-Za-z0-9_])${name}([^A-Za-z0-9_]|$)`, 'i')
    return {
      sql: modules.filter((m) => m.definition && re.test(m.definition)).map((m) => m.name),
      source: files.filter((f) => re.test(textOf(f))).map(rel)
    }
  }

  const candidates: RetirementCandidate[] = []
  for (const t of tables) {
    const lower = t.name.toLowerCase()
    const readers = readersOf(t.name)
    const referenced_by = fks
      .filter((f) => f.referenced.toLowerCase() === lower)
      .map((f) => `${f.parent} (${f.fk})`)
    const c: RetirementCandidate = {
      kind: kindOf(lower),
      table: t.name,
      rows: t.row_count == null ? null : Number(t.row_count),
      size_mb: t.size_mb == null ? null : Number(t.size_mb),
      last_read: t.last_read ? new Date(t.last_read).toISOString() : null,
      last_write: t.last_write ? new Date(t.last_write).toISOString() : null,
      sql_readers: readers.sql.slice(0, 25),
      source_readers: readers.source.slice(0, 25),
      referenced_by,
      replication_article: articles.has(lower),
      registered_collection: collections.has(lower),
      import_definition: stagingOwners.get(lower) ?? null,
      blockers: []
    }
    if (c.import_definition)
      c.blockers.push(`import definition ${c.import_definition} stages into it`)
    if (c.registered_collection)
      c.blockers.push('registered as a Nivaro collection — unregister it first')
    if (c.referenced_by.length)
      c.blockers.push(`${c.referenced_by.length} foreign key(s) point at it`)
    if (c.sql_readers.length)
      c.blockers.push(`${c.sql_readers.length} procedure(s)/view(s) name it`)
    if (c.source_readers.length)
      c.blockers.push(`${c.source_readers.length} source file(s) name it`)
    if (c.replication_article)
      c.blockers.push('replication article — the DBA drops it from the publication first')
    // Still in use by something this inventory cannot see (the legacy
    // platform itself, a DBA job, an ad-hoc report).
    const recent = Date.now() - RECENT_DAYS * 86_400_000
    if (c.last_write && Date.parse(c.last_write) > recent)
      c.blockers.push(`written ${c.last_write.slice(0, 10)} — something still writes it`)
    else if (c.last_read && Date.parse(c.last_read) > recent)
      c.blockers.push(`read ${c.last_read.slice(0, 10)} — something still reads it`)
    candidates.push(c)
  }

  // Dead columns the registry says are finished (status drop) and still present.
  for (const d of DEAD_COLUMNS) {
    if (d.status !== 'drop') continue
    const present = await db.schema.hasColumn(d.table, d.column).catch(() => false)
    if (!present) continue
    const colReaders = readersOf(d.column).sql
    const tableReaders = new Set(readersOf(d.table).sql)
    const c: RetirementCandidate = {
      kind: 'dead-column',
      table: d.table,
      column: d.column,
      rows: null,
      size_mb: null,
      last_read: null,
      last_write: null,
      // A module naming both the table and the column most likely reads it.
      sql_readers: colReaders.filter((n) => tableReaders.has(n)).slice(0, 25),
      source_readers: [],
      referenced_by: [],
      replication_article: articles.has(d.table.toLowerCase()),
      registered_collection: false,
      import_definition: null,
      blockers: [],
      note: `dead since ${d.since}${d.dropped_by ? `; ${d.dropped_by} drops it` : ''}`
    }
    if (c.sql_readers.length)
      c.blockers.push(`${c.sql_readers.length} procedure(s) name the column`)
    if (c.replication_article) c.blockers.push('column of a replication article')
    candidates.push(c)
  }

  const order: Record<RetirementKind, number> = {
    'legacy-platform': 0,
    backup: 1,
    staging: 2,
    'dead-column': 3
  }
  candidates.sort(
    (a, b) =>
      Number(a.blockers.length > 0) - Number(b.blockers.length > 0) ||
      order[a.kind] - order[b.kind] ||
      (b.size_mb ?? 0) - (a.size_mb ?? 0)
  )
  const since = (await db
    .raw(`SELECT sqlserver_start_time AS t FROM sys.dm_os_sys_info`)
    .catch(() => [])) as Array<{ t: Date }>
  return {
    candidates,
    totals: {
      candidates: candidates.length,
      ready: candidates.filter((c) => c.blockers.length === 0).length,
      blocked: candidates.filter((c) => c.blockers.length > 0).length,
      size_mb: Math.round(candidates.reduce((n, c) => n + (c.size_mb ?? 0), 0) * 100) / 100
    },
    source_scanned: roots.length > 0,
    usage_since: since[0]?.t ? new Date(since[0].t).toISOString() : null,
    computed_at: new Date().toISOString()
  }
}

/** A drop script for a DBA — ready candidates as statements, blocked ones as comments. */
export function retirementScript(report: RetirementReport, database: string): string {
  const q = (s: string) => `[${s.replace(/]/g, ']]')}]`
  const lines = [
    `-- Nivaro legacy retirement script, generated ${report.computed_at}`,
    `-- Database: ${database}. Generated for review — Nivaro never runs it.`,
    `-- Usage figures are since the last SQL Server restart (${report.usage_since ?? 'unknown'}).`,
    `-- Take a backup first. Each DROP is its own batch.`,
    ''
  ]
  const ready = report.candidates.filter((c) => c.blockers.length === 0)
  const blocked = report.candidates.filter((c) => c.blockers.length > 0)
  for (const c of ready) {
    const facts = [
      c.rows != null ? `${c.rows.toLocaleString()} rows` : null,
      c.size_mb != null ? `${c.size_mb} MB` : null,
      `last write ${c.last_write ?? 'none since restart'}`
    ]
      .filter(Boolean)
      .join(', ')
    if (c.kind === 'dead-column' && c.column) {
      lines.push(`-- ${c.table}.${c.column} (${c.note ?? 'dead column'})`)
      lines.push(
        `DECLARE @dc sysname = (SELECT dc.name FROM sys.default_constraints dc JOIN sys.columns col ON col.object_id = dc.parent_object_id AND col.column_id = dc.parent_column_id WHERE dc.parent_object_id = OBJECT_ID('${c.table}') AND col.name = '${c.column}');`
      )
      lines.push(
        `IF @dc IS NOT NULL EXEC('ALTER TABLE ${q(c.table)} DROP CONSTRAINT [' + @dc + ']');`
      )
      lines.push(`ALTER TABLE ${q(c.table)} DROP COLUMN ${q(c.column)};`, 'GO', '')
    } else {
      lines.push(`-- ${c.table} (${c.kind}; ${facts})`)
      lines.push(`DROP TABLE ${q(c.table)};`, 'GO', '')
    }
  }
  if (blocked.length) {
    lines.push('-- ─── Not ready: each needs the blocker cleared first ───', '')
    for (const c of blocked) {
      lines.push(`-- ${c.column ? `${c.table}.${c.column}` : c.table}: ${c.blockers.join('; ')}`)
    }
  }
  return `${lines.join('\n')}\n`
}
