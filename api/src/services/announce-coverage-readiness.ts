import { isMssql } from '../db/dialect.js'
import { db } from '../db/index.js'
import { type ReadinessResult, registerReadinessCheck } from './readiness.js'

/**
 * Readiness `announce-coverage` (realtime): how much of what the database writes reaches open
 * screens. Writes through the app tell every open screen at once; a procedure that writes a
 * registered collection without calling nivaro_announce_writes leaves those screens stale until
 * the outside-write watcher (the safety net) happens to catch the rows — or someone reloads.
 *
 * Two inputs, both already collected elsewhere:
 *   - the SQL checks' open "Writes without announcing" findings (`write-unannounced`), one per
 *     procedure + collection. When the SQL checks have no finished run in the last week (they
 *     are off by default), the same check runs here over sys.sql_modules — procedures only.
 *   - the outside-write watcher's "rows caught in 24 h" per collection (Redis, else this process).
 *
 * Warn level only: stale screens are a nuisance, never a blocker for a deploy.
 */

/** A finished SQL checks run younger than this is trusted; older → the live read. */
export const FINDINGS_FRESH_MS = 7 * 86_400_000
const MAX_BLOCKERS = 20
const MAX_NAMES = 3

export interface UnannouncedCollection {
  /** The registered collection, in its registered spelling. */
  collection: string
  /** Procedures (schema.name) that write it without announcing. */
  procedures: string[]
}

export interface AnnounceCoverageInput {
  unannounced: UnannouncedCollection[]
  /** Where the procedure list came from: the stored SQL check findings, or a read just now. */
  source: 'sql-checks' | 'live-scan' | 'none'
  /** Lower-cased collection → rows the watcher caught in the last 24 hours. */
  caught: Record<string, number>
  /** The outside-write watcher is running somewhere (or ran in the last day). */
  watcherSeen: boolean
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

function names(list: string[]): string {
  const shown = list.slice(0, MAX_NAMES).join(', ')
  return list.length > MAX_NAMES ? `${shown} and ${list.length - MAX_NAMES} more` : shown
}

/** The verdict from what was collected (pure; exported for tests). */
export function judgeAnnounceCoverage(input: AnnounceCoverageInput): ReadinessResult {
  const byKey = new Map<string, { label: string; procedures: string[]; caught: number }>()
  for (const u of input.unannounced) {
    const key = u.collection.toLowerCase()
    const cur = byKey.get(key) ?? { label: u.collection, procedures: [], caught: 0 }
    for (const p of u.procedures) if (!cur.procedures.includes(p)) cur.procedures.push(p)
    byKey.set(key, cur)
  }
  let caughtTotal = 0
  for (const [key, n] of Object.entries(input.caught)) {
    if (!(n > 0)) continue
    caughtTotal += n
    const cur = byKey.get(key) ?? { label: key, procedures: [], caught: 0 }
    cur.caught += n
    byKey.set(key, cur)
  }
  const withProcs = [...byKey.values()].filter((c) => c.procedures.length > 0)
  const procCount = new Set(withProcs.flatMap((c) => c.procedures)).size
  if (!byKey.size) {
    const how =
      input.source === 'none'
        ? 'No procedure list could be read'
        : 'Every procedure that writes a registered collection announces it'
    return {
      status: 'pass',
      detail: `${how}; the safety net caught no unannounced rows in the last 24 h${
        input.watcherSeen ? '' : ' (the outside-write watcher has not run in that time)'
      }`
    }
  }
  const rows = [...byKey.values()].sort(
    (a, b) => b.caught - a.caught || b.procedures.length - a.procedures.length
  )
  const blockers = rows.slice(0, MAX_BLOCKERS).map((c) => {
    const caught = c.caught ? `${plural(c.caught, 'row')} caught by the safety net in 24 h` : ''
    if (c.procedures.length) {
      const who = `written by ${names(c.procedures)} without announcing`
      return `${c.label}: ${who}${caught ? `; ${caught}` : ''}`
    }
    return `${c.label}: ${caught} — written outside the app by something no procedure check found (a script or another database?)`
  })
  const parts: string[] = []
  if (withProcs.length)
    parts.push(
      `${plural(withProcs.length, 'collection')} written by ${plural(procCount, 'procedure')} that do not announce`
    )
  if (caughtTotal) parts.push(`${plural(caughtTotal, 'row')} caught by the safety net in 24 h`)
  const tail =
    input.source === 'live-scan' ? ' (procedures read just now — the SQL checks have not run)' : ''
  return {
    status: 'warn',
    detail: `${parts.join('; ')}. Open screens showing these stay stale until the safety net or a reload catches up${tail}. SQL checks → Propose fix adds the announcement.`,
    blockers
  }
}

// ── Inputs ───────────────────────────────────────────────────────────────────

interface FindingRow {
  object_schema: string | null
  object_name: string
  object_type: string
  detail: string | null
}

function procName(schema: string | null, name: string): string {
  return schema ? `${schema}.${name}` : name
}

/** Group open `write-unannounced` findings by the collection they name. */
export function groupFindings(rows: FindingRow[]): UnannouncedCollection[] {
  const out = new Map<string, UnannouncedCollection>()
  for (const r of rows) {
    let collection: string | null = null
    try {
      const d = r.detail ? (JSON.parse(r.detail) as { collection?: unknown }) : null
      collection = typeof d?.collection === 'string' && d.collection ? d.collection : null
    } catch {
      collection = null
    }
    if (!collection) continue
    const key = collection.toLowerCase()
    const cur = out.get(key) ?? { collection, procedures: [] }
    const who =
      r.object_type === 'import_definition'
        ? `import ${r.object_name}`
        : procName(r.object_schema, r.object_name)
    if (!cur.procedures.includes(who)) cur.procedures.push(who)
    out.set(key, cur)
  }
  return [...out.values()]
}

/** The stored findings, or null when the SQL checks have no finished run in the last week. */
async function fromFindings(now: number): Promise<UnannouncedCollection[] | null> {
  if (!(await db.schema.hasTable('nivaro_sql_check_runs'))) return null
  if (!(await db.schema.hasTable('nivaro_sql_check_findings'))) return null
  const last = (await db('nivaro_sql_check_runs')
    .where({ status: 'ok' })
    .orderBy('id', 'desc')
    .first('finished_at')) as { finished_at: Date | string | null } | undefined
  const at = last?.finished_at ? new Date(last.finished_at).getTime() : Number.NaN
  if (!Number.isFinite(at) || now - at > FINDINGS_FRESH_MS) return null
  const rows = (await db('nivaro_sql_check_findings')
    .where({ check_key: 'write-unannounced', status: 'open' })
    .select('object_schema', 'object_name', 'object_type', 'detail')) as FindingRow[]
  return groupFindings(rows)
}

/** The same check over the deployed procedures, read now (SQL Server only). */
async function fromModules(): Promise<UnannouncedCollection[] | null> {
  if (!isMssql(db)) return null
  const [{ loadCatalog }, { checkObject }] = await Promise.all([
    import('./sql-checks/run.js'),
    import('./sql-checks/checkers.js')
  ])
  const catalog = await loadCatalog()
  const rows = (await db.raw(
    `SELECT s.name AS sch, o.name AS name, m.definition AS def
       FROM sys.sql_modules m
       JOIN sys.objects o ON o.object_id = m.object_id
       JOIN sys.schemas s ON s.schema_id = o.schema_id
      WHERE o.is_ms_shipped = 0 AND o.type IN ('P', 'PC') AND m.definition IS NOT NULL`
  )) as Array<{ sch: string; name: string; def: string }>
  const found: FindingRow[] = []
  for (const r of rows) {
    const findings = checkObject(
      { schema: r.sch, name: r.name, type: 'procedure', definition: r.def },
      catalog
    ).filter((f) => f.check_key === 'write-unannounced')
    for (const f of findings)
      found.push({
        object_schema: r.sch,
        object_name: r.name,
        object_type: 'procedure',
        detail: JSON.stringify(f.detail ?? {})
      })
  }
  return groupFindings(found)
}

async function caughtCounts(
  now: number
): Promise<{ caught: Record<string, number>; seen: boolean }> {
  const { outsideWriteReport } = await import('./outside-write-watch.js')
  const report = await outsideWriteReport(now)
  const caught: Record<string, number> = {}
  for (const [k, v] of Object.entries(report.counts)) if (v.caught > 0) caught[k] = v.caught
  const seen = !!report.last_tick && now - report.last_tick.at < 86_400_000
  return { caught, seen }
}

export async function announceCoverageReadiness(now = Date.now()): Promise<ReadinessResult> {
  // Stored procedures that write behind the app's back are a SQL Server thing.
  if (!isMssql(db))
    return {
      status: 'skip',
      detail: 'Skipped: this database has no stored procedures writing around the app.'
    }
  try {
    let source: AnnounceCoverageInput['source'] = 'sql-checks'
    let unannounced = await fromFindings(now)
    if (!unannounced) {
      source = 'live-scan'
      unannounced = await fromModules()
    }
    if (!unannounced) source = 'none'
    const { caught, seen } = await caughtCounts(now)
    return judgeAnnounceCoverage({
      unannounced: unannounced ?? [],
      source,
      caught,
      watcherSeen: seen
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { status: 'warn', detail: `Announce coverage could not be read: ${msg.slice(0, 200)}` }
  }
}

export function registerAnnounceCoverageReadiness(): void {
  registerReadinessCheck({
    id: 'announce-coverage',
    label: 'Database writes reach open screens',
    group: 'Realtime',
    description:
      'Warns when procedures write registered collections without announcing it (the SQL checks’ "Writes without announcing" findings — read from sys.sql_modules when the SQL checks have not run in a week) or when the outside-write watcher caught rows in the last 24 hours. People looking at those records keep seeing old values until the safety net or a reload catches up. Never fails.',
    cost: 'heavy',
    run: () => announceCoverageReadiness()
  })
}
