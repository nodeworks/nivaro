import type { Knex } from 'knex'
import {
  type Cond,
  dimOf,
  type EvalCtx,
  type Frag,
  type Join,
  type MemRow,
  type Registry,
  type Source
} from './model.js'

/**
 * The two executors behind every delivery-analytics number: SQL (production)
 * and in-memory (the tests' fixture rows). Both take the same queries built
 * from the same dimension registry, so a number and the drill behind it differ
 * only in COUNT vs SUM(CASE) over one condition list.
 */

export interface Span {
  from: Date
  to: Date
}

export interface AggQuery {
  source: Source
  /** null = no time window (mutes are a standing list). */
  span: Span | null
  where: Cond[]
  groupBy: string[]
  /** name → extra conditions; [] counts every row the query covers. */
  measures: Record<string, Cond[]>
  /** Keep the n groups with the largest `by` measure. */
  top?: { by: string; n: number }
  /** Keep groups whose measure reaches `min`. */
  having?: { measure: string; min: number }
}

export interface AggRow {
  keys: string[]
  counts: Record<string, number>
}

export interface PctQuery {
  span: Span
  where: Cond[]
  groupBy: string[]
}

export interface PctRow {
  keys: string[]
  /** Minutes from send to read. */
  p50: number | null
  p90: number | null
}

export type RowSort = 'time' | 'ttr'

export interface RowsQuery {
  source: Source
  span: Span | null
  where: Cond[]
  sort: RowSort
  dir: 'asc' | 'desc'
  offset: number
  limit: number
}

export interface RowsResult {
  total: number
  rows: Array<Record<string, unknown>>
}

export interface Executor {
  aggregate(q: AggQuery): Promise<AggRow[]>
  percentiles(q: PctQuery): Promise<PctRow[]>
  rows(q: RowsQuery): Promise<RowsResult>
}

/** Timed population: a read time at or after the send. */
export const TIMED: Cond = ['timed', ['yes']]

// ── SQL ────────────────────────────────────────────────────────────────────

const FROM: Record<Source, string> = {
  n: 'nivaro_notifications n',
  m: 'nivaro_mail_log m',
  x: 'nivaro_notification_mutes x'
}
const TIME_COL: Record<Source, string | null> = {
  n: 'n.[timestamp]',
  m: 'm.created_at',
  x: null
}
const ID_COL: Record<Source, string> = { n: 'n.id', m: 'm.id', x: 'x.id' }
const JOIN_SQL: Record<Join, string> = {
  ru: 'LEFT JOIN nivaro_users ru ON ru.id = n.recipient',
  su: 'LEFT JOIN nivaro_users su ON su.id = n.sender'
}

class SqlBuilder {
  readonly joins = new Set<Join>()
  constructor(
    private reg: Registry,
    private source: Source,
    private ctx: EvalCtx
  ) {}

  dim(key: string): Frag {
    const d = dimOf(this.reg, this.source, key)
    for (const j of d.joins ?? []) this.joins.add(j)
    return d.sql(this.ctx)
  }

  cond([dim, values]: Cond): Frag {
    const d = this.dim(dim)
    if (values.length === 0) return { sql: '1 = 0', bindings: [] }
    if (values.length === 1) return { sql: `(${d.sql}) = ?`, bindings: [...d.bindings, values[0]] }
    return {
      sql: `(${d.sql}) IN (${values.map(() => '?').join(', ')})`,
      bindings: [...d.bindings, ...values]
    }
  }

  all(conds: Cond[]): Frag {
    if (conds.length === 0) return { sql: '1 = 1', bindings: [] }
    const parts = conds.map((c) => this.cond(c))
    return {
      sql: parts.map((p) => p.sql).join(' AND '),
      bindings: parts.flatMap((p) => p.bindings)
    }
  }

  where(span: Span | null, conds: Cond[]): Frag {
    const parts: Frag[] = []
    const col = TIME_COL[this.source]
    if (span && col)
      parts.push({ sql: `${col} >= ? AND ${col} < ?`, bindings: [span.from, span.to] })
    parts.push(this.all(conds))
    return {
      sql: parts.map((p) => p.sql).join(' AND '),
      bindings: parts.flatMap((p) => p.bindings)
    }
  }

  /** FROM + the joins every dimension used so far asked for. Call last. */
  from(): string {
    return [FROM[this.source], ...[...this.joins].sort().map((j) => JOIN_SQL[j])].join(' ')
  }
}

const num = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
const numOrNull = (v: unknown): number | null => {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export function sqlExecutor(knex: Knex, reg: Registry, ctx: EvalCtx): Executor {
  const raw = async (sql: string, bindings: unknown[]) =>
    (await knex.raw(sql, bindings as never)) as unknown as Array<Record<string, unknown>>

  return {
    async aggregate(q) {
      const b = new SqlBuilder(reg, q.source, ctx)
      const select: Frag[] = []
      q.groupBy.forEach((g, i) => {
        const d = b.dim(g)
        select.push({ sql: `${d.sql} AS g${i}`, bindings: d.bindings })
      })
      const names = Object.keys(q.measures)
      names.forEach((m, i) => {
        const conds = q.measures[m] as Cond[]
        if (conds.length === 0) select.push({ sql: `1 AS c${i}`, bindings: [] })
        else {
          const f = b.all(conds)
          select.push({
            sql: `CASE WHEN ${f.sql} THEN 1 ELSE 0 END AS c${i}`,
            bindings: f.bindings
          })
        }
      })
      const where = b.where(q.span, q.where)
      const inner = `SELECT ${select.map((s) => s.sql).join(', ')} FROM ${b.from()} WHERE ${where.sql}`
      const groups = q.groupBy.map((_, i) => `g${i}`)
      const sums = names.map((_, i) => `SUM(c${i}) AS c${i}`)
      const bindings = [...select.flatMap((s) => s.bindings), ...where.bindings]
      let sql = `SELECT ${q.top && groups.length ? `TOP (${Math.max(1, Math.floor(q.top.n))}) ` : ''}${[...groups, ...sums].join(', ')} FROM (${inner}) t`
      if (groups.length) sql += ` GROUP BY ${groups.join(', ')}`
      if (q.having && groups.length) {
        sql += ` HAVING SUM(c${names.indexOf(q.having.measure)}) >= ?`
        bindings.push(q.having.min)
      }
      if (groups.length) {
        const by = q.top ? names.indexOf(q.top.by) : -1
        sql += ` ORDER BY ${by >= 0 ? `SUM(c${by}) DESC, ` : ''}${groups.join(', ')}`
      }
      const rows = await raw(sql, bindings)
      return rows.map((r) => ({
        keys: groups.map((g) => String(r[g])),
        counts: Object.fromEntries(names.map((m, i) => [m, num(r[`c${i}`])]))
      }))
    },

    async percentiles(q) {
      const b = new SqlBuilder(reg, 'n', ctx)
      const select: Frag[] = q.groupBy.map((g, i) => {
        const d = b.dim(g)
        return { sql: `${d.sql} AS g${i}`, bindings: d.bindings }
      })
      const where = b.where(q.span, [...q.where, TIMED])
      const groups = q.groupBy.map((_, i) => `g${i}`)
      const over = groups.length ? `PARTITION BY ${groups.join(', ')}` : ''
      const inner = `SELECT ${[...select.map((s) => s.sql), 'DATEDIFF(second, n.[timestamp], n.read_at) / 60.0 AS v'].join(', ')} FROM ${b.from()} WHERE ${where.sql}`
      const sql =
        `SELECT DISTINCT ${[...groups, `PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY v) OVER (${over}) AS p50`, `PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY v) OVER (${over}) AS p90`].join(', ')} ` +
        `FROM (${inner}) t`
      const rows = await raw(sql, [...select.flatMap((s) => s.bindings), ...where.bindings])
      return rows.map((r) => ({
        keys: groups.map((g) => String(r[g])),
        p50: numOrNull(r.p50),
        p90: numOrNull(r.p90)
      }))
    },

    async rows(q) {
      const b = new SqlBuilder(reg, q.source, ctx)
      const extra: Frag[] = []
      if (q.source === 'm') {
        const r = b.dim('reason')
        extra.push({ sql: `${r.sql} AS reason`, bindings: r.bindings })
      }
      if (q.source === 'n') {
        const r = b.dim('reason')
        extra.push({ sql: `${r.sql} AS reason`, bindings: r.bindings })
      }
      const where = b.where(q.span, q.where)
      const from = b.from()
      const countRows = await raw(`SELECT COUNT(*) AS total FROM ${from} WHERE ${where.sql}`, [
        ...where.bindings
      ])
      const total = num(countRows[0]?.total)
      if (q.limit <= 0 || q.offset >= total) return { total, rows: [] }
      const cols: Record<Source, string[]> = {
        n: [
          'n.id',
          'n.[timestamp]',
          'n.recipient',
          'n.sender',
          'n.subject',
          'n.category',
          'n.lane',
          'n.kind',
          'n.collection',
          'n.item',
          'n.status',
          'n.read_at',
          'n.delivery',
          'CASE WHEN n.read_at IS NOT NULL AND n.read_at >= n.[timestamp] THEN DATEDIFF(second, n.[timestamp], n.read_at) / 60.0 END AS ttr_min'
        ],
        m: [
          'm.id',
          'm.created_at',
          'm.[to]',
          'm.subject',
          'm.template',
          'm.status',
          'LEFT(m.error, 300) AS error',
          'm.collection',
          'm.item',
          ...(reg.features.resend ? ['m.resend_of'] : [])
        ],
        x: ['x.id', 'x.[user]', 'x.collection', 'x.item', 'x.created_at']
      }
      const timeCol = TIME_COL[q.source] ?? ID_COL[q.source]
      const dir = q.dir === 'asc' ? 'ASC' : 'DESC'
      const order =
        q.sort === 'ttr' && q.source === 'n'
          ? `CASE WHEN n.read_at IS NULL THEN 1 ELSE 0 END, DATEDIFF(second, n.[timestamp], n.read_at) ${dir}, ${ID_COL.n} ${dir}`
          : `${timeCol} ${dir}, ${ID_COL[q.source]} ${dir}`
      const select = [...cols[q.source], ...extra.map((e) => e.sql)].join(', ')
      const rows = await raw(
        `SELECT ${select} FROM ${from} WHERE ${where.sql} ORDER BY ${order} OFFSET ? ROWS FETCH NEXT ? ROWS ONLY`,
        [...extra.flatMap((e) => e.bindings), ...where.bindings, q.offset, q.limit]
      )
      return { total, rows }
    }
  }
}

// ── Memory (tests) ─────────────────────────────────────────────────────────

const TIME_FIELD: Record<Source, string | null> = { n: 'timestamp', m: 'created_at', x: null }

/** PERCENTILE_CONT: linear interpolation between the two nearest ranks. */
export function percentileCont(values: number[], p: number): number | null {
  if (values.length === 0) return null
  const s = [...values].sort((a, b) => a - b)
  const pos = (s.length - 1) * p
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return s[lo] + (s[hi] - s[lo]) * (pos - lo)
}

export function memoryExecutor(
  data: Partial<Record<Source, MemRow[]>>,
  reg: Registry,
  ctx: EvalCtx
): Executor {
  const val = (source: Source, row: MemRow, dim: string) => dimOf(reg, source, dim).js(row, ctx)
  const matches = (source: Source, row: MemRow, conds: Cond[]) =>
    conds.every(([dim, values]) => values.includes(val(source, row, dim)))
  const inSpan = (source: Source, row: MemRow, span: Span | null) => {
    const f = TIME_FIELD[source]
    if (!span || !f) return true
    const t = new Date(String(row[f])).getTime()
    return t >= span.from.getTime() && t < span.to.getTime()
  }
  const scope = (source: Source, span: Span | null, where: Cond[]) =>
    (data[source] ?? []).filter((r) => inSpan(source, r, span) && matches(source, r, where))

  return {
    async aggregate(q) {
      const groups = new Map<string, AggRow>()
      for (const r of scope(q.source, q.span, q.where)) {
        const keys = q.groupBy.map((g) => val(q.source, r, g))
        const k = JSON.stringify(keys)
        const cur =
          groups.get(k) ??
          ({
            keys,
            counts: Object.fromEntries(Object.keys(q.measures).map((m) => [m, 0]))
          } as AggRow)
        for (const [m, conds] of Object.entries(q.measures))
          if (matches(q.source, r, conds)) cur.counts[m]++
        groups.set(k, cur)
      }
      let out = [...groups.values()]
      if (q.groupBy.length === 0 && out.length === 0)
        out = [{ keys: [], counts: Object.fromEntries(Object.keys(q.measures).map((m) => [m, 0])) }]
      if (q.having) {
        const h = q.having
        out = out.filter((g) => (g.counts[h.measure] ?? 0) >= h.min)
      }
      out.sort((a, b) => a.keys.join('\u0000').localeCompare(b.keys.join('\u0000')))
      if (q.top) {
        const by = q.top.by
        out.sort((a, b) => (b.counts[by] ?? 0) - (a.counts[by] ?? 0))
        out = out.slice(0, q.top.n)
      }
      return out
    },

    async percentiles(q) {
      const groups = new Map<string, { keys: string[]; v: number[] }>()
      for (const r of scope('n', q.span, [...q.where, TIMED])) {
        const keys = q.groupBy.map((g) => val('n', r, g))
        const k = JSON.stringify(keys)
        const cur = groups.get(k) ?? { keys, v: [] }
        // DATEDIFF(second, …) / 60.0 — whole seconds.
        const secs = Math.floor(
          (new Date(String(r.read_at)).getTime() - new Date(String(r.timestamp)).getTime()) / 1000
        )
        cur.v.push(secs / 60)
        groups.set(k, cur)
      }
      return [...groups.values()].map((g) => ({
        keys: g.keys,
        p50: percentileCont(g.v, 0.5),
        p90: percentileCont(g.v, 0.9)
      }))
    },

    async rows(q) {
      const all = scope(q.source, q.span, q.where)
      const f = TIME_FIELD[q.source]
      const key = (r: MemRow) =>
        q.sort === 'ttr' && q.source === 'n'
          ? r.read_at == null
            ? Number.POSITIVE_INFINITY
            : new Date(String(r.read_at)).getTime() - new Date(String(r.timestamp)).getTime()
          : f
            ? new Date(String(r[f])).getTime()
            : Number(r.id)
      const sign = q.dir === 'asc' ? 1 : -1
      all.sort((a, b) => (key(a) - key(b)) * sign || (Number(a.id) - Number(b.id)) * sign)
      const page = all.slice(q.offset, q.offset + Math.max(0, q.limit)).map((r) => {
        const out: Record<string, unknown> = { ...r }
        delete out._actions
        if (q.source !== 'x') out.reason = val(q.source, r, 'reason')
        return out
      })
      return { total: all.length, rows: page }
    }
  }
}
