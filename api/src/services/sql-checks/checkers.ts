// api/src/services/sql-checks/checkers.ts
/**
 * The pure checks behind nightly SQL checks (#2562). Each one reads ONE definition (a module's
 * text from sys.sql_modules, a stored import procedure body or a custom query) against a small
 * catalog view (column nullability, wide tables, unique indexes) and returns raw findings. No
 * database access here: the run layer (run.ts) loads the catalog, adds live data figures (NULL
 * counts, duplicate rows) and tracks findings across runs by fingerprint.
 *
 * Matching runs on the masked text (tokenizer.ts) so nothing inside a comment or a string literal
 * counts; offsets map straight back to the original for line numbers and snippets. These are
 * heuristics over T-SQL, not a parser: each check prefers missing a case to raising a wrong one.
 */
import { createHash } from 'node:crypto'
import { depthMap, lineAt, maskSql, matchParen, normaliseSql, splitName } from './tokenizer.js'

export const CHECK_KEYS = [
  'merge-null-key',
  'merge-source-dupes',
  'write-without-where',
  'tran-without-xact-abort',
  'local-time',
  'not-in-subquery',
  'select-star-wide',
  'import-body-drift',
  'sqlfluff'
] as const
export type CheckKey = (typeof CHECK_KEYS)[number]
export type Severity = 'critical' | 'warning' | 'info'
export const SEVERITIES: readonly Severity[] = ['critical', 'warning', 'info']
export type ObjectType =
  | 'procedure'
  | 'function'
  | 'view'
  | 'trigger'
  | 'custom_query'
  | 'import_definition'

export interface SqlObject {
  schema: string | null
  name: string
  type: ObjectType
  /** Custom query / import definition id (the editor link). */
  ref?: string | null
  definition: string
}

export interface ColumnInfo {
  nullable: boolean
  dataType: string
  maxLength: number | null
}

/** What the checks may ask about the database's tables. Names compare case-insensitively. */
export interface Catalog {
  column(schema: string | null, table: string, column: string): ColumnInfo | undefined
  hasTable(schema: string | null, table: string): boolean
  /** Has an nvarchar(max) / varchar(max) / varbinary(max) / xml / text column. */
  isWide(schema: string | null, table: string): boolean
  /** Column sets (lower-cased) of the table's primary key and unique indexes. */
  uniqueSets(schema: string | null, table: string): string[][]
}

export interface RawFinding {
  check_key: CheckKey
  severity: Severity
  line: number
  /** Up to 500 characters of the definition at the match. */
  snippet: string
  message: string
  detail: Record<string, unknown>
  suggested_fix: string
  /** Normalised statement text: what the fingerprint keys on (not the line, which moves). */
  anchor: string
}

export interface CheckContext {
  obj: SqlObject
  sql: string
  masked: string
  depth: Int16Array
  catalog: Catalog
}

const IDENT = String.raw`(?:\[(?:[^\]]|\]\])+\]|"[^"]+"|[A-Za-z_#@$][\w#@$]*)`
const NAME = String.raw`${IDENT}(?:\s*\.\s*${IDENT}){0,3}`
const SNIPPET_MAX = 500

const isTemp = (name: string) => name.startsWith('#') || name.startsWith('@')
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function snippetAt(sql: string, from: number, to: number): string {
  const s = sql.slice(from, Math.min(to, from + SNIPPET_MAX))
  return s.length > SNIPPET_MAX ? s.slice(0, SNIPPET_MAX) : s
}

function anchorOf(masked: string, from: number, to: number): string {
  return normaliseSql(masked.slice(from, Math.min(to, from + 300)))
}

/** Next identifier-ish word at `pos` (masked text), skipping whitespace. */
function wordAt(masked: string, pos: number): { word: string; start: number; end: number } | null {
  const re = new RegExp(`\\s*(${IDENT})`, 'y')
  re.lastIndex = pos
  const m = re.exec(masked)
  if (!m) return null
  const start = pos + m[0].length - m[1].length
  return { word: m[1], start, end: pos + m[0].length }
}

function skipWs(masked: string, pos: number): number {
  while (pos < masked.length && /\s/.test(masked[pos])) pos++
  return pos
}

/** A regex for `alias.column` references (bracketed or not) for one alias. */
function refRe(alias: string, flags = 'gi'): RegExp {
  const a = esc(alias)
  return new RegExp(
    String.raw`(?:\[${a}\]|\b${a})\s*\.\s*(\[(?:[^\]]|\]\])+\]|[A-Za-z_][\w$]*)`,
    flags
  )
}

const unbracket = (s: string) => splitName(s).name

// ─── MERGE ──────────────────────────────────────────────────────────────────

export interface ParsedMerge {
  start: number
  /** Offset just past the ON condition. */
  onEnd: number
  target: { schema: string | null; name: string }
  targetAlias: string
  source:
    | { kind: 'subquery'; body: string; alias: string | null }
    | { kind: 'name'; schema: string | null; name: string; alias: string | null }
    | { kind: 'values'; alias: string | null }
  on: string
  onStart: number
}

/** Every MERGE in the masked text with its target, source and the ON condition. */
export function parseMerges(masked: string, depth: Int16Array): ParsedMerge[] {
  const out: ParsedMerge[] = []
  const re = new RegExp(
    String.raw`\bMERGE\s+(?:TOP\s*\([^)]*\)\s*(?:PERCENT\s+)?)?(?:INTO\s+)?(${NAME})`,
    'gi'
  )
  for (let m = re.exec(masked); m; m = re.exec(masked)) {
    const start = m.index
    const target = splitName(m[1])
    let pos = m.index + m[0].length
    pos = skipWs(masked, pos)
    if (/^WITH\s*\(/i.test(masked.slice(pos, pos + 20))) {
      const open = masked.indexOf('(', pos)
      const close = matchParen(masked, open)
      if (close < 0) continue
      pos = close + 1
    }
    let w = wordAt(masked, pos)
    if (w && /^AS$/i.test(w.word)) {
      pos = w.end
      w = wordAt(masked, pos)
    }
    let targetAlias = target.name
    if (w && !/^USING$/i.test(w.word)) {
      targetAlias = unbracket(w.word)
      pos = w.end
      w = wordAt(masked, pos)
    }
    if (!w || !/^USING$/i.test(w.word)) continue
    pos = skipWs(masked, w.end)
    let source: ParsedMerge['source']
    if (masked[pos] === '(') {
      const close = matchParen(masked, pos)
      if (close < 0) continue
      const body = masked.slice(pos + 1, close)
      pos = close + 1
      const isValues = /^\s*VALUES\b/i.test(body)
      let a = wordAt(masked, pos)
      if (a && /^AS$/i.test(a.word)) {
        pos = a.end
        a = wordAt(masked, pos)
      }
      let alias: string | null = null
      if (a && !/^ON$/i.test(a.word)) {
        alias = unbracket(a.word)
        pos = a.end
        const p2 = skipWs(masked, pos)
        if (masked[p2] === '(') {
          const c2 = matchParen(masked, p2)
          if (c2 > 0) pos = c2 + 1
        }
      }
      source = isValues ? { kind: 'values', alias } : { kind: 'subquery', body, alias }
    } else {
      const nameRe = new RegExp(`(${NAME})`, 'y')
      nameRe.lastIndex = pos
      const nm = nameRe.exec(masked)
      if (!nm) continue
      const s = splitName(nm[1])
      pos = pos + nm[0].length
      let a = wordAt(masked, pos)
      if (a && /^AS$/i.test(a.word)) {
        pos = a.end
        a = wordAt(masked, pos)
      }
      let alias: string | null = null
      if (a && !/^ON$/i.test(a.word)) {
        alias = unbracket(a.word)
        pos = a.end
      }
      source = { kind: 'name', schema: s.schema, name: s.name, alias }
    }
    const onW = wordAt(masked, pos)
    if (!onW || !/^ON$/i.test(onW.word)) continue
    const onStart = onW.end
    const level = depth[start]
    const whenRe = /\bWHEN\b/gi
    whenRe.lastIndex = onStart
    let onEnd = -1
    for (let wm = whenRe.exec(masked); wm; wm = whenRe.exec(masked)) {
      if (depth[wm.index] === level) {
        onEnd = wm.index
        break
      }
    }
    if (onEnd < 0) continue
    out.push({
      start,
      onEnd,
      target,
      targetAlias,
      source,
      on: masked.slice(onStart, onEnd),
      onStart
    })
    re.lastIndex = onEnd
  }
  return out
}

/** Columns of `alias` referenced in `text` (lower-cased, unique, as written order). */
export function aliasColumns(text: string, alias: string): Array<{ column: string; ref: string }> {
  const seen = new Set<string>()
  const out: Array<{ column: string; ref: string }> = []
  for (const m of text.matchAll(refRe(alias))) {
    const column = unbracket(m[1]).toLowerCase()
    if (seen.has(column)) continue
    seen.add(column)
    out.push({ column, ref: m[0] })
  }
  return out
}

/** Whether the ON condition compares `alias.column` in a NULL-safe way. */
export function nullSafeIn(on: string, alias: string, column: string): boolean {
  if (/\bINTERSECT\b/i.test(on)) return true
  const a = esc(alias)
  const c = esc(column)
  const ref = String.raw`(?:\[${a}\]|\b${a})\s*\.\s*(?:\[${c}\]|${c}\b)`
  return [
    String.raw`\b(?:ISNULL|COALESCE)\s*\(\s*${ref}`,
    String.raw`${ref}\s+IS\s+(?:NOT\s+)?NULL\b`,
    String.raw`${ref}\s+IS\s+(?:NOT\s+)?DISTINCT\s+FROM\b`,
    String.raw`\bIS\s+(?:NOT\s+)?DISTINCT\s+FROM\s+${ref}`
  ].some((p) => new RegExp(p, 'i').test(on))
}

function checkMerges(ctx: CheckContext): RawFinding[] {
  const { sql, masked, depth, catalog } = ctx
  const out: RawFinding[] = []
  const merges = parseMerges(masked, depth)
  for (const m of merges) {
    if (isTemp(m.target.name)) continue
    const tschema = m.target.schema
    const tname = m.target.name
    const keys = aliasColumns(m.on, m.targetAlias)
    const nullable: string[] = []
    const keyCols: string[] = []
    for (const k of keys) {
      const col = catalog.column(tschema, tname, k.column)
      if (!col) continue
      keyCols.push(k.column)
      if (col.nullable && !nullSafeIn(m.on, m.targetAlias, k.column)) nullable.push(k.column)
    }
    const snippet = snippetAt(sql, m.start, m.onEnd)
    const anchor = anchorOf(masked, m.start, m.onEnd)
    const line = lineAt(sql, m.start)
    const tableLabel = `${tschema ? `${tschema}.` : ''}${tname}`
    if (nullable.length) {
      out.push({
        check_key: 'merge-null-key',
        severity: 'warning',
        line,
        snippet,
        anchor,
        message: `MERGE into ${tableLabel} matches on nullable ${nullable.join(', ')} without a NULL-safe compare`,
        detail: {
          target_schema: tschema,
          target_table: tname,
          key_columns: keyCols,
          nullable_columns: nullable
        },
        suggested_fix: [
          `NULL never equals NULL, so a source row whose ${nullable.join(' / ')} is NULL never matches its stored row and is inserted again on every run.`,
          'Compare NULL-safely in the ON clause, for example:',
          ...nullable.map(
            (c) =>
              `  (${m.targetAlias}.${c} = src.${c} OR (${m.targetAlias}.${c} IS NULL AND src.${c} IS NULL))`
          ),
          'Then remove the copies already stored (back the table up first, keep the newest row per key) and add a unique index on the key so a copy can never be inserted again (SQL Server treats NULLs as equal in a unique index).'
        ].join('\n')
      })
    }
    // the source side: a key repeated in the source fails the whole MERGE
    const srcAlias = m.source.alias ?? (m.source.kind === 'name' ? m.source.name : null)
    if (m.source.kind === 'values' || !srcAlias) continue
    let deduped = false
    let judged = true
    if (m.source.kind === 'subquery') {
      deduped = /\b(ROW_NUMBER|RANK|DENSE_RANK|GROUP\s+BY|DISTINCT)\b/i.test(m.source.body)
    } else if (isTemp(m.source.name)) {
      judged = false
    } else {
      const cte = new RegExp(
        String.raw`(?:\bWITH|,)\s*\[?${esc(m.source.name)}\]?\s*(?:\([^)]*\)\s*)?AS\s*\(`,
        'i'
      ).exec(masked)
      if (cte) {
        const open = masked.indexOf('(', cte.index + cte[0].length - 1)
        const close = matchParen(masked, open)
        const body = close > 0 ? masked.slice(open + 1, close) : ''
        deduped = /\b(ROW_NUMBER|RANK|DENSE_RANK|GROUP\s+BY|DISTINCT)\b/i.test(body)
      } else if (catalog.hasTable(m.source.schema, m.source.name)) {
        const srcCols = aliasColumns(m.on, srcAlias).map((c) => c.column)
        const sets = catalog.uniqueSets(m.source.schema, m.source.name)
        deduped =
          srcCols.length > 0 &&
          sets.some((set) => set.length > 0 && set.every((c) => srcCols.includes(c)))
      } else judged = false
    }
    if (judged && !deduped)
      out.push({
        check_key: 'merge-source-dupes',
        severity: 'warning',
        line,
        snippet,
        anchor,
        message: `MERGE into ${tableLabel} reads a source that may repeat a key`,
        detail: { target_schema: tschema, target_table: tname, source: m.source.kind },
        suggested_fix:
          'When two source rows carry the same key, SQL Server stops the whole MERGE ("attempted to UPDATE or DELETE the same row more than once") and nothing imports. Take one row per key in the source, for example with ROW_NUMBER() OVER (PARTITION BY <key> ORDER BY <latest first>) = 1, or GROUP BY the key.'
      })
  }
  return out
}

// ─── UPDATE / DELETE without WHERE ──────────────────────────────────────────

const STMT_WORDS = new Set(
  'INSERT DELETE UPDATE MERGE SELECT IF ELSE BEGIN END DECLARE EXEC EXECUTE WHILE RETURN COMMIT ROLLBACK PRINT RAISERROR THROW TRUNCATE DROP CREATE ALTER SET OPEN FETCH CLOSE DEALLOCATE GOTO WAITFOR'.split(
    ' '
  )
)

/** The end of the statement that continues from `from` (masked text, same paren depth). */
export function statementEnd(masked: string, depth: Int16Array, from: number): number {
  const level = depth[from] ?? 0
  const re = /;|\b[A-Za-z_]+\b/g
  re.lastIndex = from
  let caseDepth = 0
  for (let m = re.exec(masked); m; m = re.exec(masked)) {
    const at = m.index
    if (depth[at] < level) return at
    if (depth[at] !== level) continue
    if (m[0] === ';') return at
    const w = m[0].toUpperCase()
    if (w === 'CASE') {
      caseDepth++
      continue
    }
    if (w === 'END' && caseDepth > 0) {
      caseDepth--
      continue
    }
    if (w === 'ELSE' && caseDepth > 0) continue
    if (w === 'WITH') {
      // a table hint WITH (NOLOCK) stays in the statement; WITH cte AS ( starts one
      if (/^WITH\s*\(/i.test(masked.slice(at, at + 12))) continue
      return at
    }
    if (STMT_WORDS.has(w)) return at
  }
  return masked.length
}

function wordBefore(masked: string, at: number): string {
  const m = /([A-Za-z_]+)\s*$/.exec(masked.slice(Math.max(0, at - 40), at))
  return m ? m[1].toUpperCase() : ''
}

/** Whether `alias` names a temp table / table variable in the statement's FROM / JOIN list. */
function aliasIsTemp(stmt: string, alias: string): boolean {
  const re = new RegExp(
    String.raw`(?:\bFROM|\bJOIN)\s+([#@][\w#@$]*)\s+(?:AS\s+)?\[?${esc(alias)}\]?\b`,
    'i'
  )
  return re.test(stmt)
}

function checkWrites(ctx: CheckContext): RawFinding[] {
  const { sql, masked, depth } = ctx
  const out: RawFinding[] = []
  const re = new RegExp(
    String.raw`\b(UPDATE|DELETE)\b(?:\s+TOP\s*\([^)]*\)\s*(?:PERCENT\s+)?)?(?:\s+FROM)?\s+(${NAME})`,
    'gi'
  )
  for (let m = re.exec(masked); m; m = re.exec(masked)) {
    const verb = m[1].toUpperCase()
    const at = m.index
    const prev = wordBefore(masked, at)
    if (prev === 'THEN' || prev === 'NOT') continue // MERGE actions (WHEN … THEN UPDATE / DELETE)
    const target = splitName(m[2])
    if (/^(STATISTICS|SET)$/i.test(target.name)) continue
    if (verb === 'UPDATE' && /^\s*\(/.test(masked.slice(at + 6, at + 10))) continue // UPDATE(col)
    if (isTemp(target.name)) continue
    let bodyFrom = at + m[0].length
    if (verb === 'UPDATE') {
      const setM = /\bSET\b/i.exec(masked.slice(bodyFrom, bodyFrom + 400))
      if (!setM) continue
      bodyFrom += setM.index + 3
    }
    const end = statementEnd(masked, depth, bodyFrom)
    const stmt = masked.slice(at, end)
    const level = depth[at]
    const topLevel = (word: RegExp) => {
      const r = new RegExp(word.source, 'gi')
      for (let w = r.exec(stmt); w; w = r.exec(stmt)) if (depth[at + w.index] === level) return true
      return false
    }
    if (topLevel(/\bWHERE\b/)) continue
    if (topLevel(/\bJOIN\b/) && topLevel(/\bON\b/)) continue
    if (aliasIsTemp(stmt, target.name)) continue
    const label = `${target.schema ? `${target.schema}.` : ''}${target.name}`
    out.push({
      check_key: 'write-without-where',
      severity: 'critical',
      line: lineAt(sql, at),
      snippet: snippetAt(sql, at, end),
      anchor: anchorOf(masked, at, end),
      message: `${verb} on ${label} has no WHERE: it touches every row`,
      detail: { verb, target_schema: target.schema, target_table: target.name },
      suggested_fix: `Add the WHERE that limits the ${verb.toLowerCase()} to the rows it means to change (or a JOIN that does). If clearing the whole table is intended, say so with TRUNCATE TABLE or a comment and mark this finding as expected.`
    })
  }
  return out
}

// ─── transactions ───────────────────────────────────────────────────────────

function checkTransactions(ctx: CheckContext): RawFinding[] {
  const { sql, masked } = ctx
  const begin = /\bBEGIN\s+TRAN(?:SACTION)?\b/i.exec(masked)
  if (!begin) return []
  if (/\bSET\s+XACT_ABORT\s+ON\b/i.test(masked)) return []
  const catchBlock = /\bBEGIN\s+CATCH\b([\s\S]*?)\bEND\s+CATCH\b/i.exec(masked)
  if (catchBlock && /@@TRANCOUNT/i.test(catchBlock[1]) && /\bROLLBACK\b/i.test(catchBlock[1]))
    return []
  const end = Math.min(masked.length, begin.index + 120)
  return [
    {
      check_key: 'tran-without-xact-abort',
      severity: 'warning',
      line: lineAt(sql, begin.index),
      snippet: snippetAt(sql, begin.index, end),
      anchor: 'begin tran',
      message: 'Opens a transaction without SET XACT_ABORT ON or a CATCH that rolls it back',
      detail: {},
      suggested_fix:
        'When a statement inside the transaction fails, the transaction stays open on the pooled connection and the next request that borrows it inherits it (locks held, later work rolled back with it). Add SET XACT_ABORT ON at the top of the procedure, or wrap the work in BEGIN TRY … END TRY BEGIN CATCH IF @@TRANCOUNT > 0 ROLLBACK; THROW; END CATCH.'
    }
  ]
}

// ─── local time ─────────────────────────────────────────────────────────────

function checkLocalTime(ctx: CheckContext): RawFinding[] {
  const { sql, masked } = ctx
  const hits = [...masked.matchAll(/\b(GETDATE|SYSDATETIME)\s*\(\s*\)/gi)]
  if (!hits.length) return []
  const first = hits[0].index ?? 0
  return [
    {
      check_key: 'local-time',
      severity: 'info',
      line: lineAt(sql, first),
      snippet: snippetAt(sql, Math.max(0, sql.lastIndexOf('\n', first) + 1), first + 160),
      anchor: 'local-time',
      message: `Uses the server's local clock (${hits.length} × ${[...new Set(hits.map((h) => h[1].toUpperCase()))].join(' / ')})`,
      detail: {
        count: hits.length,
        lines: hits.slice(0, 20).map((h) => lineAt(sql, h.index ?? 0))
      },
      suggested_fix:
        "GETDATE() and SYSDATETIME() return the server's local time. Where they are compared with or written next to timestamps the application stores in UTC, windows shift by the UTC offset (and twice a year by an hour more). Use GETUTCDATE() / SYSUTCDATETIME() for those, or mark this finding as expected when local time is meant."
    }
  ]
}

// ─── NOT IN over a nullable column ──────────────────────────────────────────

function checkNotIn(ctx: CheckContext): RawFinding[] {
  const { sql, masked, catalog } = ctx
  const out: RawFinding[] = []
  const re = /\bNOT\s+IN\s*\(\s*SELECT\b/gi
  for (let m = re.exec(masked); m; m = re.exec(masked)) {
    const open = masked.indexOf('(', m.index)
    const close = matchParen(masked, open)
    if (close < 0) continue
    const sub = masked.slice(open + 1, close)
    const sm = new RegExp(
      String.raw`^\s*SELECT\s+(?:DISTINCT\s+)?(?:TOP\s*\(?\s*\d+\s*\)?\s+)?(${NAME})\s+FROM\s+(${NAME})(?:\s+(?:AS\s+)?(${IDENT}))?`,
      'i'
    ).exec(sub)
    if (!sm) continue
    const colRef = splitName(sm[1])
    const table = splitName(sm[2])
    if (isTemp(table.name)) continue
    const col = catalog.column(table.schema, table.name, colRef.name)
    if (!col?.nullable) continue
    if (new RegExp(String.raw`\b${esc(colRef.name)}\]?\s+IS\s+NOT\s+NULL\b`, 'i').test(sub))
      continue
    out.push({
      check_key: 'not-in-subquery',
      severity: 'warning',
      line: lineAt(sql, m.index),
      snippet: snippetAt(sql, m.index, close + 1),
      anchor: anchorOf(masked, m.index, close + 1),
      message: `NOT IN over nullable ${table.name}.${colRef.name}: one NULL there makes the whole test false`,
      detail: { table: table.name, column: colRef.name },
      suggested_fix: `If ${table.name}.${colRef.name} holds a single NULL, "x NOT IN (SELECT …)" is never true and the rows silently drop out. Use NOT EXISTS (SELECT 1 FROM ${table.name} WHERE ${colRef.name} = x), or add WHERE ${colRef.name} IS NOT NULL inside the subquery.`
    })
  }
  return out
}

// ─── SELECT * on wide tables ────────────────────────────────────────────────

function checkSelectStar(ctx: CheckContext): RawFinding[] {
  const { sql, masked, catalog } = ctx
  const out: RawFinding[] = []
  const re = new RegExp(
    String.raw`\bSELECT\s+(?:DISTINCT\s+)?(?:TOP\s*\(?\s*[\w@]+\s*\)?\s*(?:PERCENT\s+)?)?\*\s+FROM\s+(${NAME})`,
    'gi'
  )
  for (let m = re.exec(masked); m; m = re.exec(masked)) {
    if (/\bEXISTS\s*\(\s*$/i.test(masked.slice(Math.max(0, m.index - 30), m.index))) continue
    const t = splitName(m[1])
    if (isTemp(t.name) || !catalog.isWide(t.schema, t.name)) continue
    out.push({
      check_key: 'select-star-wide',
      severity: 'info',
      line: lineAt(sql, m.index),
      snippet: snippetAt(sql, m.index, m.index + m[0].length + 80),
      anchor: anchorOf(masked, m.index, m.index + m[0].length),
      message: `SELECT * from ${t.name}, which has large text or binary columns`,
      detail: { table: t.name },
      suggested_fix: `Every row carries ${t.name}'s large columns over the wire even when nothing reads them. Name the columns the caller needs.`
    })
  }
  return out
}

// ─── all checks over one object ─────────────────────────────────────────────

/** Every pattern check over one definition. */
export function checkObject(obj: SqlObject, catalog: Catalog): RawFinding[] {
  const sql = obj.definition ?? ''
  if (!sql.trim()) return []
  const masked = maskSql(sql)
  const ctx: CheckContext = { obj, sql, masked, depth: depthMap(masked), catalog }
  return [
    ...checkMerges(ctx),
    ...checkWrites(ctx),
    ...checkTransactions(ctx),
    ...checkLocalTime(ctx),
    ...checkNotIn(ctx),
    ...checkSelectStar(ctx)
  ]
}

/**
 * Stable identity of a finding across runs: the check, the object and the normalised statement
 * (not its line, which moves when lines are added above it). `occurrence` separates two
 * identical statements in one object.
 */
export function fingerprintOf(
  obj: Pick<SqlObject, 'schema' | 'name' | 'type'>,
  checkKey: string,
  anchor: string,
  occurrence = 0
): string {
  return createHash('sha256')
    .update(
      [
        checkKey,
        obj.type,
        (obj.schema ?? '').toLowerCase(),
        obj.name.toLowerCase(),
        anchor,
        occurrence
      ].join('\u0001')
    )
    .digest('hex')
}

/** sha256 of a definition (a changed procedure has a new hash). */
export function definitionHash(sql: string): string {
  return createHash('sha256').update(sql).digest('hex')
}
