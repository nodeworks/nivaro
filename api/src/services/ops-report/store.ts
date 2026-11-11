/**
 * Daily operations report — storage (`nivaro_ops_reports`, migration 525). JSON columns are text.
 */
import { db } from '../../db/index.js'
import type {
  OpsAnalysis,
  OpsComparison,
  OpsDigest,
  OpsKpis,
  OpsReportListRow,
  OpsTrackedBug,
  OpsTrendPoint
} from './types.js'

export const TABLE = 'nivaro_ops_reports'

export class OpsReportUnavailable extends Error {}

let tableOk: { ok: boolean; at: number } | null = null
export async function reportsTableReady(): Promise<boolean> {
  if (tableOk && (tableOk.ok || Date.now() - tableOk.at < 60_000)) return tableOk.ok
  const ok = await db.schema.hasTable(TABLE).catch(() => false)
  tableOk = { ok, at: Date.now() }
  return ok
}

function parse<T>(raw: unknown, fallback: T): T {
  if (raw == null || raw === '') return fallback
  try {
    return JSON.parse(String(raw)) as T
  } catch {
    return fallback
  }
}

export interface StoredReport {
  id: number
  day: string
  status: string
  verdict: string | null
  score: number | null
  headline: string | null
  trigger: string
  created_at: Date
  finished_at: Date | null
  model: string | null
  tokens_in: number | null
  tokens_out: number | null
  cost_usd: number | null
  window_start: Date
  window_end: Date
  tz: string
  kpis: OpsKpis
  digest: OpsDigest | null
  analysis: OpsAnalysis | null
  tracker: OpsTrackedBug[]
  comparison: OpsComparison
  tools: Array<{ tool: string; ok: boolean }>
  error: string | null
}

function fromRow(r: Record<string, unknown>): StoredReport {
  return {
    id: Number(r.id),
    day: String(r.day),
    status: String(r.status),
    verdict: (r.verdict as string | null) ?? null,
    score: r.score == null ? null : Number(r.score),
    headline: (r.headline as string | null) ?? null,
    trigger: String(r.trigger ?? 'manual'),
    created_at: r.created_at as Date,
    finished_at: (r.finished_at as Date | null) ?? null,
    model: (r.model as string | null) ?? null,
    tokens_in: r.tokens_in == null ? null : Number(r.tokens_in),
    tokens_out: r.tokens_out == null ? null : Number(r.tokens_out),
    cost_usd: r.cost_usd == null ? null : Number(r.cost_usd),
    window_start: r.window_start as Date,
    window_end: r.window_end as Date,
    tz: String(r.tz ?? 'UTC'),
    kpis: parse<OpsKpis>(r.kpis, {}),
    digest: parse<OpsDigest | null>(r.digest, null),
    analysis: parse<OpsAnalysis | null>(r.analysis, null),
    tracker: parse<OpsTrackedBug[]>(r.tracker, []),
    comparison: parse<OpsComparison>(r.comparison, { prev_day: null, week_days: 0, deltas: [] }),
    tools: parse<Array<{ tool: string; ok: boolean }>>(r.tools, []),
    error: (r.error as string | null) ?? null
  }
}

export function listRow(r: StoredReport): OpsReportListRow {
  return {
    id: r.id,
    day: r.day,
    status: r.status as OpsReportListRow['status'],
    verdict: r.verdict as OpsReportListRow['verdict'],
    score: r.score,
    headline: r.headline,
    trigger: r.trigger as OpsReportListRow['trigger'],
    created_at: new Date(r.created_at).toISOString(),
    finished_at: r.finished_at ? new Date(r.finished_at).toISOString() : null,
    model: r.model,
    tokens_in: r.tokens_in,
    tokens_out: r.tokens_out,
    cost_usd: r.cost_usd,
    kpis: r.kpis
  }
}

const LIST_COLS = [
  'id',
  'day',
  'status',
  'verdict',
  'score',
  'headline',
  'trigger',
  'created_at',
  'finished_at',
  'model',
  'tokens_in',
  'tokens_out',
  'cost_usd',
  'window_start',
  'window_end',
  'tz',
  'kpis',
  'error'
]

export async function listReports(limit = 60): Promise<StoredReport[]> {
  const rows = (await db(TABLE)
    .orderBy([
      { column: 'day', order: 'desc' },
      { column: 'id', order: 'desc' }
    ])
    .limit(Math.min(Math.max(limit, 1), 400))
    .select(LIST_COLS)) as Record<string, unknown>[]
  return rows.map(fromRow)
}

/** The newest finished report per day, oldest first, for the last `days` days before `before`. */
export async function latestPerDay(days: number, before?: string): Promise<StoredReport[]> {
  const rows = (await db(TABLE)
    .whereIn('status', ['ready', 'digest_only'])
    .modify((q) => {
      if (before) q.where('day', '<', before)
    })
    .orderBy([
      { column: 'day', order: 'desc' },
      { column: 'id', order: 'desc' }
    ])
    .limit(days * 4)
    .select([...LIST_COLS, 'tracker'])) as Record<string, unknown>[]
  const seen = new Set<string>()
  const out: StoredReport[] = []
  for (const r of rows.map(fromRow)) {
    if (seen.has(r.day)) continue
    seen.add(r.day)
    out.push(r)
    if (out.length >= days) break
  }
  return out
}

export function trendPoint(r: StoredReport): OpsTrendPoint {
  return {
    id: r.id,
    day: r.day,
    verdict: r.verdict as OpsTrendPoint['verdict'],
    score: r.score,
    kpis: r.kpis
  }
}

export async function getReport(id: number): Promise<StoredReport | null> {
  const r = (await db(TABLE).where({ id }).first()) as Record<string, unknown> | undefined
  return r ? fromRow(r) : null
}

export async function insertRunning(row: {
  day: string
  trigger: 'cron' | 'manual'
  window_start: Date
  window_end: Date
  tz: string
  created_by: string | null
}): Promise<number> {
  const res = (await db(TABLE)
    .insert({
      ...row,
      status: 'running',
      created_at: new Date()
    })
    .returning('id')) as Array<{ id: number } | number>
  const first = res[0]
  return typeof first === 'object' ? Number(first.id) : Number(first)
}

export async function finishReport(
  id: number,
  patch: Partial<{
    status: string
    verdict: string | null
    score: number | null
    headline: string | null
    model: string | null
    tokens_in: number | null
    tokens_out: number | null
    cost_usd: number | null
    kpis: OpsKpis
    digest: OpsDigest
    analysis: OpsAnalysis | null
    tracker: OpsTrackedBug[]
    comparison: OpsComparison
    tools: Array<{ tool: string; ok: boolean }>
    error: string | null
  }>
): Promise<void> {
  const out: Record<string, unknown> = { finished_at: new Date() }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    out[k] =
      v !== null && typeof v === 'object'
        ? JSON.stringify(v)
        : k === 'error' && v
          ? String(v).slice(0, 1000)
          : v
  }
  await db(TABLE).where({ id }).update(out)
}

/** A run left `running` by a process that died never finishes: mark it failed after an hour. */
export async function failStaleRuns(): Promise<void> {
  await db(TABLE)
    .where('status', 'running')
    .where('created_at', '<', new Date(Date.now() - 3_600_000))
    .update({
      status: 'failed',
      error: 'The run stopped before it finished (the server restarted).',
      finished_at: new Date()
    })
    .catch(() => undefined)
}

/** Keep reports for a year. */
export async function pruneReports(): Promise<void> {
  await db(TABLE)
    .where('created_at', '<', new Date(Date.now() - 366 * 86_400_000))
    .delete()
    .catch(() => undefined)
}
