import { db } from '../db/index.js'
import { hasColumn } from '../lib/column-probe.js'
import { csvRow } from '../lib/csv-cell.js'

/**
 * API usage per key (#1462) — one month of a named API key's calls, read from
 * nivaro_api_logs: by day, by route family, error rate, rate-limit refusals
 * and GraphQL operations. Feeds GET /api-keys/:id/usage (JSON or CSV) and the
 * monthly usage statement email.
 *
 * nivaro_api_logs keeps 14 days (plugins/api-logger.ts RETENTION_DAYS), so a
 * month reaching further back is PARTIAL — the report says so rather than
 * presenting a short month as a quiet one. The log carries no row or byte
 * counts, so "egress" is reported as successful reads (GET 2xx), labelled as
 * such.
 */

export const API_LOG_RETENTION_DAYS = 14

export interface UsageBucket {
  calls: number
  errors: number
  rate_limited: number
  avg_ms: number | null
}

export interface KeyUsageReport {
  key: { id: number; name: string; prefix: string | null }
  month: string
  window: { start: string; end: string }
  retention: { days: number; oldest_log: string | null; partial: boolean; note: string | null }
  totals: UsageBucket & {
    error_rate: number
    refused: number
    reads_ok: number
    writes_ok: number
  }
  by_day: Array<UsageBucket & { day: string }>
  by_family: Array<UsageBucket & { family: string }>
  graphql: Array<{ operation: string; kind: string | null; calls: number; errors: number }>
  egress: { reads_ok: number; note: string }
}

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/

/** The UTC window of a 'YYYY-MM' month, or null when malformed. */
export function monthWindow(month: string): { start: Date; end: Date } | null {
  const m = MONTH_RE.exec(month)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2]) - 1
  return { start: new Date(Date.UTC(y, mo, 1)), end: new Date(Date.UTC(y, mo + 1, 1)) }
}

/** The 'YYYY-MM' month before `now` (UTC) — what a statement on the 1st covers. */
export function previousMonth(now = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

export function currentMonth(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
}

/**
 * A route family groups calls the way a partner thinks of them: the first
 * segment after /api, plus the collection for item routes — never an id.
 * '/api/items/workflows/12' → 'items/workflows', '/api/graphql' → 'graphql'.
 */
export function routeFamily(path: string): string {
  const clean = path.split('?')[0].replace(/^\/api(?=\/|$)/, '')
  const parts = clean.split('/').filter(Boolean)
  if (parts.length === 0) return '/'
  if ((parts[0] === 'items' || parts[0] === 'inbound') && parts[1]) return `${parts[0]}/${parts[1]}`
  return parts[0]
}

/** Whether `month` reaches past what the log still holds. */
export function retentionFor(
  window: { start: Date; end: Date },
  oldest: Date | null,
  now = new Date()
): KeyUsageReport['retention'] {
  const floor = new Date(now.getTime() - API_LOG_RETENTION_DAYS * 86_400_000)
  const effectiveOldest = oldest && oldest > floor ? oldest : floor
  const partial = window.start < effectiveOldest && window.end > window.start
  const beyond = window.end <= effectiveOldest
  return {
    days: API_LOG_RETENTION_DAYS,
    oldest_log: oldest ? oldest.toISOString() : null,
    partial: partial || beyond,
    note: beyond
      ? `The request log keeps ${API_LOG_RETENTION_DAYS} days — nothing from this month is left.`
      : partial
        ? `The request log keeps ${API_LOG_RETENTION_DAYS} days — only calls from ${effectiveOldest.toISOString().slice(0, 10)} on are counted.`
        : null
  }
}

const num = (v: unknown) => Number(v ?? 0) || 0

export async function keyUsage(keyId: number, month: string): Promise<KeyUsageReport | null> {
  const window = monthWindow(month)
  if (!window) return null
  const key = (await db('nivaro_api_keys').where({ id: keyId }).first('id', 'name', 'prefix')) as
    | { id: number; name: string; prefix: string | null }
    | undefined
  if (!key) return null

  const base = () =>
    db('nivaro_api_logs')
      .where('api_key_id', keyId)
      .where('created_at', '>=', window.start)
      .where('created_at', '<', window.end)

  const sums = [
    db.raw('COUNT(*) as calls'),
    db.raw('SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) as errors'),
    db.raw(
      "SUM(CASE WHEN status = 429 OR error LIKE '%API_KEY_RATE_LIMITED%' THEN 1 ELSE 0 END) as rate_limited"
    ),
    db.raw('AVG(CAST(latency_ms AS FLOAT)) as avg_ms')
  ]

  const [dayRows, pathRows, totalsRow, oldestRow, gqlRows] = await Promise.all([
    base()
      .select(db.raw('CAST(created_at AS DATE) as day'), ...sums)
      .groupByRaw('CAST(created_at AS DATE)')
      .orderByRaw('CAST(created_at AS DATE)') as Promise<Array<Record<string, unknown>>>,
    base()
      .select('path', ...sums)
      .groupBy('path') as Promise<Array<Record<string, unknown>>>,
    base()
      .select(
        ...sums,
        db.raw('SUM(CASE WHEN status IN (401, 403) THEN 1 ELSE 0 END) as refused'),
        db.raw(
          "SUM(CASE WHEN method = 'GET' AND status >= 200 AND status < 300 THEN 1 ELSE 0 END) as reads_ok"
        ),
        db.raw(
          "SUM(CASE WHEN method <> 'GET' AND status >= 200 AND status < 300 THEN 1 ELSE 0 END) as writes_ok"
        )
      )
      .first() as Promise<Record<string, unknown> | undefined>,
    db('nivaro_api_logs').min('created_at as oldest').first() as Promise<
      { oldest: Date | string | null } | undefined
    >,
    (async () => {
      if (!(await hasColumn('nivaro_api_logs', 'graphql_operation'))) return []
      return (await base()
        .whereNotNull('graphql_operation')
        .select(
          'graphql_operation',
          'graphql_kind',
          db.raw('COUNT(*) as calls'),
          db.raw(
            'SUM(CASE WHEN status >= 400 OR COALESCE(graphql_errors, 0) > 0 THEN 1 ELSE 0 END) as errors'
          )
        )
        .groupBy('graphql_operation', 'graphql_kind')) as Array<Record<string, unknown>>
    })()
  ])

  const bucket = (r: Record<string, unknown>): UsageBucket => ({
    calls: num(r.calls),
    errors: num(r.errors),
    rate_limited: num(r.rate_limited),
    avg_ms: r.avg_ms == null ? null : Math.round(Number(r.avg_ms))
  })

  // Path rows → families (weighted average latency).
  const fam = new Map<string, UsageBucket & { _ms: number }>()
  for (const r of pathRows) {
    const f = routeFamily(String(r.path ?? ''))
    const b = bucket(r)
    const cur = fam.get(f) ?? { calls: 0, errors: 0, rate_limited: 0, avg_ms: null, _ms: 0 }
    cur.calls += b.calls
    cur.errors += b.errors
    cur.rate_limited += b.rate_limited
    cur._ms += (b.avg_ms ?? 0) * b.calls
    fam.set(f, cur)
  }
  const by_family = [...fam.entries()]
    .map(([family, b]) => ({
      family,
      calls: b.calls,
      errors: b.errors,
      rate_limited: b.rate_limited,
      avg_ms: b.calls ? Math.round(b._ms / b.calls) : null
    }))
    .sort((a, b) => b.calls - a.calls)

  const t = totalsRow ?? {}
  const totals = {
    ...bucket(t),
    error_rate: num(t.calls) ? num(t.errors) / num(t.calls) : 0,
    refused: num(t.refused),
    reads_ok: num(t.reads_ok),
    writes_ok: num(t.writes_ok)
  }
  const oldest = oldestRow?.oldest ? new Date(oldestRow.oldest) : null

  return {
    key: { id: Number(key.id), name: key.name, prefix: key.prefix ?? null },
    month,
    window: { start: window.start.toISOString(), end: window.end.toISOString() },
    retention: retentionFor(window, oldest),
    totals,
    by_day: dayRows.map((r) => ({
      day: new Date(r.day as string | Date).toISOString().slice(0, 10),
      ...bucket(r)
    })),
    by_family,
    graphql: gqlRows
      .map((r) => ({
        operation: String(r.graphql_operation),
        kind: (r.graphql_kind as string | null) ?? null,
        calls: num(r.calls),
        errors: num(r.errors)
      }))
      .sort((a, b) => b.calls - a.calls),
    egress: {
      reads_ok: totals.reads_ok,
      note: 'The request log records no row or byte counts, so egress is shown as successful reads (GET 2xx).'
    }
  }
}

/** One flat CSV: a `section` column tells day / family / graphql rows apart. */
export function usageToCsv(r: KeyUsageReport): string {
  const lines: string[] = [
    csvRow(['section', 'label', 'calls', 'errors', 'error_rate', 'rate_limited', 'avg_ms'])
  ]
  const rate = (calls: number, errors: number) => (calls ? (errors / calls).toFixed(4) : '0')
  lines.push(
    csvRow([
      'total',
      r.month,
      r.totals.calls,
      r.totals.errors,
      rate(r.totals.calls, r.totals.errors),
      r.totals.rate_limited,
      r.totals.avg_ms ?? ''
    ])
  )
  for (const d of r.by_day)
    lines.push(
      csvRow([
        'day',
        d.day,
        d.calls,
        d.errors,
        rate(d.calls, d.errors),
        d.rate_limited,
        d.avg_ms ?? ''
      ])
    )
  for (const f of r.by_family)
    lines.push(
      csvRow([
        'route_family',
        f.family,
        f.calls,
        f.errors,
        rate(f.calls, f.errors),
        f.rate_limited,
        f.avg_ms ?? ''
      ])
    )
  for (const g of r.graphql)
    lines.push(
      csvRow([
        'graphql',
        g.kind ? `${g.kind} ${g.operation}` : g.operation,
        g.calls,
        g.errors,
        rate(g.calls, g.errors),
        '',
        ''
      ])
    )
  if (r.retention.note) lines.push(csvRow(['note', r.retention.note, '', '', '', '', '']))
  return `${lines.join('\n')}\n`
}
