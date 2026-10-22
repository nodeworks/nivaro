import type { FastifyInstance } from 'fastify'
import { adminBaseUrl } from '../admin-base.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { listFaults } from '../services/chaos/catalog.js'
import { claimStatuses, claimsReadiness } from '../services/chaos/claims.js'
import { reportEvents } from '../services/chaos/gameday.js'
import { chaosRefusal } from '../services/chaos/gate.js'
import { buildMatrix } from '../services/chaos/matrix.js'
import { postmortemMarkdown } from '../services/chaos/postmortem.js'
import { wireRecoveryWatch } from '../services/chaos/recovery.js'
import { buildRunReport } from '../services/chaos/report.js'
import { errorsSeen, figuresFor, listPartners, userNames } from '../services/chaos/report-data.js'
import { getRun, listRuns } from '../services/chaos/runs.js'
import { buildTrends } from '../services/chaos/trends.js'
import { registerReadinessCheck } from '../services/readiness.js'

/**
 * Chaos results (#2849 #2830 #2850 #2859) under /api/chaos — administrators, reads only, so they
 * answer even where the gate refuses arming (the history stays readable):
 *
 *   GET /runs/:id/report      the run report: verdict, series, markers, timings, alerts,
 *                             readiness, notes, errors people saw, names, the share link
 *   GET /runs/:id/postmortem  the same as Markdown (download)
 *   GET /claims               the resilience scorecard
 *   GET /matrix               dependencies × fault kinds, last verdict per cell
 *   GET /trends?months=12     time to detect / recover per month and quarter, drills per day,
 *                             verdicts per dependency, claims never proven, the recovery feed
 */

const HISTORY = 500

let readinessRegistered = false

function registerClaimsReadiness(): void {
  if (readinessRegistered) return
  readinessRegistered = true
  registerReadinessCheck({
    id: 'chaos-claims',
    label: 'Resilience claims are proven',
    group: 'Resilience',
    description:
      'Every claim about how Nivaro degrades (Redis fails open, mail is a no-op, sockets catch up…) is proven by a chaos drill. Warns when a claim was last proven longer ago than its limit (30 days by default) or its last drill broke.',
    cost: 'light',
    ttlMs: 15 * 60_000,
    run: async () => {
      const refused = chaosRefusal()
      if (refused) return { status: 'skip', detail: `Chaos drills do not run here: ${refused}` }
      return claimsReadiness(claimStatuses(await listRuns({ limit: HISTORY })))
    }
  })
}

const runLink = (id: string): string | null => {
  const base = adminBaseUrl()
  return base ? `${base.replace(/\/$/, '')}/chaos/runs/${id}` : null
}

/** One run's report with the errors people saw in its window and the actors' names. */
async function loadReport(id: string) {
  const run = await getRun(id)
  if (!run) return null
  // Game-day fault runs also carry the day's scribe marks from their window (#2853).
  const events = await reportEvents(run)
  const report = buildRunReport(run, events)
  const from = report.armed_at ? new Date(report.armed_at).getTime() : null
  const to = report.disarmed_at ? new Date(report.disarmed_at).getTime() : Date.now()
  const errors = from != null ? await errorsSeen(from, to) : null
  const names = await userNames([run.started_by, ...report.notes.map((n) => n.actor)])
  return { run, report, errors, names, link: runLink(run.id) }
}

export async function chaosReportRoutes(app: FastifyInstance): Promise<void> {
  registerClaimsReadiness()
  // Time to recover needs samples after the fault ends (services/chaos/recovery.ts).
  app.addHook('onReady', async () => {
    if (!chaosRefusal()) wireRecoveryWatch()
  })
  app.addHook('preHandler', requireAdmin)

  app.get<{ Params: { id: string } }>('/runs/:id/report', async (req, reply) => {
    const full = await loadReport(String(req.params.id))
    if (!full) return reply.code(404).send({ error: 'No such run' })
    return { data: full }
  })

  app.get<{ Params: { id: string } }>('/runs/:id/postmortem', async (req, reply) => {
    const full = await loadReport(String(req.params.id))
    if (!full) return reply.code(404).send({ error: 'No such run' })
    const { run } = full
    const day = (run.started_at ?? run.created_at).slice(0, 10)
    const slug = (run.fault_key ?? run.kind).replace(/[^a-z0-9_-]/gi, '-')
    return reply
      .header('content-type', 'text/markdown; charset=utf-8')
      .header('content-disposition', `attachment; filename="chaos-${slug}-${day}.md"`)
      .send(postmortemMarkdown(full))
  })

  app.get('/claims', async () => {
    const claims = claimStatuses(await listRuns({ limit: HISTORY }))
    return { data: { refusal: chaosRefusal(), claims } }
  })

  app.get('/matrix', async () => {
    const [runs, partners] = await Promise.all([listRuns({ limit: HISTORY }), listPartners()])
    return { data: { refusal: chaosRefusal(), ...buildMatrix(runs, listFaults(), partners) } }
  })

  app.get<{ Querystring: { months?: string } }>('/trends', async (req) => {
    const months = Math.min(36, Math.max(1, Number(req.query.months) || 12))
    const runs = await listRuns({ limit: HISTORY })
    const figures = await figuresFor(runs.filter((r) => r.verdict && r.fault_key))
    const trends = buildTrends({
      runs,
      figures,
      claims: claimStatuses(runs),
      catalog: listFaults(),
      months
    })
    return { data: trends }
  })
}
