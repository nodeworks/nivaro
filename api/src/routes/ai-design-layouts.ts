import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { logActivity } from '../services/activity.js'
import { cleanCandidates, findSetting } from '../services/ai-design/find-setting.js'
import { type AskTurn, askAboutLayout } from '../services/ai-design/layout-ask.js'
import { type DiffSideInput, explainLayoutDiff } from '../services/ai-design/layout-diff-explain.js'
import {
  explainField,
  findRole,
  LayoutAssistError,
  whichForm
} from '../services/ai-design/layout-explain-field.js'
import { describeLayout, loadLayoutFacts } from '../services/ai-design/layout-facts.js'
import {
  createLayoutProposal,
  listLayoutProposals,
  type ProposerRef,
  resolveLayoutProposal
} from '../services/ai-design/layout-proposals.js'
import { AiUnavailableError, cleanText, defaultComplete } from '../services/ai-design/model.js'
import { getClient } from '../services/oauth-store.js'

/**
 * Layout AI helpers under /ai-design/layouts (admin only — registered inside
 * aiDesignRoutes, which gates every route with requireAdmin):
 *
 *   #2694  describe / which-form / explain-field (read-only; the MCP layout
 *          tools call these) and proposals: propose_layout_ops stores layout
 *          ops for an admin to review in the editor — nothing here writes a
 *          layout; the editor applies a proposal through its draft
 *   #2695  ask: a question about the collection's forms, answered with
 *          read-only tools
 *   #2676  find-setting: the AI half of "where do I turn off comments?"
 *   #2693  explain-diff: two layouts or two versions of one, in plain words
 */

const layoutIdOf = (req: FastifyRequest<{ Params: { id: string } }>) => {
  const id = Number(req.params.id)
  return Number.isFinite(id) && id > 0 ? id : null
}

function sendAssistError(reply: FastifyReply, err: unknown) {
  if (err instanceof LayoutAssistError)
    return reply.code(err.statusCode).send({ error: err.message })
  if (err instanceof AiUnavailableError) return reply.code(503).send({ error: err.message })
  throw err
}

/** Who is proposing: the person, and the connected app or API key they came through. */
async function proposerOf(req: FastifyRequest): Promise<ProposerRef> {
  const user_id = String(req.user?.id ?? '')
  const method = req.authMethod
  if (method === 'oauth' && req.oauthClientId) {
    const client = await getClient(req.server.redis, req.oauthClientId).catch(() => null)
    return { user_id, via: 'oauth', client: cleanText(client?.client_name, 80) }
  }
  if (method === 'api_key' && req.apiKeyId) {
    const key = (await db('nivaro_api_keys')
      .where({ id: req.apiKeyId })
      .first('name')
      .catch(() => null)) as { name?: string } | null
    return { user_id, via: 'api_key', client: cleanText(key?.name, 80) }
  }
  if (method === 'session') return { user_id, via: 'session', client: null }
  if (method === 'token') return { user_id, via: 'token', client: null }
  return { user_id, via: 'other', client: null }
}

function sideOf(v: unknown): DiffSideInput | null {
  const o = (v ?? {}) as Record<string, unknown>
  const id = Number(o.layout_id)
  if (!Number.isFinite(id) || id <= 0) return null
  const ver = o.version
  return {
    layout_id: id,
    version:
      ver === 'newest' ? 'newest' : ver == null || ver === 'current' ? null : Number(ver) || null
  }
}

export function registerLayoutChatRoutes(app: FastifyInstance) {
  // ── #2694 read-only facts ──────────────────────────────────────────────────

  app.get<{ Params: { id: string } }>('/layouts/:id/describe', async (req, reply) => {
    const id = layoutIdOf(req)
    if (!id) return reply.code(400).send({ error: 'Invalid layout id' })
    const facts = await loadLayoutFacts(id)
    if (!facts) return reply.code(404).send({ error: 'Layout not found' })
    return reply.send({ data: describeLayout(facts) })
  })

  app.get<{ Querystring: { collection?: string; item?: string; role?: string } }>(
    '/layouts/which-form',
    async (req, reply) => {
      const { collection, item, role } = req.query
      if (!collection) return reply.code(400).send({ error: 'collection is required' })
      try {
        const res = await whichForm({
          collection,
          item: item || null,
          role: await findRole(role)
        })
        return reply.send({ data: res })
      } catch (err) {
        return sendAssistError(reply, err)
      }
    }
  )

  app.get<{
    Querystring: {
      collection?: string
      field?: string
      role?: string
      item?: string
      layout_id?: string
    }
  }>('/layouts/explain-field', async (req, reply) => {
    const { collection, field, role, item, layout_id } = req.query
    if (!collection || !field)
      return reply.code(400).send({ error: 'collection and field are required' })
    const lid = Number(layout_id)
    try {
      const res = await explainField({
        collection,
        field,
        role: role || null,
        item: item || null,
        layoutId: Number.isFinite(lid) && lid > 0 ? lid : null,
        asker: req.user!
      })
      return reply.send({ data: res })
    } catch (err) {
      return sendAssistError(reply, err)
    }
  })

  // ── #2694 proposals ────────────────────────────────────────────────────────

  app.post<{ Params: { id: string }; Body: { ops?: unknown; note?: unknown } }>(
    '/layouts/:id/proposals',
    async (req, reply) => {
      const id = layoutIdOf(req)
      if (!id) return reply.code(400).send({ error: 'Invalid layout id' })
      const res = await createLayoutProposal({
        layoutId: id,
        ops: req.body?.ops,
        note: req.body?.note,
        proposer: await proposerOf(req)
      })
      if (!res.ok) {
        const { ok: _, status, ...body } = res
        return reply.code(status).send(body)
      }
      await logActivity({
        action: 'layout-proposal',
        user: req.user?.id,
        collection: 'nivaro_collection_layouts',
        item: String(id),
        comment: `Proposed ${res.sentences.length} layout change${res.sentences.length === 1 ? '' : 's'} for review`,
        req
      })
      return reply.code(201).send({
        data: {
          id: res.id,
          status: 'proposed',
          changes: res.sentences,
          dropped: res.dropped,
          note: 'Nothing was changed. An administrator reviews this proposal in the layout editor (Proposals) and applies or rejects it.'
        }
      })
    }
  )

  app.get<{ Params: { id: string }; Querystring: { status?: string } }>(
    '/layouts/:id/proposals',
    async (req, reply) => {
      const id = layoutIdOf(req)
      if (!id) return reply.code(400).send({ error: 'Invalid layout id' })
      const rows = await listLayoutProposals(id, {
        status: req.query.status === 'all' ? 'all' : 'open'
      })
      if (!rows) return reply.code(404).send({ error: 'Layout not found' })
      return reply.send({ data: rows })
    }
  )

  // Read-only: the editor's open proposals checked against its unsaved draft.
  app.post<{ Params: { id: string }; Body: { draft?: unknown } }>(
    '/layouts/:id/proposals/check',
    async (req, reply) => {
      const id = layoutIdOf(req)
      if (!id) return reply.code(400).send({ error: 'Invalid layout id' })
      const rows = await listLayoutProposals(id, { draft: req.body?.draft })
      if (!rows) return reply.code(404).send({ error: 'Layout not found' })
      return reply.send({ data: rows })
    }
  )

  app.post<{ Params: { id: string; pid: string }; Body: { outcome?: string } }>(
    '/layouts/:id/proposals/:pid/resolve',
    async (req, reply) => {
      const id = layoutIdOf(req)
      if (!id) return reply.code(400).send({ error: 'Invalid layout id' })
      const outcome = req.body?.outcome
      if (outcome !== 'applied' && outcome !== 'rejected')
        return reply.code(400).send({ error: 'outcome must be applied or rejected' })
      const res = await resolveLayoutProposal({
        layoutId: id,
        id: req.params.pid,
        outcome,
        by: req.user?.id ?? null
      })
      if (res === 'not_found') return reply.code(404).send({ error: 'Proposal not found' })
      if (res === 'not_open')
        return reply.code(409).send({ error: 'This proposal was already applied or rejected' })
      await logActivity({
        action: 'layout-proposal',
        user: req.user?.id,
        collection: 'nivaro_collection_layouts',
        item: String(id),
        comment: `Layout proposal ${outcome === 'applied' ? 'applied to the draft' : 'rejected'}`,
        req
      })
      return reply.send({ data: { id: req.params.pid, status: outcome } })
    }
  )

  // ── #2695 ask about this form ──────────────────────────────────────────────

  app.post<{
    Params: { id: string }
    Body: { question?: string; history?: AskTurn[]; draft?: unknown }
  }>('/layouts/:id/ask', async (req, reply) => {
    const id = layoutIdOf(req)
    if (!id) return reply.code(400).send({ error: 'Invalid layout id' })
    const layout = (await db('nivaro_collection_layouts')
      .where({ id })
      .first('collection', 'name')) as { collection: string; name: string } | undefined
    if (!layout) return reply.code(404).send({ error: 'Layout not found' })
    try {
      const answer = await askAboutLayout(
        String(req.body?.question ?? ''),
        {
          collection: layout.collection,
          layoutId: id,
          layoutName: String(layout.name ?? ''),
          draft: req.body?.draft,
          asker: req.user!
        },
        { history: Array.isArray(req.body?.history) ? req.body.history : [] }
      )
      return reply.send({ data: answer })
    } catch (err) {
      return sendAssistError(reply, err)
    }
  })

  // ── #2676 find a setting by asking ─────────────────────────────────────────

  app.post<{ Body: { question?: string; candidates?: unknown } }>(
    '/layouts/find-setting',
    async (req, reply) => {
      const question = cleanText(req.body?.question, 300)
      if (!question) return reply.code(400).send({ error: 'Ask where a setting is' })
      const candidates = cleanCandidates(req.body?.candidates)
      if (candidates.length === 0) return reply.code(400).send({ error: 'No settings to search' })
      const complete = await defaultComplete()
      if (!complete) return reply.code(503).send({ error: new AiUnavailableError().message })
      try {
        return reply.send({ data: await findSetting(question, candidates, complete) })
      } catch (err) {
        return reply.code(502).send({
          error: `The AI could not find it: ${(err as Error).message}`.slice(0, 400)
        })
      }
    }
  )

  // ── #2693 why two forms differ ─────────────────────────────────────────────

  app.post<{ Body: { a?: unknown; b?: unknown; draft?: unknown; ai?: boolean } }>(
    '/layouts/explain-diff',
    async (req, reply) => {
      const a = sideOf(req.body?.a)
      const b = sideOf(req.body?.b)
      if (!a || !b) return reply.code(400).send({ error: 'a and b need a layout_id' })
      const res = await explainLayoutDiff({ a, b, draft: req.body?.draft, ai: req.body?.ai })
      if (!res)
        return reply
          .code(404)
          .send({ error: 'One of the two was not found, or they belong to different collections' })
      return reply.send({ data: res })
    }
  )
}
