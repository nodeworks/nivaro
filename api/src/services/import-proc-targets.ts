import { db } from '../db/index.js'
import { announcedCollections, findWrites, withoutAnnounceBlocks } from './sql-checks/checkers.js'
import { depthMap, maskSql, splitName } from './sql-checks/tokenizer.js'

/**
 * rt-fix C (M2): the collections a procedure-backed staged import writes.
 *
 * An import definition never names its target tables — only `recalc_rollups`, which is about
 * rollups, not "what changed". So the run reads the procedure as deployed (OBJECT_DEFINITION;
 * the stored `procedure_body` when the database cannot answer) and finds every INSERT / UPDATE
 * / DELETE / MERGE / TRUNCATE target with the same parser the nightly SQL checks use
 * (services/sql-checks/checkers.ts findWrites, aliases resolved), follows the procedures it
 * EXECs (two levels, a dozen procedures at most) and keeps the targets that are registered
 * collections. Tables the procedure already announces itself (nivaro_announce_writes /
 * nivaro_raw_writes) are left out, and so are Nivaro's own tables.
 *
 * Best-effort throughout: a definition that cannot be read means fewer notices, never a failed
 * import.
 */

const MAX_DEPTH = 2
const MAX_PROCS = 12

/** Writes and calls of one definition. Pure — exported for tests. */
export function procedureWritesOf(sql: string): {
  /** Lower-cased table names written (temp tables, table variables and nivaro_* left out). */
  tables: Set<string>
  /** Collections the definition announces itself (lower-cased); `all` = it announces anything. */
  announced: { all: boolean; names: Set<string> }
  /** Procedures it EXECs (bare names, lower-cased; system procs left out). */
  calls: Set<string>
} {
  const masked = maskSql(sql)
  const depth = depthMap(masked)
  const tables = new Set<string>()
  for (const w of findWrites(withoutAnnounceBlocks(sql, masked), depth)) {
    const name = w.table.name.replace(/^\[|\]$/g, '').toLowerCase()
    if (!name || /^(nivaro_|directus_|sysdiagrams$)/.test(name)) continue
    tables.add(name)
  }
  const calls = new Set<string>()
  const exec =
    /\bEXEC(?:UTE)?\s+(?:@[\w@#$]+\s*=\s*)?((?:(?:\[[^\]]+\]|[A-Za-z_][\w$#@]*)\s*\.\s*){0,2}(?:\[[^\]]+\]|[A-Za-z_][\w$#@]*))/gi
  for (let m = exec.exec(masked); m; m = exec.exec(masked)) {
    const name = splitName(m[1])
      .name.replace(/^\[|\]$/g, '')
      .toLowerCase()
    if (!name || name.startsWith('@')) continue
    if (/^(sp_|xp_|nivaro_)/.test(name)) continue
    calls.add(name)
  }
  return { tables, announced: announcedCollections(sql, masked), calls }
}

/** The procedure's bare name from what the definition EXECs (`dbo.import_po @x = 1` → `dbo.import_po`). */
export function procedureNameOf(procedure: string): string | null {
  const m =
    /^\s*((?:(?:\[[^\]]+\]|[A-Za-z_][\w$#@]*)\s*\.\s*){0,2}(?:\[[^\]]+\]|[A-Za-z_][\w$#@]*))/.exec(
      procedure
    )
  return m ? m[1].replace(/\s*\.\s*/g, '.') : null
}

async function definitionOf(name: string): Promise<string | null> {
  try {
    const rows = (await db.raw('SELECT OBJECT_DEFINITION(OBJECT_ID(?)) AS def', [name])) as Array<{
      def: string | null
    }>
    return rows?.[0]?.def ?? null
  } catch {
    return null
  }
}

async function registeredCollections(): Promise<Map<string, string>> {
  try {
    const rows = (await db('nivaro_collections').select('collection')) as Array<{
      collection: string | null
    }>
    return new Map(
      rows
        .filter((r) => !!r.collection)
        .map((r) => [String(r.collection).toLowerCase(), String(r.collection)])
    )
  } catch {
    return new Map()
  }
}

/**
 * Registered collections the procedure (and the procedures it calls) writes and does not
 * announce itself. `storedBody` = the definition's `procedure_body`, used when the database
 * has no definition to read (a procedure not deployed yet, a permission gap).
 */
export async function procedureWrittenCollections(
  procedure: string,
  storedBody?: string | null,
  read: (name: string) => Promise<string | null> = definitionOf
): Promise<string[]> {
  const root = procedureNameOf(procedure)
  if (!root) return []
  const tables = new Set<string>()
  const announced = new Set<string>()
  const seen = new Set<string>()
  let queue: Array<{ name: string; body?: string | null }> = [{ name: root, body: storedBody }]
  for (let level = 0; level <= MAX_DEPTH && queue.length > 0; level++) {
    const next: typeof queue = []
    for (const p of queue) {
      const key = (splitName(p.name).name || p.name).replace(/^\[|\]$/g, '').toLowerCase()
      if (seen.has(key) || seen.size >= MAX_PROCS) continue
      seen.add(key)
      const sql = (await read(p.name)) ?? p.body ?? null
      if (!sql) continue
      const w = procedureWritesOf(sql)
      for (const t of w.tables) tables.add(t)
      // A definition that announces through a variable is judged to announce what it writes.
      if (w.announced.all) for (const t of w.tables) announced.add(t)
      for (const n of w.announced.names) announced.add(n)
      for (const c of w.calls) next.push({ name: c })
    }
    queue = next
  }
  if (tables.size === 0) return []
  const registered = await registeredCollections()
  const out: string[] = []
  for (const t of tables) {
    const c = registered.get(t)
    if (c && !announced.has(t)) out.push(c)
  }
  return out.sort()
}

/**
 * Announce what a procedure just wrote (a notice only — no flows, webhooks or alerts start).
 * `skip` = collections the caller already announced. Never throws; returns what it announced.
 */
export async function announceProcedureWrites(
  procedure: string,
  opts: { source: string; storedBody?: string | null; skip?: Iterable<string> }
): Promise<string[]> {
  try {
    const skip = new Set([...(opts.skip ?? [])].map((c) => c.toLowerCase()))
    const targets = (await procedureWrittenCollections(procedure, opts.storedBody)).filter(
      (c) => !skip.has(c.toLowerCase())
    )
    if (targets.length === 0) return []
    const { announceRawWrites } = await import('./raw-write-announcer.js')
    for (const c of targets)
      await announceRawWrites(c, null, { action: 'update', source: opts.source, noticeOnly: true })
    return targets
  } catch {
    return []
  }
}
