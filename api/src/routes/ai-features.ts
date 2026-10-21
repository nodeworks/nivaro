import type { FastifyInstance, FastifyReply } from 'fastify'
import { adminBaseUrl } from '../admin-base.js'
import { db } from '../db/index.js'
import { authenticate } from '../middleware/authenticate.js'
import type { User } from '../types.js'

/**
 * Ask AI features that act for a person (2026-10-21 program):
 *   POST /ai/research                         #2456 ask in the background {question, conversation_id?} → 202
 *   POST /ai/research/:run/cancel             #2456 stop it (its asker, or an admin)
 *   POST /ai/dashboard-drafts                 #2736 {description} → a dashboard draft (an AI plan)
 *   GET  /ai/dashboard-drafts/:plan/preview   #2736 the draft's widgets, computed as the requester
 *   GET  /ai/answer-code?conversation_id=&message_id=   #2766 an answer's reads as SDK / REST code
 * The services hold the rules (ai-research.ts, ai-dashboard-draft.ts, ai-answer-code.ts).
 */

function statusOf(err: unknown): number {
  const s = (err as { statusCode?: unknown })?.statusCode
  return typeof s === 'number' && s >= 400 && s < 600 ? s : 500
}

function fail(reply: FastifyReply, err: unknown, fallback = 'Request failed') {
  const status = statusOf(err)
  const message = err instanceof Error && err.message ? err.message : fallback
  return reply.code(status).send({ error: status >= 500 ? fallback : message })
}

/** May this person copy code against the API: an admin, or someone with API access of their own. */
export async function hasApiAccess(user: User, isAdmin: boolean): Promise<boolean> {
  if (isAdmin) return true
  if (user.static_token) return true
  const key = (await db('nivaro_api_keys')
    .where({ user: user.id, is_active: true })
    .where((w) => w.whereNull('expires_at').orWhere('expires_at', '>', new Date()))
    .first('id')
    .catch(() => null)) as { id?: unknown } | null | undefined
  return !!key?.id
}

/** What `user` may name in a snippet (#2766): readable collections, fields and runnable queries. */
async function codeAccessFor(user: User, isAdmin: boolean) {
  const [{ can }, { readableFieldSet, assertFilterReadable }, { registeredFieldSet }] =
    await Promise.all([
      import('../services/permissions.js'),
      import('../services/ai-aggregate-guard.js'),
      import('../services/dashboard-widgets.js')
    ])
  const SYSTEM = /^(nivaro|directus)_/i
  const fieldsOf = new Map<string, Promise<{ all: Set<string>; hidden: Set<string> }>>()
  const fieldInfo = (collection: string) => {
    let p = fieldsOf.get(collection)
    if (!p) {
      p = (async () => {
        const all = await registeredFieldSet(collection)
        all.add('id')
        const readable = await readableFieldSet(user, collection, all)
        return { all, hidden: new Set([...all].filter((f) => !readable.has(f))) }
      })()
      fieldsOf.set(collection, p)
    }
    return p
  }
  const links = async (collection: string) => ({
    m2o: (
      (await db('nivaro_relations')
        .where({ many_collection: collection })
        .whereNotNull('one_collection')
        .select('many_field', 'one_collection')
        .catch(() => [])) as Array<{ many_field: string; one_collection: string }>
    ).map((r) => ({ field: r.many_field, collection: r.one_collection }))
  })
  return {
    collection: async (c: string) =>
      !SYSTEM.test(c) && (await can(user, 'read', c).catch(() => false)),
    path: async (c: string, path: string[]) => {
      try {
        const { all, hidden } = await fieldInfo(c)
        if (!all.has(path[0])) return false
        await assertFilterReadable(user, c, [path], hidden, links)
        return true
      } catch {
        return false
      }
    },
    savedQuery: async (slug: string) => {
      const q = (await db('nivaro_custom_queries')
        .where({ slug })
        .first('enabled', 'access')
        .catch(() => null)) as { enabled?: unknown; access?: string } | null | undefined
      if (!q || !(q.enabled === true || q.enabled === 1)) return false
      return (
        q.access === 'authenticated' || q.access === 'public' || (q.access === 'admin' && isAdmin)
      )
    }
  }
}

export async function aiFeatureRoutes(app: FastifyInstance) {
  // ── #2456 Background research ─────────────────────────────────────────────
  app.post('/research', { preHandler: authenticate }, async (req, reply) => {
    const body = (req.body ?? {}) as { question?: unknown; conversation_id?: unknown }
    const { startResearch } = await import('../services/ai-research.js')
    try {
      const out = await startResearch(app, req.user!, {
        question: body.question,
        conversationId: body.conversation_id
      })
      if ('error' in out) return reply.code(out.status).send({ error: out.error })
      return reply.code(202).send({ data: out })
    } catch (err) {
      req.log.error({ err }, 'AI research start failed')
      return fail(reply, err, 'Could not start the question')
    }
  })

  app.post<{ Params: { run: string } }>(
    '/research/:run/cancel',
    { preHandler: authenticate },
    async (req, reply) => {
      const runId = Number(req.params.run)
      if (!Number.isInteger(runId) || runId <= 0)
        return reply.code(400).send({ error: 'bad run id' })
      const { cancelResearch } = await import('../services/ai-research.js')
      const outcome = await cancelResearch(app, req.user!, runId, !!req.isAdmin)
      if (outcome === 'not_found') return reply.code(404).send({ error: 'Not found' })
      return { data: { run_id: runId, outcome } }
    }
  )

  // ── #2736 Draft a dashboard from a description ────────────────────────────
  app.post('/dashboard-drafts', { preHandler: authenticate }, async (req, reply) => {
    const description = String((req.body as { description?: unknown })?.description ?? '')
    const { draftDashboard, previewDraft } = await import('../services/ai-dashboard-draft.js')
    try {
      const { plan, dropped } = await draftDashboard(req.user!, description)
      const preview = await previewDraft(req.user!, plan.plan_id)
      const { logActivity } = await import('../services/activity.js')
      await logActivity({
        action: 'dashboard-ai-draft',
        user: req.user!.id,
        collection: 'nivaro_ai_proposals',
        item: plan.plan_id,
        comment: description.slice(0, 200),
        req
      }).catch(() => {})
      return reply.code(201).send({ data: { plan, preview, dropped } })
    } catch (err) {
      if (statusOf(err) >= 500) req.log.warn({ err }, 'dashboard draft failed')
      return fail(reply, err, 'Could not draft the dashboard')
    }
  })

  app.get<{ Params: { plan: string } }>(
    '/dashboard-drafts/:plan/preview',
    { preHandler: authenticate },
    async (req, reply) => {
      const { previewDraft } = await import('../services/ai-dashboard-draft.js')
      try {
        return { data: await previewDraft(req.user!, req.params.plan) }
      } catch (err) {
        return fail(reply, err, 'Could not preview the draft')
      }
    }
  )

  // ── #2766 Copy an answer's query as code ──────────────────────────────────
  app.get<{ Querystring: { conversation_id?: string; message_id?: string } }>(
    '/answer-code',
    { preHandler: authenticate },
    async (req, reply) => {
      const user = req.user!
      const isAdmin = !!req.isAdmin
      if (!(await hasApiAccess(user, isAdmin)))
        return reply.code(403).send({ error: 'Copying code needs API access' })
      const cid = String(req.query.conversation_id ?? '')
      const mid = String(req.query.message_id ?? '')
      const conv = await import('../services/ai-conversations.js')
      const row = await conv.getConversation(cid)
      if (!row || !(await conv.conversationAccess(user, row)))
        return reply.code(404).send({ error: 'Conversation not found' })
      // The answer as THIS reader may see it — another person's answer that does
      // not replay to the same result for them has no trace to copy.
      const view = await conv.messagesForViewer(user, await conv.listMessages(row.id))
      const msg = view.find((m) => m.id === mid)
      if (!msg || msg.role !== 'assistant' || !msg.visible)
        return reply.code(404).send({ error: 'Answer not found' })
      const { answerCode } = await import('../services/ai-answer-code.js')
      const origin =
        adminBaseUrl() || `${req.protocol}://${String(req.headers.host ?? 'localhost')}`
      const code = await answerCode(msg.trace, origin, await codeAccessFor(user, isAdmin))
      return { data: code }
    }
  )
}
