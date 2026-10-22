import { db } from '../../db/index.js'
import { routeTemplate } from '../traffic-entities.js'
import type { ErrorsSeen } from './postmortem.js'
import { buildRunReport, type RunFigures, runFigures } from './report.js'
import { type ChaosRun, listRunEvents, updateRun } from './runs.js'

/**
 * The reads behind the run report, matrix and trends (#2849 #2850 #2859): errors people saw in
 * a run's window, actor names, the partner rows, and each run's cached timings. Every read is
 * best effort — a missing table or a database hiccup answers "not available", never a 500.
 */

/** Errors people saw between arm and two minutes after the fault (capped at one hour). */
export async function errorsSeen(fromMs: number, toMs: number): Promise<ErrorsSeen> {
  const from = new Date(fromMs)
  const to = new Date(Math.min(toMs + 120_000, fromMs + 3_600_000))
  const out: ErrorsSeen = {
    server: [],
    server_total: 0,
    people: 0,
    client_errors: 0,
    rage_clicks: 0,
    dead_clicks: 0,
    available: false
  }
  try {
    // Method + path only, people's requests only (user set); the template drops ids and tokens.
    const rows = (await db('nivaro_api_logs')
      .where('created_at', '>=', from)
      .where('created_at', '<=', to)
      .where('status', '>=', 500)
      .whereNotNull('user')
      .limit(5000)
      .select('method', 'path', 'user')) as Array<{ method: string; path: string; user: string }>
    const by = new Map<string, number>()
    const people = new Set<string>()
    for (const r of rows) {
      const t = routeTemplate(r.method, r.path)
      by.set(t, (by.get(t) ?? 0) + 1)
      people.add(String(r.user).toLowerCase())
    }
    out.server = [...by.entries()]
      .map(([route, count]) => ({ route, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 25)
    out.server_total = rows.length
    out.people = people.size
    out.available = true
  } catch {
    /* no request log here */
  }
  try {
    const row = (await db('nivaro_issues')
      .where('source', 'client')
      .whereRaw('COALESCE(last_seen_at, created_at) >= ?', [from])
      .whereRaw('COALESCE(last_seen_at, created_at) <= ?', [to])
      .count('* as n')
      .first()) as { n?: number | string } | undefined
    out.client_errors = Number(row?.n ?? 0)
  } catch {
    /* no issue log */
  }
  try {
    const rows = (await db('nivaro_rum_events')
      .where('created_at', '>=', from)
      .where('created_at', '<=', to)
      .whereIn('kind', ['rage', 'dead'])
      .groupBy('kind')
      .select('kind')
      .count('* as n')) as Array<{ kind: string; n: number | string }>
    for (const r of rows) {
      if (r.kind === 'rage') out.rage_clicks = Number(r.n)
      if (r.kind === 'dead') out.dead_clicks = Number(r.n)
    }
  } catch {
    /* no RUM */
  }
  return out
}

/** Display names for actor ids (notes, the starter). */
export async function userNames(
  ids: Array<string | null | undefined>
): Promise<Record<string, string>> {
  const want = [...new Set(ids.filter((x): x is string => !!x).map((x) => x.toLowerCase()))].slice(
    0,
    200
  )
  if (!want.length) return {}
  try {
    const rows = (await db('nivaro_users')
      .whereIn('id', want)
      .select('id', 'first_name', 'last_name', 'email')) as Array<{
      id: string
      first_name: string | null
      last_name: string | null
      email: string | null
    }>
    const out: Record<string, string> = {}
    for (const r of rows)
      out[String(r.id).toLowerCase()] =
        [r.first_name, r.last_name].filter(Boolean).join(' ') || r.email || 'someone'
    return out
  } catch {
    return {}
  }
}

/** The external APIs, one matrix row each (enabled ones; names only). */
export async function listPartners(): Promise<Array<{ id: string; name: string }>> {
  try {
    const rows = (await db('nivaro_external_apis')
      .where({ enabled: true })
      .orderBy('name')
      .limit(40)
      .select('id', 'name')) as Array<{ id: number | string; name: string }>
    return rows.map((r) => ({ id: String(r.id), name: String(r.name) }))
  } catch {
    return []
  }
}

const RECOVERY_SETTLE_MS = 5 * 60_000

/** The cached timings of a run, if stored and current. */
export function cachedFigures(run: ChaosRun): RunFigures | null {
  const f = run.meta?.report as RunFigures | undefined
  return f && f.v === 1 ? f : null
}

/**
 * Timings for a list of runs: the cache on `run.meta.report` first, then up to `budget` runs
 * computed from their events (cached back once the run has been over five minutes, so the
 * recovery samples are in). The rest stay pending for the next read.
 */
export async function figuresFor(
  runs: ChaosRun[],
  opts: { budget?: number; now?: number } = {}
): Promise<Map<string, RunFigures>> {
  const now = opts.now ?? Date.now()
  let budget = opts.budget ?? 40
  const out = new Map<string, RunFigures>()
  for (const run of runs) {
    const cached = cachedFigures(run)
    if (cached) {
      out.set(run.id, cached)
      continue
    }
    if (budget <= 0) continue
    budget--
    try {
      const events = await listRunEvents(run.id, { limit: 3000 })
      const figures = runFigures(buildRunReport(run, events))
      out.set(run.id, figures)
      const ended = run.ended_at ? new Date(run.ended_at).getTime() : null
      if (ended != null && now - ended > RECOVERY_SETTLE_MS)
        await updateRun(run.id, { meta: { ...run.meta, report: figures } })
    } catch {
      /* next read */
    }
  }
  return out
}
