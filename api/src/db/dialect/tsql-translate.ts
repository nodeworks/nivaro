import type { Knex } from 'knex'
import {
  type DatePart,
  type DateUnit,
  dateAdd,
  dateDiff,
  datePart,
  nowLocal,
  nowUtc,
  qi,
  sqlDialect,
  textPosition
} from '../sql-dialect.js'

/**
 * T-SQL → Postgres / MySQL for the read-only report statements that were written as SQL Server
 * text (ops report, inactive-user tools, retention reads). SQL Server gets its text back
 * UNCHANGED (the first line of `tsql()`); only the other two dialects are rewritten.
 *
 * Covers what those statements use: `[bracket]` identifiers, `SELECT TOP n` (becomes a trailing
 * LIMIT), GETDATE/GETUTCDATE, ISNULL, LEN, CHARINDEX (2 args), DATEADD / DATEDIFF / DATEPART
 * (incl. dayofyear), `CAST(x AS nvarchar(n))`, `LIKE` (ILIKE on Postgres: SQL Server's collation
 * is case-insensitive), the `[_]` LIKE escape, `is_* / new_ip = 1` on Postgres and the
 * `first_name + ' ' + last_name` person-name concatenation, and (Postgres) `l.[user]` of the
 * request log read as a uuid. Not covered (write those per dialect by
 * hand): string `+` concatenation, `TOP (?)` with a binding, UPDATE/DELETE TOP, OPENJSON, sys.*.
 */

const DATE_UNITS: Record<string, DateUnit> = {
  second: 'second',
  ss: 'second',
  s: 'second',
  minute: 'minute',
  mi: 'minute',
  n: 'minute',
  hour: 'hour',
  hh: 'hour',
  day: 'day',
  dd: 'day',
  d: 'day',
  week: 'week',
  wk: 'week',
  ww: 'week',
  month: 'month',
  mm: 'month',
  m: 'month',
  year: 'year',
  yy: 'year',
  yyyy: 'year'
}

/** Apply `fn` to the parts of `sql` that are outside single-quoted literals. */
function outsideQuotes(sql: string, fn: (s: string) => string): string {
  let out = ''
  let seg = ''
  let i = 0
  while (i < sql.length) {
    const ch = sql[i]
    if (ch === "'") {
      out += fn(seg)
      seg = ''
      let j = i + 1
      while (j < sql.length) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") j += 2
          else break
        } else j++
      }
      out += sql.slice(i, j + 1)
      i = j + 1
    } else {
      seg += ch
      i++
    }
  }
  return out + fn(seg)
}

/** Index of the `)` that closes the `(` at `open`, skipping literals. -1 when unbalanced. */
function closeParen(sql: string, open: number): number {
  let depth = 0
  for (let i = open; i < sql.length; i++) {
    const ch = sql[i]
    if (ch === "'") {
      i++
      while (i < sql.length && !(sql[i] === "'" && sql[i + 1] !== "'")) i += sql[i] === "'" ? 2 : 1
    } else if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/** Split call arguments at top-level commas. */
function splitArgs(inner: string): string[] {
  const args: string[] = []
  let depth = 0
  let cur = ''
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]
    if (ch === "'") {
      let j = i + 1
      while (j < inner.length && !(inner[j] === "'" && inner[j + 1] !== "'"))
        j += inner[j] === "'" ? 2 : 1
      cur += inner.slice(i, j + 1)
      i = j
      continue
    }
    if (ch === '(') depth++
    else if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      args.push(cur)
      cur = ''
    } else cur += ch
  }
  args.push(cur)
  return args.map((a) => a.trim())
}

function dayOfYear(knex: Knex, expr: string): string {
  if (sqlDialect(knex) === 'sqlite') return `CAST(strftime('%j', ${expr}) AS INTEGER)`
  return sqlDialect(knex) === 'pg' ? `EXTRACT(DOY FROM ${expr})::int` : `DAYOFYEAR(${expr})`
}

function datePartOf(knex: Knex, unit: string, expr: string): string | null {
  const u = unit.toLowerCase()
  if (u === 'dayofyear' || u === 'dy' || u === 'y') return dayOfYear(knex, expr)
  const map: Record<string, string> = {
    year: 'year',
    yy: 'year',
    yyyy: 'year',
    month: 'month',
    mm: 'month',
    m: 'month',
    day: 'day',
    dd: 'day',
    d: 'day',
    hour: 'hour',
    hh: 'hour',
    minute: 'minute',
    mi: 'minute',
    n: 'minute',
    second: 'second',
    ss: 'second',
    s: 'second',
    weekday: 'weekday',
    dw: 'weekday',
    quarter: 'quarter',
    qq: 'quarter',
    q: 'quarter'
  }
  const p = map[u]
  if (!p) return null
  const d = sqlDialect(knex)
  if (d === 'sqlite') return datePart(knex, p as DatePart, expr)
  if (d === 'pg') {
    if (p === 'weekday') return `(EXTRACT(DOW FROM ${expr})::int + 1)`
    return `EXTRACT(${p.toUpperCase()} FROM ${expr})::int`
  }
  if (p === 'weekday') return `DAYOFWEEK(${expr})`
  return `${p.toUpperCase()}(${expr})`
}

const FN = /\b(GETUTCDATE|GETDATE|ISNULL|LEN|DATEADD|DATEDIFF|DATEPART|CHARINDEX)\s*\(/i

function rewriteFunctions(knex: Knex, sql: string): string {
  const d = sqlDialect(knex)
  let guard = 0
  let cur = sql
  for (;;) {
    if (guard++ > 500) throw new Error('tsql: too many function rewrites')
    // Find the first call outside literals.
    let found: RegExpExecArray | null = null
    let at = 0
    let scan = cur
    for (;;) {
      const m = FN.exec(scan)
      if (!m) break
      const abs = at + m.index
      // Skip matches inside a literal (count quotes before it).
      const before = cur.slice(0, abs)
      const quotes = (before.match(/'/g) ?? []).length
      if (quotes % 2 === 0) {
        found = Object.assign([...m], { index: abs }) as unknown as RegExpExecArray
        break
      }
      at = abs + m[0].length
      scan = cur.slice(at)
    }
    if (!found) return cur
    const name = found[1].toUpperCase()
    const open = found.index + found[0].length - 1
    const close = closeParen(cur, open)
    if (close < 0) return cur
    const args = splitArgs(cur.slice(open + 1, close)).map((a) => rewriteFunctions(knex, a))
    let rep: string | null = null
    if (name === 'GETUTCDATE') rep = nowUtc(knex)
    else if (name === 'GETDATE') rep = nowLocal(knex)
    else if (name === 'ISNULL' && args.length === 2) rep = `COALESCE(${args[0]}, ${args[1]})`
    else if (name === 'LEN' && args.length === 1)
      rep = d === 'sqlite' ? `LENGTH(${args[0]})` : `CHAR_LENGTH(${args[0]})`
    else if (name === 'CHARINDEX' && args.length === 2 && d === 'sqlite')
      rep = textPosition(knex, args[0], args[1])
    else if (name === 'CHARINDEX' && args.length === 2)
      rep = d === 'pg' ? `POSITION(${args[0]} IN ${args[1]})` : `LOCATE(${args[0]}, ${args[1]})`
    else if (name === 'DATEADD' && args.length === 3) {
      const u = DATE_UNITS[args[0].toLowerCase()]
      if (u && d === 'sqlite') rep = dateAdd(knex, u, args[1], args[2])
      else if (u) {
        const n = args[1]
        rep =
          d === 'pg'
            ? `(${args[2]} + (${n}) * interval '1 ${u}')`
            : `DATE_ADD(${args[2]}, INTERVAL (${n}) ${u.toUpperCase()})`
      }
    } else if (name === 'DATEDIFF' && args.length === 3) {
      const u = DATE_UNITS[args[0].toLowerCase()]
      if (u) {
        if (d === 'sqlite') rep = dateDiff(knex, u, args[1], args[2])
        else if (d === 'mysql') rep = `TIMESTAMPDIFF(${u.toUpperCase()}, ${args[1]}, ${args[2]})`
        else {
          const secs: Record<string, number> = {
            second: 1,
            minute: 60,
            hour: 3600,
            day: 86400,
            week: 604800
          }
          if (secs[u])
            rep = `FLOOR(EXTRACT(EPOCH FROM ((${args[2]})::timestamp - (${args[1]})::timestamp)) / ${secs[u]})::int`
          else if (u === 'month')
            rep = `((DATE_PART('year', AGE(${args[2]}, ${args[1]})) * 12) + DATE_PART('month', AGE(${args[2]}, ${args[1]})))::int`
          else rep = `DATE_PART('year', AGE(${args[2]}, ${args[1]}))::int`
        }
      }
    } else if (name === 'DATEPART' && args.length === 2) {
      rep = datePartOf(knex, args[0], args[1])
    }
    if (rep == null) {
      // Unknown shape: leave the call alone (marked so it is not found again).
      cur = `${cur.slice(0, found.index + 1)}\uE000${cur.slice(found.index + 1)}`
      continue
    }
    cur = cur.slice(0, found.index) + rep + cur.slice(close + 1)
  }
}

/** Where the SELECT that starts at `from` ends: an unmatched `)`, a UNION, or the end. */
function selectEnd(sql: string, from: number): number {
  let depth = 0
  for (let i = from; i < sql.length; i++) {
    const ch = sql[i]
    if (ch === "'") {
      i++
      while (i < sql.length && !(sql[i] === "'" && sql[i + 1] !== "'")) i += sql[i] === "'" ? 2 : 1
    } else if (ch === '(') depth++
    else if (ch === ')') {
      if (depth === 0) return i
      depth--
    } else if (depth === 0 && /^\s+UNION\b/i.test(sql.slice(i, i + 8))) return i
  }
  return sql.length
}

const TOP_RE = /\bSELECT(\s+DISTINCT)?\s+TOP\s*(?:\(\s*(\d+)\s*\)|(\d+))\s+/i

function rewriteTop(sql: string): string {
  let cur = sql
  for (let guard = 0; guard < 50; guard++) {
    const m = TOP_RE.exec(cur)
    if (!m) return cur
    const n = m[2] ?? m[3]
    const start = m.index + m[0].length
    const end = selectEnd(cur, start)
    const head = cur.slice(0, m.index)
    const body = cur.slice(start, end).replace(/\s+$/, '')
    cur = `${head}SELECT${m[1] ?? ''} ${body} LIMIT ${n}${cur.slice(end)}`
  }
  return cur
}

/**
 * The statement as Postgres / MySQL reads it. SQL Server: unchanged. Bindings are untouched
 * (nothing here adds, drops or reorders a `?`).
 */
export function tsql(knex: Knex | Knex.Transaction, sql: string): string {
  const d = sqlDialect(knex as Knex)
  if (d === 'mssql') return sql
  let out = sql.replace(/\[_\]/g, '\\_')
  out = rewriteFunctions(knex as Knex, out).replace(/\uE000/g, '')
  out = rewriteTop(out)
  // The request log keeps its user as text; it meets uuid keys (SQL Server converts implicitly,
  // Postgres does not).
  if (d === 'pg')
    out = out.replace(
      /\bl\.\[user\](?!\s+AS\b)/g,
      () =>
        `(CASE WHEN l."user" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN CAST(l."user" AS uuid) END)`
    )
  // "first + ' ' + last" person names: null when a part is null, like `+` on SQL Server
  // (CONCAT on Postgres would turn the null into an empty string).
  out = out.replace(
    /\b((?:\w+\.)?first_name)\s*\+\s*' '\s*\+\s*((?:\w+\.)?last_name)\b/g,
    d === 'pg' || d === 'sqlite' ? "($1 || ' ' || $2)" : "CONCAT($1, ' ', $2)"
  )
  out = outsideQuotes(out, (seg) => {
    let s = seg.replace(
      /\bAS\s+n?varchar\s*\(\s*(?:\d+|max)\s*\)/gi,
      d === 'pg' || d === 'sqlite' ? 'AS text' : 'AS CHAR'
    )
    s = s.replace(
      /\bAS\s+n?varchar\b(?!\s*\()/gi,
      d === 'pg' || d === 'sqlite' ? 'AS text' : 'AS CHAR'
    )
    if (d === 'mysql') s = s.replace(/\bAS\s+(?:big)?int\b/gi, 'AS SIGNED')
    if (d === 'pg') {
      s = s.replace(/\bLIKE\b/g, 'ILIKE')
      // bit columns (is_*, new_ip) are booleans here
      s = s.replace(
        /\b((?:\w+\.)?(?:is_\w+|new_ip))\s*(=|<>|!=)\s*([01])\b/g,
        (_m, col: string, op: string, v: string) => `${col} ${op} ${v === '1' ? 'true' : 'false'}`
      )
    }
    s = s.replace(/\[([A-Za-z_][A-Za-z0-9_]*)\]/g, (_m, id: string) => qi(knex as Knex, id))
    return s
  })
  return out
}
