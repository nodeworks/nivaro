import type { FastifyInstance } from 'fastify'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { ExplainError, explainKind, GATHERERS } from '../services/ai-explain.js'
import { registerWeeklyGatherers, registerWeeklySummaries } from '../services/ai-explain-weekly.js'

/**
 * Admin-only "Explain this" (backlog #1813 #1814 #1858 #1859 #1860 #1861 #1868 #1908 #1910 #1919
 * #1963 #2021 #2023). One endpoint per kind, one shared service: facts are read here, redacted,
 * and sent to the model in a single call; answers are cached by facts hash for 30 minutes.
 *
 *   POST /api/ai-explain/:kind   body: kind-specific params (+ `fresh: true` to skip the cache)
 *   GET  /api/ai-explain/kinds
 *   GET  /api/ai-explain/issue-groups   similar-issue clusters
 */
export async function aiExplainRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdmin)
  registerWeeklyGatherers()
  await registerWeeklySummaries()

  app.get('/kinds', async () => ({ data: Object.keys(GATHERERS) }))

  app.get('/issue-groups', async (req, reply) => {
    const { groupSimilarIssues } = await import('../services/issue-groups.js')
    try {
      return { data: await groupSimilarIssues() }
    } catch (err) {
      req.log.warn({ err }, 'issue grouping failed')
      return reply.code(503).send({ error: 'Issues could not be grouped right now' })
    }
  })

  // Admin corrections to the grouping: split issues out, merge them into another issue's group,
  // or reset (all, or the listed issues). The overrides apply on top of the automatic clusters.
  app.post('/issue-groups/overrides', async (req, reply) => {
    const body = (req.body ?? {}) as { op?: string; ids?: unknown; into?: unknown }
    const ids = Array.isArray(body.ids)
      ? [...new Set(body.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 200)
      : []
    const { loadGroupOverrides, nextOverrides, saveGroupOverrides, groupSimilarIssues } =
      await import('../services/issue-groups.js')
    let next: ReturnType<typeof nextOverrides>
    const current = await loadGroupOverrides()
    if (body.op === 'split' && ids.length > 0) next = nextOverrides(current, { op: 'split', ids })
    else if (body.op === 'merge' && ids.length > 0 && Number.isInteger(Number(body.into))) {
      next = nextOverrides(current, { op: 'merge', ids, into: Number(body.into) })
    } else if (body.op === 'reset') {
      next = nextOverrides(current, { op: 'reset', ids: ids.length > 0 ? ids : undefined })
    } else {
      return reply.code(400).send({ error: 'op must be split, merge (with into) or reset' })
    }
    await saveGroupOverrides(next)
    await logActivity({
      action: 'issue-groups-override',
      user: req.user?.id,
      collection: 'nivaro_issues',
      comment: `${body.op} ${ids.join(',')}${body.op === 'merge' ? ` into ${body.into}` : ''}`,
      req
    })
    try {
      return { data: await groupSimilarIssues() }
    } catch (err) {
      req.log.warn({ err }, 'issue grouping failed')
      return reply.code(503).send({ error: 'Issues could not be grouped right now' })
    }
  })

  app.post<{ Params: { kind: string } }>('/:kind', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    try {
      const answer = await explainKind(req.params.kind, body, req.user!, {
        fresh: body.fresh === true
      })
      if (!answer.cached) {
        await logActivity({
          action: 'ai-explain',
          user: req.user?.id,
          collection: 'nivaro_ai_calls',
          comment: req.params.kind,
          req
        })
      }
      return { data: answer }
    } catch (err) {
      if (err instanceof ExplainError) {
        return reply.code(err.statusCode).send({ error: err.message })
      }
      throw err
    }
  })
}
