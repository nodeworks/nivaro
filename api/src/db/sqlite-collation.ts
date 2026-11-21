/**
 * SQLite text columns compare case-insensitively, like SQL Server's default collation
 * (db/sqlite.ts point 8). knex's column compiler declares every new text column COLLATE NOCASE;
 * this brings a database whose tables were created before that — or by raw SQL — in line, once:
 * it runs after every migration run and does nothing when every text column already has it.
 *
 * How: a column's collation lives only in the table's CREATE TABLE text, and the rows on disk do
 * not depend on it — only index order does. So for each table missing it, inside one
 * transaction: the CREATE TABLE text in sqlite_master gets ` COLLATE NOCASE` appended to each
 * text column's definition (the rest of the text stays byte for byte), the schema version is
 * bumped so every connection re-reads it, the table's indexes are rebuilt (REINDEX) and checked
 * (integrity_check). A table whose columns, foreign keys or checks would read back any different,
 * or whose check fails, is put back exactly as it was. No row is copied or moved.
 *
 * A text column under a unique index that holds values differing only in case ('ABC' and 'abc')
 * keeps comparing exactly: under NOCASE the index would refuse its own rows. It is named in the
 * log so an administrator can clean the duplicates; the next boot converts it.
 */
import type { Knex } from 'knex'
import { isTextAffinity, sqliteWriteLock } from './sqlite.js'

interface RawConn {
  prepare(sql: string): {
    all(...a: unknown[]): unknown[]
    get(...a: unknown[]): unknown
    run(...a: unknown[]): unknown
  }
  exec(sql: string): void
  pragma(sql: string, opts?: { simple?: boolean }): unknown
  unsafeMode(on?: boolean): void
}

const qi = (name: string) => `"${name.replace(/"/g, '""')}"`

export interface CollationResult {
  converted: string[]
  /** `table.column` left comparing exactly: case duplicates under a unique index. */
  keptExact: string[]
  /** Tables left as they were, with why. */
  skipped: Array<{ table: string; reason: string }>
}

/** Text columns of a table the CREATE TABLE text gives no collation yet (cheap pre-check). */
function textColumnsWithoutCollation(conn: RawConn, table: string, sql: string): boolean {
  const cols = conn.prepare('SELECT type FROM pragma_table_info(?)').all(table) as Array<{
    type: string | null
  }>
  const text = cols.filter((c) => isTextAffinity(c.type)).length
  const declared = (sql.match(/\bcollate\s+["'`[]?nocase\b/gi) ?? []).length
  return text > declared
}

/** Unique indexes on `table` that hold values differing only in case in these columns. */
function caseDuplicateColumns(conn: RawConn, table: string, changing: Set<string>): Set<string> {
  const keep = new Set<string>()
  const indexes = conn
    .prepare('SELECT name, partial FROM pragma_index_list(?) WHERE "unique" = 1')
    .all(table) as Array<{ name: string; partial: number }>
  for (const ix of indexes) {
    const keys = (
      conn
        .prepare('SELECT cid, name FROM pragma_index_xinfo(?) WHERE key = 1')
        .all(ix.name) as Array<{
        cid: number
        name: string | null
      }>
    ).filter((k) => k.cid >= 0 && k.name)
    const touched = keys.filter((k) => changing.has(String(k.name).toLowerCase()))
    if (touched.length === 0) continue
    let where = keys.map((k) => `${qi(String(k.name))} IS NOT NULL`).join(' AND ')
    if (ix.partial) {
      const def = conn
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get(ix.name) as { sql?: string } | undefined
      const cond = /\bwhere\b([\s\S]*)$/i.exec(def?.sql ?? '')?.[1]
      if (cond) where += ` AND (${cond})`
    }
    const group = keys
      .map((k) =>
        changing.has(String(k.name).toLowerCase())
          ? `${qi(String(k.name))} COLLATE NOCASE`
          : qi(String(k.name))
      )
      .join(', ')
    const dup = conn
      .prepare(
        `SELECT 1 FROM ${qi(table)} WHERE ${where} GROUP BY ${group} HAVING COUNT(*) > 1 LIMIT 1`
      )
      .get()
    if (dup) for (const k of touched) keep.add(String(k.name).toLowerCase())
  }
  return keep
}

const shape = (conn: RawConn, table: string) =>
  JSON.stringify([
    conn
      .prepare('SELECT name, type, "notnull", dflt_value, pk, hidden FROM pragma_table_xinfo(?)')
      .all(table),
    conn.prepare('SELECT * FROM pragma_foreign_key_list(?)').all(table),
    conn
      .prepare('SELECT name, "unique", origin, partial FROM pragma_index_list(?) ORDER BY name')
      .all(table)
  ])

/**
 * The column definitions of a CREATE TABLE statement: for each top-level item between the
 * outer parentheses, where it ends in the text, the column name (null for a table constraint)
 * and whether it already names a collation. Quotes ('…', "…", `…`, […]) and nested
 * parentheses are skipped over, so a comma inside a CHECK or a DEFAULT does not split.
 */
export function createTableColumns(
  sql: string
): Array<{ name: string | null; end: number; collated: boolean }> {
  const out: Array<{ name: string | null; end: number; collated: boolean }> = []
  const open = sql.indexOf('(')
  if (open < 0) return out
  let depth = 0
  let start = open + 1
  let plain = ''
  const finish = (end: number) => {
    const item = sql.slice(start, end).trim()
    const bare = plain.trim()
    const constraint = /^(constraint|primary|unique|check|foreign)\b/i.test(bare)
    const m =
      /^\s*(?:"((?:[^"]|"")*)"|`((?:[^`]|``)*)`|\[([^\]]*)\]|([A-Za-z_][A-Za-z0-9_$]*))/.exec(item)
    const name =
      constraint || !m
        ? null
        : (m[1]?.replace(/""/g, '"') ?? m[2]?.replace(/``/g, '`') ?? m[3] ?? m[4] ?? null)
    out.push({ name, end, collated: /\bcollate\b/i.test(bare) })
    plain = ''
  }
  for (let i = open + 1; i < sql.length; i++) {
    const ch = sql[i]
    const close = ch === "'" ? "'" : ch === '"' ? '"' : ch === '`' ? '`' : ch === '[' ? ']' : null
    if (close) {
      let j = i + 1
      while (j < sql.length) {
        if (sql[j] === close) {
          if (close !== ']' && sql[j + 1] === close) j += 2
          else break
        } else j++
      }
      plain += ' '
      i = j
      continue
    }
    if (ch === '(') depth++
    else if (ch === ')') {
      if (depth === 0) {
        finish(i)
        break
      }
      depth--
    } else if (ch === ',' && depth === 0) {
      finish(i)
      start = i + 1
      continue
    }
    plain += depth === 0 ? ch : ' '
  }
  return out
}

/** Bring one raw connection's database in line (see the file comment). */
export function sqliteTextNocase(conn: RawConn): CollationResult {
  const result: CollationResult = { converted: [], keptExact: [], skipped: [] }
  const tables = conn
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND sql IS NOT NULL AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name"
    )
    .all() as Array<{ name: string; sql: string }>
  const todo = tables.filter((t) => textColumnsWithoutCollation(conn, t.name, t.sql))
  if (todo.length === 0) return result
  conn.unsafeMode(true) // writable_schema is refused in better-sqlite3's default defensive mode
  try {
    for (const t of todo) {
      const types = new Map(
        (
          conn.prepare('SELECT name, type FROM pragma_table_info(?)').all(t.name) as Array<{
            name: string
            type: string | null
          }>
        ).map((c) => [c.name.toLowerCase(), c.type])
      )
      const items = createTableColumns(t.sql).filter(
        (c) => c.name && !c.collated && isTextAffinity(types.get(c.name.toLowerCase()))
      )
      const changing = new Set(items.map((c) => String(c.name).toLowerCase()))
      if (changing.size === 0) continue
      for (const col of caseDuplicateColumns(conn, t.name, changing)) {
        changing.delete(col)
        result.keptExact.push(`${t.name}.${col}`)
      }
      if (changing.size === 0) continue
      // ` COLLATE NOCASE` appended to each column definition, the rest of the text untouched.
      let sql = t.sql
      for (const c of [...items].reverse())
        if (changing.has(String(c.name).toLowerCase()))
          sql = `${sql.slice(0, c.end).trimEnd()} COLLATE NOCASE${sql.slice(c.end)}`
      const before = shape(conn, t.name)
      conn.exec('SAVEPOINT nvr_nocase')
      try {
        const version = Number(conn.pragma('schema_version', { simple: true }))
        conn.pragma('writable_schema = ON')
        conn
          .prepare("UPDATE sqlite_master SET sql = ? WHERE type = 'table' AND name = ?")
          .run(sql, t.name)
        conn.pragma(`schema_version = ${version + 1}`)
        conn.pragma('writable_schema = OFF')
        if (shape(conn, t.name) !== before) throw new Error('the table would read back differently')
        conn.exec(`REINDEX ${qi(t.name)}`)
        const check = conn.prepare(`PRAGMA integrity_check(${qi(t.name)})`).all() as Array<
          Record<string, unknown>
        >
        const verdict = check.map((r) => Object.values(r)[0]).join('; ')
        if (verdict !== 'ok') throw new Error(`integrity check: ${verdict.slice(0, 200)}`)
        conn.exec('RELEASE nvr_nocase')
        for (const c of changing) result.converted.push(`${t.name}.${c}`)
      } catch (err) {
        try {
          conn.pragma('writable_schema = OFF')
        } catch {}
        conn.exec('ROLLBACK TO nvr_nocase')
        conn.exec('RELEASE nvr_nocase')
        result.skipped.push({ table: t.name, reason: (err as Error).message })
      }
    }
  } finally {
    conn.unsafeMode(false)
  }
  return result
}

/** Run sqliteTextNocase on one of knex's connections, holding the write lock; logs what it did. */
export async function ensureSqliteTextNocase(knex: Knex): Promise<CollationResult> {
  const client = knex.client as {
    acquireConnection(): Promise<RawConn>
    releaseConnection(c: RawConn): Promise<void>
  }
  const conn = await client.acquireConnection()
  await sqliteWriteLock.acquire(conn)
  try {
    const result = sqliteTextNocase(conn)
    if (result.converted.length > 0)
      console.log(
        `SQLite: ${result.converted.length} text columns now compare case-insensitively (COLLATE NOCASE), like SQL Server`
      )
    if (result.keptExact.length > 0)
      console.warn(
        `SQLite: these text columns still compare exactly — their unique index holds values that differ only in case: ${result.keptExact.join(', ')}`
      )
    for (const s of result.skipped)
      console.warn(`SQLite: table ${s.table} keeps exact text comparison — ${s.reason}`)
    return result
  } finally {
    sqliteWriteLock.release(conn)
    await client.releaseConnection(conn)
  }
}
