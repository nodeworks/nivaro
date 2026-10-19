/**
 * Admin/ops tools — read-only views of the instance's health, runtime, database,
 * traffic and background jobs. Registered only with `adminTools: true`, and the
 * API answers 403 to anyone who is not an administrator either way.
 *
 * Nothing here restarts, kills, pauses, busts a cache, writes configuration or
 * takes a heap snapshot. The CPU profile samples the answering replica for a few
 * seconds and changes nothing else.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  captureCpuProfile,
  listJobRuns,
  type NivaroClient,
  readDbPool,
  readExpensiveSql,
  readHealthDetailed,
  readInstanceRoster,
  readJobRegistry,
  readPreflight,
  readReadiness,
  readRuntimeStats,
  readTrafficSnapshot,
  type TrafficSnapshot
} from '@nivaro/sdk'
import { z } from 'zod'
import { READ, WRITE } from '../annotations.js'
import { clip, pageOf } from '../compact.js'
import { fail, ok } from '../result.js'
import { clampTo } from '../schema.js'

type Row = Record<string, unknown>

/** A report the API answers with a non-2xx status but a full body (/ready, /preflight
 *  answer 503 when something fails) — the body is the answer, not an error. */
async function bodyEvenIfFailing<T>(
  run: () => Promise<T>,
  isReport: (body: Row) => boolean
): Promise<T> {
  try {
    return await run()
  } catch (err) {
    const e = err as { status?: number; response?: unknown }
    if (e.status === 503 && e.response && typeof e.response === 'object') {
      if (isReport(e.response as Row)) return e.response as T
    }
    throw err
  }
}

/** The Traffic Map snapshot cut to totals, the busiest entities and callers, and
 *  the downstream nodes with traffic. */
export function summarizeTraffic(snap: TrafficSnapshot, top: number): Row {
  const entities = [...(snap.entities ?? [])].sort((a, b) => b.req - a.req)
  const callers = [...(snap.callers ?? [])].sort((a, b) => b.req - a.req)
  const erroring = entities.filter((e) => e.error > 0).sort((a, b) => b.error - a.error)
  const entity = (e: TrafficSnapshot['entities'][number]) => ({
    key: e.key,
    label: e.label,
    lane: e.lane,
    req: e.req,
    error: e.error,
    p50: e.p50,
    p95: e.p95,
    top_routes: (e.routes ?? []).slice(0, 3)
  })
  return {
    at: snap.at,
    window_s: snap.window_s,
    node_scope: snap.node_scope,
    totals: snap.totals,
    sockets: snap.sockets,
    busiest: entities.slice(0, top).map(entity),
    most_errors: erroring.slice(0, top).map(entity),
    callers: callers.slice(0, top),
    downstream: (snap.down ?? []).filter((d) => d.req > 0),
    sources: (snap.sources ?? []).slice(0, top),
    entities_total: entities.length,
    callers_total: callers.length
  }
}

export function registerAdminTools(server: McpServer, client: NivaroClient) {
  server.registerTool(
    'health',
    {
      title: 'Instance health',
      description:
        'Is the instance ready to serve (boot, migrations, extensions, database, Redis), plus database/Redis latency, migration count, socket connections, read-gate pressure and memory of the replica that answers. Admin only.',
      inputSchema: {},
      annotations: READ
    },
    async () => {
      try {
        const [ready, detailed] = await Promise.all([
          bodyEvenIfFailing(
            () => client.request(readReadiness()),
            (b) => Array.isArray(b.checks)
          ),
          client.request(readHealthDetailed())
        ])
        const { redis_degradation: _, ...rest } = detailed.data
        return ok({ ready: ready.ready, checks: ready.checks, ...rest })
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.registerTool(
    'preflight',
    {
      title: 'Deploy preflight',
      description:
        'The deploy coherence check: migrations in both directions, database/Redis reachability, required extensions and version pinning, each pass/warn/fail. Admin only.',
      inputSchema: {},
      annotations: READ
    },
    async () => {
      try {
        const res = await bodyEvenIfFailing(
          () => client.request(readPreflight()),
          (b) => !!b.data && Array.isArray((b.data as Row).checks)
        )
        return ok(res.data)
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.registerTool(
    'runtime_stats',
    {
      title: 'Runtime stats',
      description:
        'Memory, event-loop lag and connection pool of the replica that answers, plus every registered API process and which one runs the scheduler. Admin only.',
      inputSchema: {},
      annotations: READ
    },
    async () => {
      try {
        const [runtime, roster] = await Promise.all([
          client.request(readRuntimeStats()),
          client.request(readInstanceRoster())
        ])
        return ok({
          this_replica: runtime.data,
          instances: roster.data.slice(0, 25),
          instances_total: roster.data.length,
          scheduler: roster.scheduler
        })
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.registerTool(
    'db_pool',
    {
      title: 'Database pool',
      description:
        'The database connection pool of the replica that answers: used/free/pending, wait-time pressure, and which requests hold a connection longer than a second. Admin only.',
      inputSchema: {},
      annotations: READ
    },
    async () => {
      try {
        const res = await client.request(readDbPool())
        const { held, ...rest } = res.data
        return ok({ ...rest, held: held.slice(0, 20), held_total: held.length })
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.registerTool(
    'expensive_sql',
    {
      title: 'Expensive SQL',
      description:
        'The statements that used the most database CPU since the plan cache last cleared: total and average CPU, average elapsed time, executions and the statement text. Admin only.',
      inputSchema: {
        limit: z.number().int().optional().describe('Statements to return (1–15, default 10).')
      },
      annotations: READ
    },
    async ({ limit }) => {
      try {
        const res = await client.request(readExpensiveSql())
        if (!('data' in res)) return ok(res)
        return ok(
          res.data.slice(0, clampTo(limit, 10, 15)).map((s) => ({
            ...s,
            statement_text: clip(s.statement_text, 1500)
          }))
        )
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.registerTool(
    'traffic_summary',
    {
      title: 'Traffic Map summary',
      description:
        'A compact read of the live Traffic Map: request totals and latency, the busiest and most-erroring collections/routes, top callers and downstream systems over the last 1, 5 or 15 minutes. Admin only.',
      inputSchema: {
        window: z
          .enum(['60', '300', '900'])
          .default('300')
          .describe('Seconds to look back: 60, 300 or 900.'),
        top: z.number().int().optional().describe('Rows per list (1–25, default 10).')
      },
      annotations: READ
    },
    async ({ window, top }) => {
      try {
        const seconds = Number(window) as 60 | 300 | 900
        const res = await client.request(readTrafficSnapshot(seconds))
        return ok(summarizeTraffic(res.data, clampTo(top, 10, 25)))
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.registerTool(
    'list_cron_jobs',
    {
      title: 'Scheduled jobs',
      description:
        'Every scheduled job: its schedule, next run, paused flag, its latest run (status, duration, error) and error count over 7 days, plus what is running now and whether this deployment ticks crons. Admin only.',
      inputSchema: {
        failing_only: z
          .boolean()
          .optional()
          .describe('Only jobs whose latest run failed or that failed in the last 7 days.'),
        limit: z.number().int().optional().describe('Jobs per page (1–200, default 25).'),
        offset: z.number().int().min(0).optional()
      },
      annotations: READ
    },
    async ({ failing_only, limit, offset }) => {
      try {
        const res = await client.request(readJobRegistry())
        const matching = res.data.crons.filter(
          (c) => !failing_only || c.errors_7d > 0 || c.last?.status === 'error'
        )
        const page = pageOf(matching, clampTo(limit, 25, 200), offset)
        const crons = page.items.map((c) => ({
          id: c.id,
          expression: c.expression,
          overridden: c.overridden,
          extension_id: c.extension_id,
          next_run: c.next_run,
          paused: c.paused,
          heavy: c.heavy,
          description: clip(c.description, 200),
          last: c.last ? { ...c.last, error: clip(c.last.error, 500) } : null,
          errors_7d: c.errors_7d
        }))
        return ok({
          crons,
          total: page.total,
          offset: page.offset,
          truncated: page.truncated,
          ticks_enabled: res.data.ticks_enabled,
          scheduler: res.data.scheduler,
          running: res.data.running.map((r) => ({
            id: r.id,
            kind: r.kind,
            job_id: r.job_id,
            started_at: r.started_at,
            progress: clip(r.progress, 300)
          }))
        })
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.registerTool(
    'list_job_runs',
    {
      title: 'Background job runs',
      description:
        'Recent background-job runs, newest first — crons, backfills, recalcs, exports — filterable by kind, job id (contains) and status. Admin only.',
      inputSchema: {
        kind: z.string().max(30).optional().describe('e.g. "cron", "backfill", "recalc".'),
        job_id: z.string().max(200).optional().describe('Matches any job id containing this.'),
        status: z.string().max(20).optional().describe('e.g. "running", "completed", "error".'),
        page: z.number().int().min(1).optional().describe('1-based page (default 1).'),
        limit: z.number().int().optional().describe('Runs per page (1–100, default 20).')
      },
      annotations: READ
    },
    async ({ kind, job_id, status, page, limit }) => {
      try {
        const size = clampTo(limit, 20, 100)
        const at = page ?? 1
        const res = await client.request(
          listJobRuns({ kind, job_id, status, page: at, limit: size })
        )
        return ok({
          runs: res.data.map((r) => ({
            id: r.id,
            kind: r.kind,
            job_id: r.job_id,
            label: r.label,
            status: r.status,
            started_at: r.started_at,
            duration_ms: r.duration_ms,
            outcome: clip(r.outcome, 300),
            error: clip(r.error, 500),
            triggered_by: r.triggered_by_name || null
          })),
          total: res.total,
          page: at,
          limit: size,
          truncated: at * size < res.total
        })
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.registerTool(
    'cpu_profile',
    {
      title: 'CPU profile',
      description:
        "Sample the answering API replica's CPU for 1–30 seconds and summarize where the time went (busy/idle/GC, hottest functions, files and packages). Use when the API is slow and the cause is not in the database. Admin only.",
      inputSchema: {
        seconds: z.number().int().min(1).max(30).default(10).describe('How long to sample (1–30).')
      },
      annotations: WRITE
    },
    async ({ seconds }) => {
      try {
        const res = await client.request(captureCpuProfile(Math.min(30, Math.max(1, seconds))))
        const top = 15
        const { self, files, ours, ...rest } = res.data
        return ok({
          ...rest,
          self: self.slice(0, top),
          files: files.slice(0, top),
          ours: ours.slice(0, top)
        })
      } catch (err) {
        return fail(err)
      }
    }
  )
}
