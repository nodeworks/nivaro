import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import {
  bustKnowledgeCaches,
  dismissDocsMisses,
  glossarySlug,
  knowledgeTablesReady,
  listDataGuides,
  listDocsGaps,
  listGlossary,
  normalizeGlossaryInput,
  normalizeGuideInput
} from '../services/ai-knowledge.js'
import {
  decideFinding,
  listFindings,
  runKnowledgeCheck,
  scheduleKnowledgeCheck
} from '../services/ai-knowledge-check.js'
import {
  acceptSuggestion,
  dismissSuggestion,
  draftGlossarySuggestions,
  draftGuideSuggestions,
  listSuggestions,
  type SuggestionStatus
} from '../services/ai-knowledge-suggest.js'
import { buildTopicMap } from '../services/ai-topic-map.js'
import { loadDocsIndex, rankDocs } from '../services/docs-search.js'
import { can } from '../services/permissions.js'

// /api/ai-knowledge — what Ask AI knows beyond the data (migration 434):
// the glossary (#1899, everyone reads it, admins edit it), per-collection
// data guides (#1847), drafted suggestions (#1898 / #1949) and the docs-gaps
// report (#1855). Everything but the glossary read is admin-only.

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

function notReady(reply: import('fastify').FastifyReply) {
  return reply
    .code(409)
    .send({ error: 'The AI knowledge tables do not exist yet — run migration 434.' })
}

function statusOf(err: unknown): number {
  const s = (err as { statusCode?: number }).statusCode
  return typeof s === 'number' && s >= 400 && s < 600 ? s : 500
}

export async function aiKnowledgeRoutes(app: FastifyInstance) {
  // ─── Glossary ─────────────────────────────────────────────────────────────
  // Every signed-in person reads it: the app shows definitions on labels and
  // in Ask AI answers. A term scoped to a collection the reader cannot read
  // is left out, as Ask AI's prompt leaves it out.
  app.get('/glossary', { preHandler: authenticate }, async (req) => {
    const all = await listGlossary()
    if (req.isAdmin) return { data: all }
    const scoped = [...new Set(all.map((e) => e.collection).filter((c): c is string => !!c))]
    const readable = new Set<string>()
    await Promise.all(
      scoped.map(async (c) => {
        if (await can(req.user!, 'read', c).catch(() => false)) readable.add(c)
      })
    )
    return { data: all.filter((e) => !e.collection || readable.has(e.collection)) }
  })

  app.post('/glossary', { preHandler: requireAdmin }, async (req, reply) => {
    if (!(await knowledgeTablesReady())) return notReady(reply)
    const v = normalizeGlossaryInput((req.body ?? {}) as Record<string, unknown>)
    if (!v.ok) return reply.code(400).send({ error: v.error })
    const slug = glossarySlug(v.value.term)
    if (await db('nivaro_ai_glossary').where({ slug }).first('id'))
      return reply.code(409).send({ error: `"${v.value.term}" is already defined` })
    const now = new Date()
    await db('nivaro_ai_glossary').insert({
      ...v.value,
      slug,
      aliases: JSON.stringify(v.value.aliases),
      created_by: req.user!.id,
      updated_by: req.user!.id,
      created_at: now,
      updated_at: now
    })
    bustKnowledgeCaches()
    scheduleKnowledgeCheck()
    await logActivity({
      action: 'ai-glossary-create',
      user: req.user!.id,
      collection: 'nivaro_ai_glossary',
      item: slug,
      comment: v.value.term,
      req
    })
    const entry = (await listGlossary({ fresh: true })).find((e) => e.slug === slug)
    return reply.code(201).send({ data: entry ?? null })
  })

  app.patch<{ Params: { id: string } }>(
    '/glossary/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      if (!(await knowledgeTablesReady())) return notReady(reply)
      const id = Number(req.params.id)
      const cur = (await db('nivaro_ai_glossary').where({ id }).first()) as
        | Record<string, unknown>
        | undefined
      if (!cur) return reply.code(404).send({ error: 'No such term' })
      const merged = { ...cur, aliases: cur.aliases, ...((req.body ?? {}) as object) }
      const v = normalizeGlossaryInput(merged as Record<string, unknown>)
      if (!v.ok) return reply.code(400).send({ error: v.error })
      const slug = glossarySlug(v.value.term)
      const clash = await db('nivaro_ai_glossary').where({ slug }).whereNot({ id }).first('id')
      if (clash) return reply.code(409).send({ error: `"${v.value.term}" is already defined` })
      await db('nivaro_ai_glossary')
        .where({ id })
        .update({
          ...v.value,
          slug,
          aliases: JSON.stringify(v.value.aliases),
          updated_by: req.user!.id,
          updated_at: new Date()
        })
      bustKnowledgeCaches()
      scheduleKnowledgeCheck()
      await logActivity({
        action: 'ai-glossary-update',
        user: req.user!.id,
        collection: 'nivaro_ai_glossary',
        item: slug,
        comment: v.value.term,
        req
      })
      return { data: (await listGlossary({ fresh: true })).find((e) => e.id === id) ?? null }
    }
  )

  app.delete<{ Params: { id: string } }>(
    '/glossary/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      if (!(await knowledgeTablesReady())) return notReady(reply)
      const id = Number(req.params.id)
      const cur = (await db('nivaro_ai_glossary').where({ id }).first('term', 'slug')) as
        | { term: string; slug: string }
        | undefined
      if (!cur) return reply.code(404).send({ error: 'No such term' })
      await db('nivaro_ai_glossary').where({ id }).del()
      bustKnowledgeCaches()
      scheduleKnowledgeCheck()
      await logActivity({
        action: 'ai-glossary-delete',
        user: req.user!.id,
        collection: 'nivaro_ai_glossary',
        item: cur.slug,
        comment: cur.term,
        req
      })
      return reply.code(204).send()
    }
  )

  // ─── Data guides ──────────────────────────────────────────────────────────
  app.get('/data-guides', { preHandler: requireAdmin }, async () => {
    return { data: await listDataGuides({ fresh: true }) }
  })

  app.get<{ Params: { collection: string } }>(
    '/data-guides/:collection',
    { preHandler: requireAdmin },
    async (req) => {
      const { collection } = req.params
      const g = (await listDataGuides({ fresh: true })).find((x) => x.collection === collection)
      return {
        data: g ?? { collection, hints: null, examples: [], updated_at: null },
        ready: await knowledgeTablesReady()
      }
    }
  )

  app.put<{ Params: { collection: string } }>(
    '/data-guides/:collection',
    { preHandler: requireAdmin },
    async (req, reply) => {
      if (!(await knowledgeTablesReady())) return notReady(reply)
      const { collection } = req.params
      if (!IDENT.test(collection) || /^(nivaro|directus)_/i.test(collection))
        return reply.code(400).send({ error: 'Data guides are for business collections' })
      if (!(await db('nivaro_collections').where({ collection }).first('id')))
        return reply.code(404).send({ error: 'No such collection' })
      const v = normalizeGuideInput((req.body ?? {}) as Record<string, unknown>)
      if (!v.ok) return reply.code(400).send({ error: v.error })
      const row = {
        hints: v.value.hints,
        examples: JSON.stringify(v.value.examples),
        updated_by: req.user!.id,
        updated_at: new Date()
      }
      if (!v.value.hints && !v.value.examples.length) {
        await db('nivaro_ai_data_guides').where({ collection }).del()
      } else if (await db('nivaro_ai_data_guides').where({ collection }).first('collection')) {
        await db('nivaro_ai_data_guides').where({ collection }).update(row)
      } else {
        await db('nivaro_ai_data_guides').insert({ collection, ...row })
      }
      bustKnowledgeCaches()
      scheduleKnowledgeCheck()
      await logActivity({
        action: 'ai-data-guide-update',
        user: req.user!.id,
        collection: 'nivaro_ai_data_guides',
        item: collection,
        req
      })
      return {
        data: { collection, hints: v.value.hints, examples: v.value.examples }
      }
    }
  )

  // ─── Suggestions (#1898 / #1949) ──────────────────────────────────────────
  app.get<{ Querystring: { status?: string } }>(
    '/suggestions',
    { preHandler: requireAdmin },
    async (req) => {
      const raw = req.query?.status
      const status: SuggestionStatus | 'all' =
        raw === 'accepted' || raw === 'dismissed' || raw === 'all' ? raw : 'pending'
      return { data: await listSuggestions(status) }
    }
  )

  app.post('/suggestions/draft', { preHandler: requireAdmin }, async (req, reply) => {
    const body = (req.body ?? {}) as { source?: unknown; days?: unknown }
    try {
      if (body.source === 'data') {
        const r = await draftGlossarySuggestions()
        await logActivity({
          action: 'ai-knowledge-draft',
          user: req.user!.id,
          collection: 'nivaro_ai_knowledge_suggestions',
          comment: `glossary from data: ${r.created} new`,
          req
        })
        return { data: { kind: 'glossary', ...r } }
      }
      if (body.source === 'corrections') {
        const r = await draftGuideSuggestions({ days: Number(body.days) || undefined })
        await logActivity({
          action: 'ai-knowledge-draft',
          user: req.user!.id,
          collection: 'nivaro_ai_knowledge_suggestions',
          comment: `guide from corrections: ${r.created} new of ${r.signals} signal(s)`,
          req
        })
        return { data: { kind: 'guide', ...r } }
      }
      return reply.code(400).send({ error: "source must be 'corrections' or 'data'" })
    } catch (err) {
      const code = statusOf(err)
      if (code >= 500) req.log.warn({ err }, 'AI knowledge draft failed')
      return reply
        .code(code)
        .send({ error: code >= 500 ? 'Drafting failed' : (err as Error).message })
    }
  })

  app.post<{ Params: { id: string } }>(
    '/suggestions/:id/accept',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const body = (req.body ?? {}) as { payload?: unknown }
      const edits =
        body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload)
          ? (body.payload as Record<string, unknown>)
          : null
      try {
        const r = await acceptSuggestion(Number(req.params.id), req.user!.id, edits)
        scheduleKnowledgeCheck()
        await logActivity({
          action: 'ai-knowledge-accept',
          user: req.user!.id,
          collection: 'nivaro_ai_knowledge_suggestions',
          item: req.params.id,
          comment: `${r.applied}: ${r.target}`,
          req
        })
        return { data: r }
      } catch (err) {
        const code = statusOf(err)
        return reply
          .code(code)
          .send({ error: code >= 500 ? 'Accept failed' : (err as Error).message })
      }
    }
  )

  app.post<{ Params: { id: string } }>(
    '/suggestions/:id/dismiss',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const ok = await dismissSuggestion(Number(req.params.id), req.user!.id)
      if (!ok) return reply.code(404).send({ error: 'No pending suggestion with that id' })
      return { data: { ok: true } }
    }
  )

  // ─── Conflict check (#2480) ───────────────────────────────────────────────
  app.get<{ Querystring: { status?: string } }>(
    '/findings',
    { preHandler: requireAdmin },
    async (req) => {
      const raw = req.query?.status
      const status =
        raw === 'dismissed' || raw === 'resolved' || raw === 'all' ? raw : ('open' as const)
      return { data: await listFindings(status) }
    }
  )

  app.post('/findings/run', { preHandler: requireAdmin }, async (req, reply) => {
    const ai = (req.body as { ai?: unknown } | null)?.ai === true
    try {
      const r = await runKnowledgeCheck({ ai })
      await logActivity({
        action: 'ai-knowledge-check',
        user: req.user!.id,
        collection: 'nivaro_ai_knowledge_findings',
        comment: `${r.open} open, ${r.new} new, ${r.resolved} resolved${ai ? ' (with AI read)' : ''}`,
        req
      })
      return { data: r }
    } catch (err) {
      const code = statusOf(err)
      if (code >= 500) req.log.warn({ err }, 'Knowledge check failed')
      return reply.code(code).send({ error: code >= 500 ? 'Check failed' : (err as Error).message })
    }
  })

  app.post<{ Params: { id: string; action: string } }>(
    '/findings/:id/:action',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { action } = req.params
      if (action !== 'dismiss' && action !== 'reopen')
        return reply.code(404).send({ error: 'Unknown action' })
      const ok = await decideFinding(
        Number(req.params.id),
        action === 'dismiss' ? 'dismissed' : 'open',
        req.user!.id
      )
      if (!ok) return reply.code(404).send({ error: 'No such finding in that state' })
      return { data: { ok: true } }
    }
  )

  // ─── Topic map (#2734) ────────────────────────────────────────────────────
  // Admin only. Topics carry generated names; the questions behind a topic are
  // sent only with ?questions=1 and that read is logged like any admin look at
  // other people's AI questions.
  app.get<{ Querystring: { days?: string; fresh?: string; questions?: string } }>(
    '/topic-map',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const withQuestions = req.query?.questions === '1'
      try {
        const data = await buildTopicMap({
          days: Number(req.query?.days) || undefined,
          fresh: req.query?.fresh === '1',
          withQuestions
        })
        if (withQuestions)
          await logActivity({
            action: 'ai-topic-map-questions',
            user: req.user!.id,
            collection: 'nivaro_ai_calls',
            comment: `sample questions for ${data.topics.length} topic(s), last ${data.days} days`,
            req
          })
        return { data }
      } catch (err) {
        req.log.warn({ err }, 'Topic map failed')
        return reply.code(500).send({ error: 'The topic map could not be built' })
      }
    }
  )

  // ─── Docs gaps (#1855) ────────────────────────────────────────────────────
  app.get<{ Querystring: { days?: string } }>(
    '/docs-gaps',
    { preHandler: requireAdmin },
    async (req) => {
      return { data: await listDocsGaps({ days: Number(req.query?.days) || undefined }) }
    }
  )

  app.post('/docs-gaps/dismiss', { preHandler: requireAdmin }, async (req, reply) => {
    const ids = (req.body as { ids?: unknown } | null)?.ids
    if (!Array.isArray(ids)) return reply.code(400).send({ error: 'ids must be a list' })
    const removed = await dismissDocsMisses(ids.map(Number))
    return { data: { removed } }
  })

  // The docs search Ask AI uses, for the admin page's "try it" box.
  app.get<{ Querystring: { q?: string } }>(
    '/docs-search',
    { preHandler: authenticate },
    async (req) => {
      const q = String(req.query?.q ?? '').slice(0, 300)
      const r = rankDocs(await loadDocsIndex(), q, { admin: !!req.isAdmin, limit: 5 })
      return { data: r }
    }
  )
}
