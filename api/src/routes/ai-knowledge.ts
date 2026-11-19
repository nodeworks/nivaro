import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { traceFromRequest } from '../services/ai-call-log/transcript.js'
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
import { normalizeQuestion, planFromTrace, recordPlaybook } from '../services/ai-playbooks.js'
import {
  buildTopicMap,
  draftCoverage,
  forgetTopicMap,
  topicDetail
} from '../services/ai-topic-map.js'
import { addOverride, fingerprintOf, removeOverride } from '../services/ai-topic-overrides.js'
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

  // ─── Topic map: drill + actions (Rob 2026-11-18, "actionable") ───────────
  // Every route finds the topic by its id IN the map of the same window
  // (?days=); a topic the map no longer has answers 404 TOPIC_MOVED and the
  // page refreshes. Reading a topic's questions is logged like the sample
  // questions; every decision is logged with what it changed.
  const topicOr404 = async (
    req: import('fastify').FastifyRequest,
    reply: import('fastify').FastifyReply
  ) => {
    const { id } = req.params as { id: string }
    const days = Number((req.query as { days?: string } | undefined)?.days) || undefined
    const t = await topicDetail(String(id), days)
    if (!t) {
      reply.code(404).send({
        error: 'This topic changed since the page loaded. Refresh the topic map.',
        code: 'TOPIC_MOVED'
      })
      return null
    }
    return t
  }
  const userNames = async (ids: string[]) => {
    const clean = [...new Set(ids.filter(Boolean))]
    const out = new Map<string, string>()
    for (let i = 0; i < clean.length; i += 500) {
      const rows = (await db('nivaro_users')
        .whereIn('id', clean.slice(i, i + 500))
        .select('id', 'first_name', 'last_name', 'email')) as Array<Record<string, unknown>>
      for (const r of rows)
        out.set(
          String(r.id).toLowerCase(),
          [r.first_name, r.last_name].filter(Boolean).join(' ') ||
            String(r.email ?? 'Unknown person')
        )
    }
    return out
  }
  const byName = (req: import('fastify').FastifyRequest) => {
    const u = req.user as { first_name?: string; last_name?: string; email?: string } | undefined
    return [u?.first_name, u?.last_name].filter(Boolean).join(' ') || u?.email || 'An administrator'
  }

  app.get<{ Params: { id: string }; Querystring: { days?: string } }>(
    '/topic-map/:id/questions',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const t = await topicOr404(req, reply)
      if (!t) return
      const names = await userNames(t.detail.members.map((m) => String(m.user ?? '')))
      await logActivity({
        action: 'ai-topic-map-questions',
        user: req.user!.id,
        collection: 'nivaro_ai_calls',
        comment: `questions of topic "${t.topic.name}" (${t.detail.members.length}), last ${t.days} days`,
        req
      })
      return {
        data: t.detail.members
          .slice()
          .sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')))
          .map((m) => ({
            request_id: m.request_id,
            call_id: m.call_id ?? null,
            question: m.question,
            role: m.role,
            asked_by: m.user ? (names.get(String(m.user).toLowerCase()) ?? 'Unknown person') : null,
            at: m.at ?? null,
            unanswered: m.unanswered,
            thumbs_up: m.thumbs_up,
            thumbs_down: m.thumbs_down,
            cost: m.cost,
            collections: m.collections ?? [],
            since_status: !!(t.topic.status_at && (m.at ?? '') > t.topic.status_at)
          }))
      }
    }
  )

  /** Docs searches that found nothing while answering this topic's questions. */
  app.get<{ Params: { id: string }; Querystring: { days?: string } }>(
    '/topic-map/:id/docs-gaps',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const t = await topicOr404(req, reply)
      if (!t) return
      if (!(await db.schema.hasTable('nivaro_ai_docs_misses').catch(() => false)))
        return { data: [] }
      const windows = t.detail.members
        .filter((m) => m.user && m.at)
        .map((m) => ({
          user: String(m.user).toLowerCase(),
          from: new Date(m.at as string).getTime() - 5_000,
          to: new Date((m.last_at ?? m.at) as string).getTime() + 120_000
        }))
      if (!windows.length) return { data: [] }
      const lo = new Date(Math.min(...windows.map((w) => w.from)))
      const hi = new Date(Math.max(...windows.map((w) => w.to)))
      const rows = (await db('nivaro_ai_docs_misses')
        .where('created_at', '>=', lo)
        .where('created_at', '<=', hi)
        .orderBy('id', 'desc')
        .limit(3000)
        .select('id', 'query', 'user', 'created_at')) as Array<Record<string, unknown>>
      const hits = rows.filter((r) => {
        const at = new Date(r.created_at as string).getTime()
        const u = String(r.user ?? '').toLowerCase()
        return windows.some((w) => w.user === u && at >= w.from && at <= w.to)
      })
      return {
        data: hits.map((r) => ({
          id: Number(r.id),
          query: String(r.query ?? ''),
          created_at: r.created_at
        }))
      }
    }
  )

  /** What a drafted glossary term / data guide would change for this topic — before saving. */
  app.post<{ Params: { id: string }; Querystring: { days?: string } }>(
    '/topic-map/:id/preview',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const t = await topicOr404(req, reply)
      if (!t) return
      const body = (req.body ?? {}) as Record<string, unknown>
      const questions = t.detail.members.map((m) => m.question)
      const asList = (v: unknown) =>
        (Array.isArray(v) ? v : String(v ?? '').split(','))
          .map((x) => String(x).trim())
          .filter(Boolean)
          .slice(0, 20)
      let covered: boolean[]
      let before: unknown = null
      if (body.kind === 'glossary') {
        const term = String(body.term ?? '').trim()
        if (!term) return reply.code(400).send({ error: 'term is required' })
        covered = draftCoverage(questions, {
          kind: 'glossary',
          term,
          aliases: asList(body.aliases)
        })
        const slug = glossarySlug(term)
        before = (await listGlossary()).find((g) => g.slug === slug) ?? null
      } else if (body.kind === 'guide') {
        const collection = String(body.collection ?? '')
        if (!IDENT.test(collection))
          return reply.code(400).send({ error: 'collection is required' })
        const readable = (await db('nivaro_collections')
          .whereNot('collection', 'like', 'nivaro%')
          .whereNot('collection', 'like', 'directus%')
          .select('collection', 'display_name')) as Array<{
          collection: string
          display_name: string | null
        }>
        covered = draftCoverage(questions, {
          kind: 'guide',
          collection,
          examples: asList(body.examples),
          readable
        })
        before =
          (await listDataGuides({ fresh: true })).find((g) => g.collection === collection) ?? null
      } else {
        return reply.code(400).send({ error: "kind must be 'glossary' or 'guide'" })
      }
      const was = {
        glossary: t.topic.coverage.glossary,
        guides: t.topic.coverage.guides
      }
      return {
        data: {
          total: questions.length,
          covered: covered.filter(Boolean).length,
          covered_before: body.kind === 'glossary' ? was.glossary : was.guides,
          sample_covered: questions.filter((_, i) => covered[i]).slice(0, 5),
          sample_missed: questions.filter((_, i) => !covered[i]).slice(0, 5),
          before
        }
      }
    }
  )

  app.post<{ Params: { id: string }; Querystring: { days?: string } }>(
    '/topic-map/:id/status',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const t = await topicOr404(req, reply)
      if (!t) return
      const body = (req.body ?? {}) as { status?: unknown; note?: unknown }
      const status = body.status === 'handled' || body.status === 'ignored' ? body.status : null
      if (body.status !== 'open' && !status)
        return reply.code(400).send({ error: "status must be 'handled', 'ignored' or 'open'" })
      const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) || null : null
      const fp = fingerprintOf(
        t.detail.members.map((m) => m.request_id),
        t.detail.centroid,
        t.provider,
        t.topic.name
      )
      const o = await addOverride({
        kind: 'status',
        topic: fp,
        ...(status ? { status } : {}),
        note,
        by: String(req.user!.id),
        by_name: byName(req)
      })
      forgetTopicMap()
      await logActivity({
        action: 'ai-topic-status',
        user: req.user!.id,
        collection: 'nivaro_extension_settings',
        item: 'nivaro-core:ai_topic_overrides',
        comment: `Topic "${t.topic.name}" → ${status ?? 'open'}${note ? ` (${note})` : ''}`,
        req
      })
      return { data: { id: status ? o.id : null, status: status ?? 'open' } }
    }
  )

  app.post<{ Params: { id: string }; Querystring: { days?: string } }>(
    '/topic-map/:id/rename',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const t = await topicOr404(req, reply)
      if (!t) return
      const name = String((req.body as { name?: unknown } | null)?.name ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 60)
      if (!name) return reply.code(400).send({ error: 'name is required' })
      const o = await addOverride({
        kind: 'rename',
        topic: fingerprintOf(
          t.detail.members.map((m) => m.request_id),
          t.detail.centroid,
          t.provider,
          t.topic.name
        ),
        name,
        by: String(req.user!.id),
        by_name: byName(req)
      })
      forgetTopicMap()
      await logActivity({
        action: 'ai-topic-rename',
        user: req.user!.id,
        collection: 'nivaro_extension_settings',
        item: 'nivaro-core:ai_topic_overrides',
        comment: `Topic "${t.topic.name}" renamed to "${name}"`,
        req
      })
      return { data: { id: o.id, name } }
    }
  )

  app.post<{ Params: { id: string }; Querystring: { days?: string } }>(
    '/topic-map/:id/merge',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const t = await topicOr404(req, reply)
      if (!t) return
      const into = String((req.body as { into?: unknown } | null)?.into ?? '')
      if (!into || into === t.topic.id)
        return reply.code(400).send({ error: 'Pick another topic to merge into' })
      const target = await topicDetail(into, t.days)
      if (!target)
        return reply.code(404).send({
          error: 'The topic to merge into changed. Refresh the topic map.',
          code: 'TOPIC_MOVED'
        })
      const o = await addOverride({
        kind: 'merge',
        topic: fingerprintOf(
          t.detail.members.map((m) => m.request_id),
          t.detail.centroid,
          t.provider,
          t.topic.name
        ),
        into: fingerprintOf(
          target.detail.members.map((m) => m.request_id),
          target.detail.centroid,
          target.provider,
          target.topic.name
        ),
        by: String(req.user!.id),
        by_name: byName(req)
      })
      forgetTopicMap()
      await logActivity({
        action: 'ai-topic-merge',
        user: req.user!.id,
        collection: 'nivaro_extension_settings',
        item: 'nivaro-core:ai_topic_overrides',
        comment: `Topic "${t.topic.name}" merged into "${target.topic.name}"`,
        req
      })
      return { data: { id: o.id } }
    }
  )

  app.delete<{ Params: { oid: string } }>(
    '/topic-map/overrides/:oid',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const ok = await removeOverride(String(req.params.oid), String(req.user!.id))
      if (!ok) return reply.code(404).send({ error: 'Already undone' })
      forgetTopicMap()
      await logActivity({
        action: 'ai-topic-undo',
        user: req.user!.id,
        collection: 'nivaro_extension_settings',
        item: 'nivaro-core:ai_topic_overrides',
        comment: `Undid topic decision ${req.params.oid}`,
        req
      })
      return reply.code(204).send()
    }
  )

  /**
   * Keep one answered question's tool plan as a playbook — Ask AI then offers it
   * as a worked example to anyone asking something similar. `save: false` (the
   * default) only previews it.
   */
  app.post('/topic-map/playbook', { preHandler: requireAdmin }, async (req, reply) => {
    const body = (req.body ?? {}) as { request_id?: unknown; save?: unknown }
    const requestId = String(body.request_id ?? '').slice(0, 40)
    if (!requestId) return reply.code(400).send({ error: 'request_id is required' })
    const calls = (await db('nivaro_ai_calls')
      .where({ request_id: requestId })
      .orderBy('id', 'asc')
      .select('id', 'user', 'request', 'response', 'status')) as Array<Record<string, unknown>>
    if (!calls.length) return reply.code(404).send({ error: 'No logged calls for that question' })
    const last = calls[calls.length - 1]
    const { questionOf, buildTranscript } = await import('../services/ai-call-log/transcript.js')
    const question = questionOf((calls[0].request as string | null) ?? null)
    const trace = traceFromRequest((last.request as string | null) ?? null)
    const answer =
      (
        buildTranscript(null, (last.response as string | null) ?? null).steps.find(
          (s) => s.kind === 'answer'
        ) as { text: string } | undefined
      )?.text ?? ''
    // The plan exactly as it would be stored (values the next asker changes are stripped).
    const plan = planFromTrace(trace)
    const existing = question
      ? ((await db('nivaro_ai_playbooks')
          .where({ question_norm: normalizeQuestion(question) })
          .first('id', 'rating')
          .catch(() => undefined)) as { id: number; rating: number | null } | undefined)
      : undefined
    const preview = {
      question,
      plan,
      skipped_errors: trace.filter((x) => x.summary.startsWith('error:')).length,
      answered: !!answer.trim() && last.status !== 'error',
      replaces: existing ? Number(existing.id) : null
    }
    if (body.save !== true) return { data: { ...preview, saved: false } }
    if (!preview.answered || !plan.length || !question)
      return reply.code(422).send({
        error: !question
          ? 'This call has no question to learn from.'
          : !plan.length
            ? 'The answer used no tools that worked, so there is no plan to keep.'
            : 'The question was not answered, so there is nothing to keep.'
      })
    const id = await recordPlaybook({
      userId: (last.user as string | null) ?? null,
      requestId,
      question,
      trace,
      answer,
      rounds: calls.length
    })
    if (id == null) return reply.code(500).send({ error: 'The playbook could not be saved' })
    // An administrator chose it: offered to everyone, like a thumbs-up answer.
    await db('nivaro_ai_playbooks').where({ id }).update({ rating: 1 })
    const { bustPlaybookCache } = await import('../services/ai-playbooks.js')
    bustPlaybookCache()
    forgetTopicMap()
    await logActivity({
      action: 'ai-playbook-from-question',
      user: req.user!.id,
      collection: 'nivaro_ai_playbooks',
      item: String(id),
      comment: `Kept the plan of question ${requestId} as a playbook (${plan.length} step(s))`,
      req
    })
    return { data: { ...preview, saved: true, id } }
  })

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
