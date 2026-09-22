/**
 * Who depends on a custom query, and does its declared shape still hold (#531).
 *
 * A query is referenced by page widgets, record widgets, report widgets and
 * their catalog presets, metric/anomaly definitions and flow operations —
 * six config tables, each storing the reference inside a JSON column under
 * its own key. Changing a query's output was a guess about who breaks; the
 * `categories-breakdown-by-region-grouped` wrapper's declared column list
 * went stale after a proc redeploy and took every sibling `#b` wrapper down
 * on the pooled connection (see gotchas). This module answers both halves:
 *
 *  - dependents: one LIKE per surface for the quoted slug / id (a surface
 *    missing on a deployment contributes nothing — never a 500);
 *  - shape: for a wrapper that EXECs a procedure into a declared table, the
 *    declared columns vs the procedure's real first result set
 *    (sys.dm_exec_describe_first_result_set_for_object — no parameters needed,
 *    undetermined metadata reported as such rather than guessed).
 */
import { db } from '../db/index.js'

export interface Dependent {
  surface: string
  id: unknown
  name: string
  link: string | null
  detail: string | null
}

interface Surface {
  table: string
  label: string
  cols: string[]
  nameOf: (r: Record<string, unknown>) => string
  link: (r: Record<string, unknown>) => string | null
  detail?: (r: Record<string, unknown>) => string | null
}

const SURFACES: Surface[] = [
  {
    table: 'nivaro_pages',
    label: 'Page widgets',
    cols: ['layout'],
    nameOf: (r) => String(r.title ?? r.name ?? r.slug ?? r.id),
    link: (r) => `/pages-admin/${r.id}/edit`,
    detail: (r) => (r.slug ? `/p/${r.slug}` : null)
  },
  {
    table: 'nivaro_widgets',
    label: 'Record widgets',
    cols: ['config'],
    nameOf: (r) => String(r.name ?? r.id),
    link: () => '/record-widgets',
    detail: (r) => (r.widget_type ? String(r.widget_type) : null)
  },
  {
    table: 'nivaro_report_widgets',
    label: 'Report widgets',
    cols: ['config'],
    nameOf: (r) => String(r.title ?? r.type ?? r.id),
    link: (r) => (r.report ? `/report-studio/${r.report}` : null),
    detail: (r) => (r.type ? String(r.type) : null)
  },
  {
    table: 'nivaro_report_widget_presets',
    label: 'Report catalog presets',
    cols: ['config'],
    nameOf: (r) => String(r.name ?? r.id),
    link: () => null,
    detail: (r) => (r.category ? String(r.category) : null)
  },
  {
    table: 'nivaro_metric_definitions',
    label: 'Metric alert definitions',
    cols: ['metric_source'],
    nameOf: (r) => String(r.label ?? r.metric_key ?? r.id),
    link: () => '/alert-manager',
    detail: (r) => (r.status ? String(r.status) : null)
  },
  {
    table: 'nivaro_anomaly_definitions',
    label: 'Anomaly definitions',
    cols: ['config'],
    nameOf: (r) => String(r.label ?? r.key ?? r.id),
    link: () => '/alert-manager'
  },
  {
    table: 'nivaro_flow_operations',
    label: 'Flow operations',
    cols: ['options'],
    nameOf: (r) => String(r.name ?? r.key ?? r.id),
    link: (r) => (r.flow ? `/flows/${r.flow}` : null),
    detail: (r) => (r.type ? String(r.type) : null)
  },
  {
    table: 'nivaro_custom_queries',
    label: 'Other custom queries',
    cols: ['sql_text'],
    nameOf: (r) => String(r.name ?? r.slug ?? r.id),
    link: (r) => `/custom-queries/${r.id}`,
    detail: (r) => (r.slug ? String(r.slug) : null)
  }
]

function esc(s: string): string {
  return s.replace(/[%_[]/g, (c) => `[${c}]`)
}

export async function customQueryDependents(
  id: string | number,
  slug: string
): Promise<Dependent[]> {
  // The slug appears quoted inside JSON (`"query_slug":"x"`, `"slug":"x"`, a
  // stat strip's `query: {slug: "x"}`); the id appears as `"query_id":"7"` or
  // `"query_id":7`. Both forms are searched; a bare word match would be noise.
  const needles = [
    `"${esc(slug)}"`,
    `"query_id":"${esc(String(id))}"`,
    `"query_id":${esc(String(id))},`,
    `"query_id":${esc(String(id))}}`
  ]
  const out: Dependent[] = []
  for (const s of SURFACES) {
    try {
      const rows = (await db(s.table)
        .where((qb) => {
          for (const c of s.cols) for (const n of needles) void qb.orWhere(c, 'like', `%${n}%`)
        })
        .limit(50)
        .select('*')) as Array<Record<string, unknown>>
      for (const r of rows) {
        if (s.table === 'nivaro_custom_queries' && String(r.id) === String(id)) continue
        out.push({
          surface: s.label,
          id: r.id,
          name: s.nameOf(r),
          link: s.link(r),
          detail: s.detail?.(r) ?? null
        })
      }
    } catch {
      // absent table / column on this deployment
    }
  }
  return out
}

export interface ShapeCheck {
  procedure: string
  /** The table the wrapper inserts the procedure's rows into. */
  target: string
  /** Columns the wrapper declares for that target (or the INSERT's own list), in order. */
  declared: string[]
  /** Columns the procedure's first result set really emits, in order — when SQL Server can tell. */
  actual: string[] | null
  /** Why `actual` is null (metadata undeterminable, procedure missing…). */
  note: string | null
  missing: string[]
  extra: string[]
  /** Same count, different names — informational: INSERT … EXEC binds by position. */
  order_differs: boolean
  /**
   * ok — declared matches the described result set;
   * mismatch — it does not;
   * mismatch_observed — the DMV cannot describe the proc but the last run on
   *   this process failed with an INSERT … EXEC shape error;
   * unknown — undeterminable and no failing run recorded here.
   */
  status: 'ok' | 'mismatch' | 'mismatch_observed' | 'unknown'
  last_run: { at: string | null; outcome: string | null }
  last_error: { at: string; message: string } | null
}

interface InsertExec {
  target: string
  columns: string[] | null
  procedure: string
}

/** `INSERT [INTO] #b [(cols)] EXEC[UTE] [dbo.]proc …` pairs, in order of appearance. */
export function insertExecPairs(sql: string): InsertExec[] {
  const out: InsertExec[] = []
  const re =
    /\bINSERT\s+(?:INTO\s+)?([#@]\w+)\s*(?:\(([^)]*)\))?\s*EXEC(?:UTE)?\s+(?!sp_executesql\b)(?:\[?\w+\]?\.)?\[?(\w+)\]?/gi
  for (const m of sql.matchAll(re)) {
    const cols = m[2]
      ? m[2]
          .split(',')
          .map((c) => c.trim().replace(/^\[|\]$/g, ''))
          .filter(Boolean)
      : null
    out.push({ target: m[1], columns: cols, procedure: m[3] })
  }
  return out
}

/** Every `CREATE TABLE #x (…)` / `DECLARE @x TABLE (…)` in the wrapper: name → column names in order. */
export function declaredTables(sql: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const re = /(?:CREATE\s+TABLE\s+(#\w+)|DECLARE\s+(@\w+)\s+TABLE)\s*\(/gi
  for (const m of sql.matchAll(re)) {
    const name = (m[1] ?? m[2]) as string
    // Walk to the matching close paren so nested type parens (decimal(18,2)) survive.
    let i = m.index! + m[0].length
    let depth = 1
    const start = i
    while (i < sql.length && depth > 0) {
      if (sql[i] === '(') depth++
      else if (sql[i] === ')') depth--
      i++
    }
    const body = sql.slice(start, i - 1)
    const cols: string[] = []
    let cur = ''
    depth = 0
    for (const ch of body) {
      if (ch === '(') depth++
      if (ch === ')') depth--
      if (ch === ',' && depth === 0) {
        cols.push(cur)
        cur = ''
      } else cur += ch
    }
    if (cur.trim()) cols.push(cur)
    const names = cols
      .map((c) => c.trim())
      .filter((c) => c && !/^(PRIMARY|UNIQUE|CONSTRAINT|INDEX|CHECK)\b/i.test(c))
      .map((c) => c.match(/^\[?([^\]\s]+)\]?/)?.[1] ?? '')
      .filter(Boolean)
    if (names.length) out.set(name.toLowerCase(), names)
  }
  return out
}

const SHAPE_ERROR =
  /(does not match table definition|has (more|fewer) columns than were specified|Column name or number of supplied values)/i

async function describeProc(
  proc: string
): Promise<{ actual: string[] | null; note: string | null }> {
  try {
    const exists = (await db.raw('SELECT OBJECT_ID(?) AS id', [`dbo.${proc}`])) as Array<{
      id: number | null
    }>
    const oid = Array.isArray(exists) ? exists[0]?.id : null
    if (!oid) return { actual: null, note: 'Procedure not found on this database.' }
    const rows = (await db.raw(
      `SELECT name, is_hidden, error_message
         FROM sys.dm_exec_describe_first_result_set_for_object(?, 0)
        ORDER BY column_ordinal`,
      [oid]
    )) as Array<{ name: string | null; is_hidden: boolean; error_message: string | null }>
    const err = rows.find((r) => r.error_message)
    if (err)
      return {
        actual: null,
        note: `SQL Server cannot describe this procedure's result set: ${String(err.error_message).slice(0, 160)}`
      }
    return {
      actual: rows.filter((r) => !r.is_hidden && r.name).map((r) => String(r.name)),
      note: null
    }
  } catch (e) {
    return { actual: null, note: `Could not describe: ${(e as Error).message.slice(0, 200)}` }
  }
}

export async function shapeChecks(sql: string, slug?: string): Promise<ShapeCheck[]> {
  const pairs = insertExecPairs(sql)
  if (pairs.length === 0) return []
  const tables = declaredTables(sql)
  const { lastQueryError, lastQueryRun } = await import('./query-cache-stats.js')
  const lastError = slug ? lastQueryError(slug) : null
  const lastRun = slug ? lastQueryRun(slug) : { at: null, outcome: null }
  const out: ShapeCheck[] = []
  for (const p of pairs) {
    const declared = p.columns ?? tables.get(p.target.toLowerCase()) ?? null
    if (!declared) continue
    const { actual, note } = await describeProc(p.procedure)
    // INSERT … EXEC binds by POSITION, never by name: the wrapper may call
    // the columns what it likes, only the count (and type compatibility) is
    // load-bearing. Names are still reported so a reviewer can see drift.
    const d = declared.map((x) => x.toLowerCase())
    const a = actual ? actual.map((x) => x.toLowerCase()) : null
    const missing = a && a.length < d.length ? declared.slice(a.length) : []
    const extra = a && actual && a.length > d.length ? actual.slice(d.length) : []
    const order_differs = !!a && a.length === d.length && a.join('|') !== d.join('|')
    let status: ShapeCheck['status']
    if (a) status = a.length === d.length ? 'ok' : 'mismatch'
    else if (
      lastError &&
      SHAPE_ERROR.test(lastError.message) &&
      (!lastRun.at || lastError.at >= lastRun.at)
    )
      status = 'mismatch_observed'
    else status = 'unknown'
    out.push({
      procedure: p.procedure,
      target: p.target,
      declared,
      actual,
      note,
      missing,
      extra,
      order_differs,
      status,
      last_run: lastRun,
      last_error: lastError
    })
  }
  return out
}
