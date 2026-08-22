import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { getAiClient } from '../services/ai-client.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { aggregateThroughput, parseThroughputParams } from '../services/throughput.js'

export async function throughputRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin)

  // GET /reports/throughput?collection=&from=&to=&bucket=&user=
  app.get('/throughput', async (req, reply) => {
    const parsed = parseThroughputParams(req.query as Record<string, unknown>)
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error })
    const { rows, unattributed_transitions } = await aggregateThroughput(parsed.params)
    return reply.send({
      data: rows,
      meta: {
        from: parsed.params.from.toISOString(),
        to: parsed.params.to.toISOString(),
        bucket: parsed.params.bucket,
        unattributed_transitions
      }
    })
  })

  // GET /reports/throughput/collections — collections with a workflow binding
  app.get('/throughput/collections', async (_req, reply) => {
    const rows = (await db('nivaro_workflow_bindings as b')
      .leftJoin('nivaro_collections as c', 'c.collection', 'b.collection')
      .distinct('b.collection as collection', 'c.display_name as display_name')) as Array<{
      collection: string
      display_name: string | null
    }>
    return reply.send({ data: rows.sort((a, b2) => a.collection.localeCompare(b2.collection)) })
  })

  /**
   * State-flow aggregation (#80) — how records actually move through a
   * template: every (from → to) hop in nivaro_workflow_history counted, with
   * per-state totals and median hop time. The Sankey on Team Throughput
   * renders it; back-edges (send-backs) are flagged so the client can color
   * them amber.
   */
  app.get('/state-flow', async (req, reply) => {
    const q = req.query as { template?: string; collection?: string; days?: string }
    let template = q.collection ? null : (q.template ?? null)
    if (!template && q.collection) {
      const binding = (await db('nivaro_workflow_bindings')
        .where({ collection: q.collection })
        .first('template')) as { template: string } | undefined
      template = binding?.template ?? null
    }
    if (!template) return reply.code(400).send({ error: 'template or collection is required' })
    const { days } = q
    const windowDays = Math.min(365, Math.max(1, Number(days) || 90))
    const from = new Date(Date.now() - windowDays * 86_400_000)

    const states = (await db('nivaro_workflow_states')
      .where({ template })
      .orderBy('sort')
      .select('id', 'key', 'label', 'color', 'sort', 'is_initial', 'is_terminal')) as Array<{
      id: string
      key: string
      label: string
      color: string | null
      sort: number
      is_initial: boolean | number
      is_terminal: boolean | number
    }>
    if (states.length === 0) return reply.code(404).send({ error: 'Template has no states' })

    const links = (await db('nivaro_workflow_history as h')
      .join('nivaro_workflow_instances as i', 'i.id', 'h.instance')
      .where('i.template', template)
      .where('h.timestamp', '>=', from)
      .whereNotNull('h.from_state')
      .whereNotNull('h.to_state')
      .groupBy('h.from_state', 'h.to_state')
      .select('h.from_state', 'h.to_state', db.raw('COUNT(*) as count'))) as unknown as Array<{
      from_state: string
      to_state: string
      count: number
    }>

    const sortOf = new Map(states.map((st) => [st.id, st.sort]))
    return reply.send({
      data: {
        window_days: windowDays,
        states,
        links: links
          .filter((l) => sortOf.has(l.from_state) && sortOf.has(l.to_state))
          .map((l) => ({
            from: l.from_state,
            to: l.to_state,
            count: Number(l.count),
            // A hop to a LOWER sort is a send-back — same heuristic the
            // approval-chain path pruning uses.
            back: (sortOf.get(l.to_state) ?? 0) < (sortOf.get(l.from_state) ?? 0)
          }))
      }
    })
  })

  /**
   * Send-back THEMES — team throughput says who reworks; this says WHY.
   * Backward transitions' human comments (machine markers excluded) are
   * clustered by one AI call into named themes with counts + examples.
   * Cached an hour per (collection, days) — the input barely moves intraday.
   */
  app.get('/sendback-themes', { preHandler: requireAdmin }, async (req, reply) => {
    const q = req.query as { collection?: string; days?: string }
    const collection = String(q.collection ?? 'workflows')
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(collection)) {
      return reply.code(400).send({ error: 'Invalid collection' })
    }
    const days = Math.min(Math.max(Number(q.days ?? 90) || 90, 7), 365)
    const cacheKey = `${collection}|${days}`
    const hit = themeCache.get(cacheKey)
    if (hit && Date.now() - hit.at < 60 * 60_000) return { data: hit.data }

    const since = new Date(Date.now() - days * 86_400_000)
    const raw = await db.raw(
      `SELECT TOP 300 h.comment
       FROM nivaro_workflow_history h
       JOIN nivaro_workflow_instances i ON i.id = h.instance AND i.collection = ?
       JOIN nivaro_workflow_states st ON st.id = h.to_state
       JOIN nivaro_workflow_states sf ON sf.id = h.from_state
       WHERE sf.sort > st.sort AND h.[timestamp] >= ?
         AND h.comment IS NOT NULL AND LEN(LTRIM(RTRIM(h.comment))) > 3
         AND h.comment NOT LIKE 'legacy-%' AND h.comment NOT LIKE 'reforecast%'
       ORDER BY h.id DESC`,
      [collection, since]
    )
    const comments = (Array.isArray(raw) ? raw : []).map((r: { comment: string }) =>
      String(r.comment).slice(0, 300)
    )
    if (comments.length < 5) {
      return { data: { themes: [], sample_size: comments.length, note: 'Not enough send-back comments to cluster.' } }
    }
    const client = await getAiClient()
    if (!client) return reply.code(503).send({ error: 'AI is not configured' })
    const resp = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1200,
      messages: [
        {
          role: 'user',
          content: `These are reasons reviewers sent records back for rework. Cluster them into at most 8 named themes. Answer ONLY with JSON: {"themes":[{"theme":"...","count":N,"examples":["...","..."]}]} where count is how many comments fit the theme and examples are up to 2 short verbatim quotes.\n\n${comments.map((c, i) => `${i + 1}. ${c}`).join('\n')}`
        }
      ]
    })
    const text = resp.content
      .filter((b) => b.type === 'text')
      .map((b) => ('text' in b ? b.text : ''))
      .join('')
    let themes: unknown = []
    try {
      const m = text.match(/\{[\s\S]*\}/)
      themes = m ? (JSON.parse(m[0]) as { themes?: unknown }).themes ?? [] : []
    } catch {
      themes = []
    }
    const data = { themes, sample_size: comments.length, days }
    themeCache.set(cacheKey, { at: Date.now(), data })
    return { data }
  })
}

const themeCache = new Map<string, { at: number; data: unknown }>()
