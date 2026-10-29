import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { cleanBadge } from '../services/mcp-calls.js'
import { getClient } from '../services/oauth-store.js'
import {
  type ApplyStep,
  checkChanges,
  closeSchemaProposal,
  createSchemaProposal,
  listSchemaProposals,
  loadSchemaFacts,
  noteSchemaProposalProgress,
  type ProposerRef,
  planApply,
  readSchemaProposal,
  SchemaProposalError
} from '../services/schema-proposals.js'
import { injectFetch } from './mcp.js'

/**
 * Schema change proposals (#3209), under /api/schema-proposals.
 *
 *   POST /                 anyone signed in: {changes, note?} → stored for review, nothing changes
 *   GET  /                 admin: ?status=open|all&collection= — the Data Model's review list
 *   GET  /:id              the proposer or an admin: one proposal and its outcome
 *   POST /:id/apply        admin, signed in to the admin (a session): carry it out
 *   POST /:id/reject       admin, signed in to the admin: {note?}
 *
 * Apply re-enters the Data Model's own routes in-process AS THE ADMINISTRATOR (their session
 * cookie), one step at a time — create table/column, register, label — so every check, cache
 * bust and activity row a click would make happens here too. A step that fails stops the run;
 * the proposal stays open with the steps done so far, and applying again skips what exists.
 *
 * Apply and reject refuse anything but a person's admin session: an assistant (OAuth token,
 * API key, the MCP endpoint's in-process calls) can propose, never apply its own proposal.
 */

async function proposerOf(req: FastifyRequest): Promise<ProposerRef> {
  const user_id = String(req.user?.id ?? '')
  const clean = (v: unknown) =>
    typeof v === 'string' && v.trim() ? cleanBadge(v).slice(0, 80) || null : null
  if (req.authMethod === 'oauth' && req.oauthClientId) {
    const client = await getClient(req.server.redis, req.oauthClientId).catch(() => null)
    return { user_id, via: 'oauth', client: clean(client?.client_name ?? req.oauthClientName) }
  }
  if (req.authMethod === 'api_key' && req.apiKeyId) {
    const key = (await db('nivaro_api_keys')
      .where({ id: req.apiKeyId })
      .first('name')
      .catch(() => null)) as { name?: string } | null
    return { user_id, via: 'api_key', client: clean(key?.name) }
  }
  if (req.authMethod === 'session') return { user_id, via: 'session', client: null }
  if (req.authMethod === 'token') return { user_id, via: 'token', client: null }
  return { user_id, via: 'other', client: null }
}

/** Only a person signed in to the admin applies or rejects. */
function personSessionRefusal(req: FastifyRequest, reply: FastifyReply): FastifyReply | null {
  if (req.authMethod === 'session' && !req.mcpInner) return null
  return reply.code(403).send({
    error:
      'Schema proposals are applied or rejected by an administrator in the Data Model, signed in — not through an API key or a connected app',
    code: 'SESSION_REQUIRED'
  })
}

const sendError = (reply: FastifyReply, err: unknown) => {
  if (err instanceof SchemaProposalError)
    return reply.code(err.statusCode).send({
      error: err.message,
      ...(err.change_index !== undefined ? { change_index: err.change_index } : {})
    })
  throw err
}

const ID_RE = /^[0-9a-f-]{36}$/i

export async function schemaProposalRoutes(app: FastifyInstance) {
  app.post<{ Body: { changes?: unknown; note?: unknown } }>(
    '/',
    { preHandler: requireAuth },
    async (req, reply) => {
      try {
        const res = await createSchemaProposal({
          user: req.user!,
          isAdmin: !!req.isAdmin,
          changes: req.body?.changes,
          note: req.body?.note,
          proposer: await proposerOf(req)
        })
        await logActivity({
          action: 'schema-proposal',
          user: req.user!.id,
          collection: 'nivaro_ai_proposals',
          item: res.id,
          comment: `Proposed ${res.sentences.length} schema change${res.sentences.length === 1 ? '' : 's'} for review`,
          req
        })
        return reply.code(201).send({
          data: {
            id: res.id,
            status: 'proposed',
            changes: res.sentences,
            note: 'Nothing was changed. An administrator reviews this proposal on the Data Model page (Proposals) and applies or rejects it.'
          }
        })
      } catch (err) {
        return sendError(reply, err)
      }
    }
  )

  app.get<{ Querystring: { status?: string; collection?: string } }>(
    '/',
    { preHandler: requireAdmin },
    async (req) => ({
      data: await listSchemaProposals({
        status: req.query.status === 'all' ? 'all' : 'open',
        collection: req.query.collection || null
      })
    })
  )

  app.get<{ Params: { id: string } }>('/:id', { preHandler: requireAuth }, async (req, reply) => {
    if (!ID_RE.test(req.params.id)) return reply.code(404).send({ error: 'Proposal not found' })
    const p = await readSchemaProposal(req.params.id)
    if (
      !p ||
      (!req.isAdmin && p.proposed_by.id.toLowerCase() !== String(req.user!.id).toLowerCase())
    )
      return reply.code(404).send({ error: 'Proposal not found' })
    return { data: p }
  })

  app.post<{ Params: { id: string } }>(
    '/:id/apply',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const refused = personSessionRefusal(req, reply)
      if (refused) return refused
      const p = ID_RE.test(req.params.id) ? await readSchemaProposal(req.params.id) : null
      if (!p) return reply.code(404).send({ error: 'Proposal not found' })
      if (p.status !== 'proposed')
        return reply.code(409).send({ error: `This proposal is ${p.status}` })

      // Judged again against the database as it is now — but a step a partial earlier run
      // already did is skipped, not refused.
      const facts = await loadSchemaFacts(p.changes.map((c) => c.collection))
      const done = new Set(
        (Array.isArray(p.result?.steps) ? (p.result.steps as Array<{ label?: string }>) : [])
          .map((s) => s.label)
          .filter(Boolean)
      )
      if (done.size === 0) {
        try {
          checkChanges(p.changes, facts)
        } catch (err) {
          return sendError(reply, err)
        }
      }
      const steps = planApply(p.changes, facts)
      const call = injectFetch(app, req, { cookie: true, inner: false })
      const ran: Array<{ label: string; status: 'done' | 'skipped' }> = []
      const tableNow = new Set<string>()
      const columnNow = new Set<string>()
      for (const step of steps) {
        if (await alreadyHolds(step, tableNow, columnNow)) {
          ran.push({ label: step.label, status: 'skipped' })
          continue
        }
        const res = await call(`http://local${step.path}`, {
          method: step.method,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(step.body)
        })
        if (!res.ok) {
          const said = (await res.json().catch(() => null)) as { error?: string } | null
          const error = `${step.label}: ${said?.error ?? `failed (${res.status})`}`
          await noteSchemaProposalProgress(p.id, { steps: ran, last_error: error })
          await logActivity({
            action: 'schema-proposal-apply',
            user: req.user!.id,
            collection: 'nivaro_ai_proposals',
            item: p.id,
            comment: `Stopped after ${ran.length} of ${steps.length} steps — ${error}`.slice(
              0,
              1000
            ),
            req
          })
          return reply.code(res.status >= 500 ? 502 : 409).send({
            error,
            data: { steps: ran, remaining: steps.length - ran.length }
          })
        }
        if (step.skip_if?.table && !step.skip_if.field)
          tableNow.add(step.skip_if.table.toLowerCase())
        if (step.skip_if?.field)
          columnNow.add(`${step.skip_if.table}.${step.skip_if.field}`.toLowerCase())
        ran.push({ label: step.label, status: 'done' })
      }
      const result = { steps: ran, applied_by: String(req.user!.id) }
      if (!(await closeSchemaProposal(p.id, 'executed', result)))
        return reply
          .code(409)
          .send({ error: 'This proposal was resolved by someone else meanwhile' })
      await logActivity({
        action: 'schema-proposal-apply',
        user: req.user!.id,
        collection: 'nivaro_ai_proposals',
        item: p.id,
        comment: `Applied ${p.sentences.length} schema change${p.sentences.length === 1 ? '' : 's'} proposed by ${p.proposed_by.name}${p.client ? ` via ${p.client}` : ''}`,
        req
      })
      return { data: { id: p.id, status: 'applied', steps: ran } }
    }
  )

  app.post<{ Params: { id: string }; Body: { note?: unknown } }>(
    '/:id/reject',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const refused = personSessionRefusal(req, reply)
      if (refused) return refused
      const p = ID_RE.test(req.params.id) ? await readSchemaProposal(req.params.id) : null
      if (!p) return reply.code(404).send({ error: 'Proposal not found' })
      const note =
        typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 500) || null : null
      if (
        !(await closeSchemaProposal(p.id, 'rejected', {
          note,
          rejected_by: String(req.user!.id)
        }))
      )
        return reply.code(409).send({ error: `This proposal is ${p.status}` })
      await logActivity({
        action: 'schema-proposal-reject',
        user: req.user!.id,
        collection: 'nivaro_ai_proposals',
        item: p.id,
        comment: note ?? undefined,
        req
      })
      return { data: { id: p.id, status: 'rejected' } }
    }
  )
}

/** A create step whose result is already there (a partial earlier run, or a person). */
async function alreadyHolds(
  step: ApplyStep,
  tableNow: Set<string>,
  columnNow: Set<string>
): Promise<boolean> {
  const s = step.skip_if
  if (!s?.table) return false
  if (s.field) {
    if (columnNow.has(`${s.table}.${s.field}`.toLowerCase())) return true
    return db.schema.hasColumn(s.table, s.field).catch(() => false)
  }
  if (tableNow.has(s.table.toLowerCase())) return true
  return db.schema.hasTable(s.table).catch(() => false)
}
