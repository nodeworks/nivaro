// api/src/routes/traffic-map-extras/inspect-actions.ts
import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { logActivity } from '../../services/activity.js'
import { getAiClient, getAiModelSettings } from '../../services/ai-client.js'
// Loads the group's inspect sources (they register at module load).
import { investigationDetail } from '../../services/traffic-inspect/actions.js'
import {
  CONTEXT_MAX,
  canEditInvestigation,
  cleanContext,
  cleanNotes,
  cleanStack,
  cleanTitle,
  EXPLAIN_SYSTEM,
  explainActivityLabel,
  explainContextOf,
  explainUserMessage,
  INVESTIGATION_ID_RE
} from '../../services/traffic-inspect/actions-logic.js'
import {
  deleteInvestigation,
  getInvestigation,
  INVESTIGATIONS_TABLE,
  insertInvestigation,
  investigationsReady,
  listInvestigations,
  updateInvestigation
} from '../../services/traffic-inspect/actions-store.js'

/**
 * Traffic Map drill-down, group "actions" (Task 8). Admin only and 404 in cloud mode (inherited
 * from the traffic-map plugin's hooks).
 *
 *   POST   /traffic-map/inspect/explain        { context } → { data: { text, model } }   (#1210)
 *   GET    /traffic-map/investigations          → { data: [...], ready }                  (#1212)
 *   POST   /traffic-map/investigations          { title, stack, notes?, context? } → 201
 *   GET    /traffic-map/investigations/:id      → { data }
 *   PATCH  /traffic-map/investigations/:id      { title?, stack?, notes?, context? }  (saver or admin)
 *   DELETE /traffic-map/investigations/:id      (saver or admin)
 */
const NOT_FOUND = { error: 'No investigation with that id here', code: 'INVESTIGATION_NOT_FOUND' }
const NOT_READY = {
  error: 'Investigations need migration 390 — run migrations on this instance first',
  code: 'INVESTIGATIONS_NOT_READY'
}

type IdParams = { Params: { id: string } }

/** The context field cleaned, or the reply already sent (400 / 413). `undefined` = not sent. */
function contextOrReply(raw: unknown, reply: FastifyReply): string | null | undefined | false {
  try {
    return cleanContext(raw, CONTEXT_MAX)
  } catch (err) {
    if ((err as Error).message === 'too_big') {
      reply.code(413).send({
        error: `The saved context is limited to ${CONTEXT_MAX / 1024} KB`,
        code: 'CONTEXT_TOO_BIG'
      })
    } else {
      reply.code(400).send({ error: 'context must be JSON', code: 'CONTEXT_INVALID' })
    }
    return false
  }
}

/** The investigation for :id when the caller may change it, or the reply already sent. */
async function editable(req: FastifyRequest<IdParams>, reply: FastifyReply) {
  if (!INVESTIGATION_ID_RE.test(req.params.id)) {
    reply.code(404).send(NOT_FOUND)
    return null
  }
  if (!(await investigationsReady())) {
    reply.code(503).send(NOT_READY)
    return null
  }
  const rec = await getInvestigation(req.params.id)
  if (!rec) {
    reply.code(404).send(NOT_FOUND)
    return null
  }
  if (!canEditInvestigation(rec, req.user?.id ?? null, !!req.isAdmin)) {
    reply.code(403).send({
      error: 'Only the admin who saved this investigation can change it',
      code: 'INVESTIGATION_FORBIDDEN'
    })
    return null
  }
  return rec
}

export async function inspectActionsRoutes(app: FastifyInstance): Promise<void> {
  // ── Explain (#1210) ──
  app.post<{ Body: { context?: unknown } }>('/inspect/explain', async (req, reply) => {
    const ctx = explainContextOf(req.body?.context)
    if (!ctx) {
      return reply.code(400).send({
        error: 'Open something in the investigation panel first',
        code: 'EXPLAIN_CONTEXT_INVALID'
      })
    }
    const client = await getAiClient()
    if (!client) {
      return reply.code(503).send({
        error: 'No AI provider is set up. An administrator can add one in Settings → AI Features.',
        code: 'AI_NOT_CONFIGURED'
      })
    }
    const { model } = await getAiModelSettings()
    let text = ''
    try {
      const res = await client.messages.create({
        model,
        max_tokens: 600,
        system: EXPLAIN_SYSTEM,
        messages: [{ role: 'user', content: explainUserMessage(ctx) }]
      })
      const first = res.content.find((b) => b.type === 'text') as { text?: string } | undefined
      text = (first?.text ?? '').trim()
    } catch (err) {
      req.log.warn({ err }, 'traffic inspect explain failed')
      return reply
        .code(502)
        .send({ error: 'The AI call failed. Try again in a moment.', code: 'EXPLAIN_FAILED' })
    }
    if (!text) {
      return reply
        .code(502)
        .send({ error: 'The AI returned nothing. Try again.', code: 'EXPLAIN_EMPTY' })
    }
    await logActivity({
      action: 'traffic-inspect-explain',
      user: req.user?.id ?? null,
      comment: explainActivityLabel(ctx),
      req
    })
    return { data: { text, model } }
  })

  // ── Notebook (#1212) ──
  app.get('/investigations', async () => {
    if (!(await investigationsReady())) return { data: [], ready: false }
    const rows = await listInvestigations()
    return {
      data: rows.map(({ context: _c, ...r }) => ({
        ...r,
        levels: r.stack ? r.stack.split('/').length : 0
      })),
      ready: true
    }
  })

  app.post<{
    Body: { title?: unknown; stack?: unknown; notes?: unknown; context?: unknown }
  }>('/investigations', async (req, reply) => {
    if (!(await investigationsReady())) return reply.code(503).send(NOT_READY)
    const b = req.body ?? {}
    const stack = cleanStack(b.stack)
    if (!stack) {
      return reply.code(400).send({
        error: 'Nothing to save — open something in the investigation panel first',
        code: 'STACK_INVALID'
      })
    }
    const title = cleanTitle(b.title) || 'Investigation'
    const context = contextOrReply(b.context, reply)
    if (context === false) return reply
    const id = randomUUID()
    await insertInvestigation({
      id,
      title,
      stack,
      notes: cleanNotes(b.notes),
      context: context ?? null,
      created_by: req.user?.id ?? null
    })
    await logActivity({
      action: 'traffic-investigation',
      user: req.user?.id ?? null,
      collection: INVESTIGATIONS_TABLE,
      item: id,
      comment: `Investigation "${title}"`.slice(0, 240),
      req
    })
    return reply.code(201).send({ data: { id, title } })
  })

  app.get<IdParams>('/investigations/:id', async (req, reply) => {
    if (!INVESTIGATION_ID_RE.test(req.params.id)) return reply.code(404).send(NOT_FOUND)
    if (!(await investigationsReady())) return reply.code(503).send(NOT_READY)
    const rec = await getInvestigation(req.params.id)
    if (!rec) return reply.code(404).send(NOT_FOUND)
    return { data: investigationDetail(rec, req) }
  })

  app.patch<
    IdParams & {
      Body: { title?: unknown; stack?: unknown; notes?: unknown; context?: unknown }
    }
  >('/investigations/:id', async (req, reply) => {
    const rec = await editable(req, reply)
    if (!rec) return reply
    const b = req.body ?? {}
    const patch: Partial<{
      title: string
      stack: string
      notes: string | null
      context: string | null
    }> = {}
    if (b.title !== undefined) {
      const t = cleanTitle(b.title)
      if (!t)
        return reply.code(400).send({ error: 'The title cannot be empty', code: 'TITLE_INVALID' })
      patch.title = t
    }
    if (b.stack !== undefined) {
      const s = cleanStack(b.stack)
      if (!s)
        return reply.code(400).send({ error: 'That stack is not valid', code: 'STACK_INVALID' })
      patch.stack = s
    }
    if (b.notes !== undefined) patch.notes = cleanNotes(b.notes)
    const context = contextOrReply(b.context, reply)
    if (context === false) return reply
    if (context !== undefined) patch.context = context
    if (Object.keys(patch).length > 0) await updateInvestigation(rec.id, patch)
    const next = await getInvestigation(rec.id)
    return { data: next ? investigationDetail(next, req) : null }
  })

  app.delete<IdParams>('/investigations/:id', async (req, reply) => {
    const rec = await editable(req, reply)
    if (!rec) return reply
    await deleteInvestigation(rec.id)
    await logActivity({
      action: 'traffic-investigation-delete',
      user: req.user?.id ?? null,
      collection: INVESTIGATIONS_TABLE,
      item: rec.id,
      comment: `Investigation "${rec.title}" deleted`.slice(0, 240),
      req
    })
    return reply.code(204).send()
  })
}
