import type { FastifyInstance } from 'fastify'
import { config } from '../config.js'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import {
  cancelRun,
  currentRun,
  isAvailable,
  listRuns,
  parseEvents,
  promoteAvailable,
  promoteCandidates,
  RunLockedError,
  type RunSummary,
  readLogChunk,
  readRun,
  runPlan,
  runtime,
  startRun,
  timingHistory,
  validatePromoteBody,
  validateStartBody
} from '../services/release-runs.js'

const UNAVAILABLE = { error: 'Release runs are not available here' }
const NO_SUCH_RUN = { error: 'No such run' }
const RUN_ID_RE = /^[a-f0-9-]{36}$/i

type NamedRun = RunSummary & { started_by_name?: string }

/** Who started each run, as a person's name: one read for every distinct user. */
async function withStarterNames(runs: RunSummary[]): Promise<NamedRun[]> {
  const ids = [...new Set(runs.map((r) => r.started_by).filter(Boolean))]
  if (ids.length === 0) return runs
  const rows: Array<{ id: string; first_name?: string; last_name?: string; email?: string }> =
    await db('nivaro_users')
      .whereIn('id', ids)
      .select('id', 'first_name', 'last_name', 'email')
      .catch(() => [])
  const names = new Map(
    rows.map((u) => [
      String(u.id).toUpperCase(),
      `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || u.email || String(u.id)
    ])
  )
  return runs.map((r) => ({
    ...r,
    started_by_name: names.get(String(r.started_by).toUpperCase()) ?? r.started_by
  }))
}

/**
 * /api/release — the admin's Release button. Local development only: it needs
 * the git checkouts and credentials on this machine, so every route answers
 * 404 unless the API runs from a source checkout with scripts/release-chain.mjs
 * and release-chain.config.json present. Inputs are enums only; the child is
 * started with a fixed argument list and no shell.
 */
export async function releaseRunsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin)
  const available = () => isAvailable(config.NODE_ENV)
  const tail = (s: string) => s.slice(-4000)

  app.get('/status', async () => {
    if (!available()) return { available: false, current: null, runs: [] }
    const [current, runs] = await Promise.all([currentRun(), listRuns(10)])
    const named = await withStarterNames(current ? [current, ...runs] : runs)
    return {
      available: true,
      promote_available: promoteAvailable(),
      current: current ? named[0] : null,
      runs: current ? named.slice(1) : named
    }
  })

  // #1046 — per-stage durations of the last finished runs, for the trend chart.
  app.get<{ Querystring: { limit?: string } }>('/timings', async (req, reply) => {
    if (!available()) return reply.code(404).send(UNAVAILABLE)
    const limit = Number(req.query.limit ?? 30)
    return { runs: await timingHistory(Number.isFinite(limit) ? limit : 30) }
  })

  // ── Production target (#722) ──────────────────────────────────────────────
  // Promotion moves a version staging already verified; it never builds. It
  // plays the manual production deploy jobs through the GitLab API, with the
  // token the Environments registry holds for the deployment repository —
  // handed to the child in its environment, never on its command line.
  const gitlabEnv = async (): Promise<Record<string, string>> => {
    // A registry that cannot be read means no token (the promotion plan then
    // lists it as a blocker) — never a 500 from the plan route.
    let row: { git_token?: unknown } | null | undefined = null
    try {
      row = await db('nivaro_environment_components as c')
        .join('nivaro_environments as e', 'e.id', 'c.environment')
        .where('c.git_provider', 'gitlab')
        .whereNotNull('c.git_token')
        .orderByRaw("CASE WHEN LOWER(e.name) = 'production' THEN 0 ELSE 1 END")
        .orderBy('c.id')
        .first('c.git_token')
    } catch {
      row = null
    }
    return row?.git_token ? { GITLAB_TOKEN: String(row.git_token) } : {}
  }

  app.get('/promote/candidates', async (_req, reply) => {
    if (!available() || !promoteAvailable()) return reply.code(404).send(UNAVAILABLE)
    return { candidates: await promoteCandidates() }
  })

  app.post('/promote/plan', async (req, reply) => {
    if (!available() || !promoteAvailable()) return reply.code(404).send(UNAVAILABLE)
    const v = validatePromoteBody(req.body)
    if (!v.ok) return reply.code(400).send({ error: v.error })
    const planArgs = [
      '--version',
      v.version,
      ...(v.args.includes('--bootstrap') ? ['--bootstrap'] : [])
    ]
    const r = await runPlan(90_000, runtime.promotePath(), planArgs, await gitlabEnv())
    if (r.timedOut)
      return reply.code(502).send({ error: 'promotion plan timed out', log_tail: tail(r.log) })
    if (!r.plan)
      return reply.code(502).send({ error: 'promotion plan failed', log_tail: tail(r.log) })
    return { plan: r.plan, log_tail: tail(r.log) }
  })

  app.post('/promote', async (req, reply) => {
    if (!available() || !promoteAvailable()) return reply.code(404).send(UNAVAILABLE)
    const v = validatePromoteBody(req.body)
    if (!v.ok) return reply.code(400).send({ error: v.error })
    const b = req.body as { confirm?: unknown }
    // The version typed back — promoting production is never a single click.
    if (b?.confirm !== v.version)
      return reply.code(400).send({ error: 'type the version to confirm the promotion' })
    const user = req.user!.id
    try {
      const run = await startRun({ mode: 'promote', args: v.args, user, env: await gitlabEnv() })
      await logActivity({
        action: 'release-promote-start',
        user,
        collection: 'release',
        item: run.id,
        comment: `promote ${v.version} to production${v.args.includes('--bootstrap') ? ' (bootstrap — first deploy)' : ''}`,
        req
      })
      return reply.code(201).send({ run })
    } catch (err) {
      if (err instanceof RunLockedError)
        return reply.code(409).send({ error: err.message, current: err.current ?? null })
      throw err
    }
  })

  app.post('/plan', async (_req, reply) => {
    if (!available()) return reply.code(404).send(UNAVAILABLE)
    const r = await runPlan(60_000, undefined, [], await gateTokensEnv())
    if (r.timedOut)
      return reply
        .code(502)
        .send({ error: 'release-chain plan timed out after 60s', log_tail: tail(r.log) })
    if (!r.ok || !r.plan)
      return reply.code(502).send({ error: 'release-chain plan failed', log_tail: tail(r.log) })
    return { plan: r.plan, log_tail: tail(r.log) }
  })

  /**
   * #1045 — the post-deploy gate's admin checks need a token per API. The
   * Environments registry already holds one per api component; hand them to
   * the chain keyed by base URL, in its environment (never on its command
   * line). A config entry's own `gate.token_env` still wins inside the chain.
   */
  const gateTokensEnv = async (): Promise<Record<string, string>> => {
    // Best-effort: a registry that cannot be read means no tokens (the gate
    // then checks /api/ready only and says so), never a release that cannot start.
    let rows: Array<{ base_url: string; api_token: string }> = []
    try {
      rows = await db('nivaro_environment_components')
        .where('kind', 'api')
        .whereNotNull('base_url')
        .whereNotNull('api_token')
        .select('base_url', 'api_token')
    } catch {
      rows = []
    }
    const map: Record<string, string> = {}
    for (const r of rows) {
      const base = String(r.base_url).trim().replace(/\/+$/, '')
      if (base && r.api_token) map[base] = String(r.api_token)
    }
    return Object.keys(map).length ? { RELEASE_GATE_TOKENS: JSON.stringify(map) } : {}
  }

  app.post('/runs', async (req, reply) => {
    if (!available()) return reply.code(404).send(UNAVAILABLE)
    const v = validateStartBody(req.body)
    if (!v.ok) return reply.code(400).send({ error: v.error })
    // A resume continues the newest run, and only when that run failed: resuming
    // an older failure would re-run stages a later release already changed.
    if (v.args.includes('--from')) {
      const [newest] = (await listRuns(10)).filter((r) => r.mode !== 'promote')
      if (newest?.state !== 'failed')
        return reply.code(409).send({ error: 'only the newest run can be resumed' })
    }
    const user = req.user!.id
    try {
      const run = await startRun({ mode: 'go', args: v.args, user, env: await gateTokensEnv() })
      await logActivity({
        action: 'release-run-start',
        user,
        collection: 'release',
        item: run.id,
        comment: v.args.join(' '),
        req
      })
      return reply.code(201).send({ run })
    } catch (err) {
      if (err instanceof RunLockedError)
        return reply.code(409).send({ error: err.message, current: err.current ?? null })
      throw err
    }
  })

  app.get<{ Params: { id: string }; Querystring: { after?: string } }>(
    '/runs/:id',
    async (req, reply) => {
      if (!available()) return reply.code(404).send(UNAVAILABLE)
      if (!RUN_ID_RE.test(req.params.id)) return reply.code(404).send(NO_SUCH_RUN)
      const r = await readRun(req.params.id)
      if (!r) return reply.code(404).send(NO_SUCH_RUN)
      // `after` is the previous response's next_offset: an index into the log string.
      const after = Number(req.query.after ?? 0)
      const offset = Number.isFinite(after) && after >= 0 ? Math.floor(after) : 0
      const { chunk, next_offset } = readLogChunk(r.log, offset)
      const { events, plan } = parseEvents(r.log)
      const [run] = await withStarterNames([r.run])
      return { run, events, plan, log_chunk: chunk, next_offset }
    }
  )

  app.post<{ Params: { id: string } }>('/runs/:id/cancel', async (req, reply) => {
    if (!available()) return reply.code(404).send(UNAVAILABLE)
    if (!RUN_ID_RE.test(req.params.id)) return reply.code(404).send(NO_SUCH_RUN)
    const run = await cancelRun(req.params.id)
    if (!run) return reply.code(404).send(NO_SUCH_RUN)
    await logActivity({
      action: 'release-run-cancel',
      user: req.user!.id,
      collection: 'release',
      item: run.id,
      req
    })
    return { run }
  })
}
