import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { buildChatSystemPrompt } from '../services/ai-chat.js'
import { runChatLoop } from '../services/ai-chat-loop.js'
import {
  describeAiProvider,
  getAiClient,
  getAiModelSettings,
  parseAiModels,
  settingsRow
} from '../services/ai-client.js'
import { lastAiHealth, probeAiProvider, registerAiHealthReadiness } from '../services/ai-health.js'
import { registerCorrectionSource } from '../services/ai-knowledge-suggest.js'
import { costOf, priceFor } from '../services/ai-log.js'
import { bustPlaybookCache } from '../services/ai-playbooks.js'
import {
  type BudgetCap,
  budgetDay,
  budgetVerdict,
  bustAiBudgetCache,
  CAUSE_LABELS,
  CAUSES,
  type Cause,
  type CostEstimate,
  canSeeReplay,
  classifyCause,
  estimateRun,
  estimateTokens,
  evidenceFromCalls,
  extractQuestion,
  mergeQualityIntoModels,
  normalizeCap,
  parseQualityConfig,
  type QualityConfig
} from '../services/ai-quality.js'
import { currentTraceMeta, runInTrace } from '../services/request-trace.js'
import { currentStoreId } from '../services/traffic-taps.js'
import type { User } from '../types.js'

/**
 * AI quality and cost tooling around the call log: budgets (#1817, #1893),
 * provider health (#1821), the thumbs-down review queue with cause triage
 * (#1816, #1862), model comparison (#1866) and question replay (#1916).
 * Everything is admin-only except the caller's own remaining budget.
 */

const ID_RE = /^[A-Za-z0-9-]{8,40}$/

async function readQuality(): Promise<{ raw: string | null; id: unknown; cfg: QualityConfig }> {
  const row = (await db('nivaro_settings').orderBy('id', 'asc').first()) as
    | Record<string, unknown>
    | undefined
  const raw = (row?.ai_models as string | null | undefined) ?? null
  return { raw, id: row?.id, cfg: parseQualityConfig(raw) }
}

/** Models an admin may name: the configured per-feature models, the fallback, and priced ids. */
async function allowedModels(): Promise<string[]> {
  const row = await settingsRow()
  const out = new Set<string>()
  const m = await getAiModelSettings()
  for (const v of [m.model, m.chatModel, m.extractModel, m.generateModel, m.summarizeModel])
    if (v) out.add(v)
  for (const v of Object.values(parseAiModels(row ?? {}))) if (v) out.add(v)
  const q = parseQualityConfig(row?.ai_models)
  if (q.fallback_model) out.add(q.fallback_model)
  for (const c of q.budgets.caps) if (c.cheaper_model) out.add(c.cheaper_model)
  return [...out]
}

// ─── replay runs (in-process, one at a time) ────────────────────────────────

interface ReplayItem {
  request_id: string
  question: string
  asker: string
  original: {
    answer: string
    tools: string[]
    rounds: number
    cost_usd: number | null
    latency_ms: number
  }
  replay?: {
    answer: string
    tools: string[]
    rounds: number
    cost_usd: number | null
    latency_ms: number
    error?: string
  }
}
interface ReplayRun {
  id: string
  user: string
  /** Tenant store id (cloud); '' self-hosted. */
  store: string
  model: string
  status: 'running' | 'done' | 'error'
  started_at: string
  finished_at?: string
  total: number
  done: number
  items: ReplayItem[]
  error?: string
}
const replayRuns = new Map<string, ReplayRun>()

/** #1898 — thumbs-down answers with their triaged cause, for the guide drafter. */
async function thumbsDownSignals(since: Date) {
  const fb = (await db('nivaro_ai_feedback')
    .where('rating', -1)
    .where('created_at', '>=', since)
    .orderBy('created_at', 'desc')
    .limit(100)
    .select('request_id', 'comment')) as Array<{ request_id: string; comment: string | null }>
  const ids = [...new Set(fb.map((f) => f.request_id))]
  if (ids.length === 0) return []
  const calls = (await db('nivaro_ai_calls')
    .whereIn('request_id', ids)
    .orderBy('id', 'asc')
    .select('request_id', 'request', 'response')) as Array<{
    request_id: string
    request: string | null
    response: string | null
  }>
  const by = new Map<string, typeof calls>()
  for (const c of calls) by.set(c.request_id, [...(by.get(c.request_id) ?? []), c])
  const out = []
  for (const f of fb) {
    const ev = evidenceFromCalls(by.get(f.request_id) ?? [])
    if (!ev.question) continue
    const cause = classifyCause({
      question: ev.question,
      answer: ev.answer,
      comment: f.comment,
      tools: ev.tools,
      toolErrors: ev.toolErrors
    })
    out.push({
      source: 'ai-quality',
      question: ev.question,
      answer: ev.answer,
      note: `${CAUSE_LABELS[cause]}${f.comment ? `: ${f.comment}` : ''}`
    })
  }
  return out
}

export async function aiQualityRoutes(app: FastifyInstance) {
  registerAiHealthReadiness()
  registerCorrectionSource('ai-quality', thumbsDownSignals)
  // ─── config ───────────────────────────────────────────────────────────────
  app.get('/quality/config', { preHandler: requireAdmin }, async () => {
    const { cfg } = await readQuality()
    return { data: { ...cfg, models: await allowedModels() } }
  })

  app.put('/quality/config', { preHandler: requireAdmin }, async (req, reply) => {
    const body = (req.body ?? {}) as {
      budgets?: { enabled?: unknown; caps?: unknown }
      fallback_model?: unknown
    }
    const rawCaps = Array.isArray(body.budgets?.caps) ? (body.budgets?.caps as unknown[]) : []
    if (rawCaps.length > 50) return reply.code(400).send({ error: 'At most 50 caps' })
    const caps: BudgetCap[] = []
    for (const [i, c] of rawCaps.entries()) {
      const cap = normalizeCap(c)
      if (!cap) {
        return reply.code(400).send({
          error: `Cap ${i + 1} is not valid: it needs a non-negative daily amount, and a person or role to apply to.`
        })
      }
      caps.push(cap)
    }
    const fallback =
      typeof body.fallback_model === 'string' && body.fallback_model.trim()
        ? body.fallback_model.trim().slice(0, 100)
        : null
    const next: QualityConfig = {
      budgets: { enabled: body.budgets?.enabled === true, caps },
      fallback_model: fallback
    }
    const { raw, id } = await readQuality()
    if (id == null) return reply.code(500).send({ error: 'No settings row' })
    await db('nivaro_settings')
      .where({ id })
      .update({ ai_models: mergeQualityIntoModels(raw, next) })
    bustAiBudgetCache()
    await logActivity({
      action: 'ai-quality-config',
      user: req.user!.id,
      comment: `budgets ${next.budgets.enabled ? 'on' : 'off'} · ${caps.length} cap(s) · fallback ${fallback ?? 'none'}`,
      req
    })
    return reply.send({ data: next })
  })

  // ─── budgets ──────────────────────────────────────────────────────────────

  /** What is left for the caller today (#1893). `enabled:false` = nothing to show. */
  app.get<{ Querystring: { feature?: string } }>(
    '/budget/me',
    { preHandler: authenticate },
    async (req) => {
      const { cfg } = await readQuality()
      const feature = (req.query?.feature || 'chat').slice(0, 60)
      const v = await budgetVerdict(cfg, {
        userId: String(req.user!.id),
        roleId: req.user!.role ? String(req.user!.role) : null,
        feature
      })
      if (!cfg.budgets.enabled || v.statuses.length === 0) return { data: { enabled: false } }
      return {
        data: {
          enabled: true,
          remaining_usd: v.remaining_usd,
          resets_at: v.resets_at.toISOString(),
          exhausted: !!v.blocked,
          switched_to_cheaper_model: !!v.cheaper_model
        }
      }
    }
  )

  /** Spend against each cap, for the AI analytics page. */
  app.get('/budget/status', { preHandler: requireAdmin }, async () => {
    const { cfg } = await readQuality()
    const { start, resets_at } = budgetDay()
    const rows = (await db('nivaro_ai_calls as c')
      .leftJoin('nivaro_users as u', 'u.id', 'c.user')
      .where('c.created_at', '>=', start)
      .groupBy('c.user', 'c.feature', 'u.role', 'u.first_name', 'u.last_name')
      .select('c.user', 'c.feature', 'u.role', 'u.first_name', 'u.last_name')
      .sum({ cost: 'c.cost_usd' })) as Array<{
      user: string | null
      feature: string
      role: string | null
      first_name: string | null
      last_name: string | null
      cost: unknown
    }>
    const up = (s: string | null | undefined) => (s ?? '').toUpperCase()
    const caps = cfg.budgets.caps.map((cap) => {
      const matched = rows.filter((r) => {
        if (cap.feature && r.feature !== cap.feature) return false
        if (cap.who === 'person') return up(r.user) === up(cap.who_id)
        if (cap.who === 'role') return up(r.role) === up(cap.who_id)
        return true
      })
      if (cap.pooled) {
        const used = matched.reduce((n, r) => n + (Number(r.cost) || 0), 0)
        return { cap, pooled_used_usd: used, people: [], over: used >= cap.daily_usd }
      }
      const byUser = new Map<string, { name: string; used: number }>()
      for (const r of matched) {
        const k = String(r.user ?? '—')
        const cur = byUser.get(k) ?? {
          name: [r.first_name, r.last_name].filter(Boolean).join(' ') || '(no one)',
          used: 0
        }
        cur.used += Number(r.cost) || 0
        byUser.set(k, cur)
      }
      const people = [...byUser.entries()]
        .map(([user, v]) => ({
          user,
          name: v.name,
          used_usd: v.used,
          over: v.used >= cap.daily_usd
        }))
        .sort((a, b) => b.used_usd - a.used_usd)
        .slice(0, 10)
      return {
        cap,
        pooled_used_usd: null,
        people,
        over: people.some((p) => p.over)
      }
    })
    return {
      data: {
        enabled: cfg.budgets.enabled,
        day_started: start.toISOString(),
        resets_at: resets_at.toISOString(),
        caps
      }
    }
  })

  // ─── provider health ──────────────────────────────────────────────────────
  app.get<{ Querystring: { fresh?: string } }>(
    '/health',
    { preHandler: requireAdmin },
    async (req) => {
      const fresh = req.query?.fresh === '1'
      // a fresh probe costs a call: no more than one per 20 seconds
      const data = await probeAiProvider({ maxAgeMs: fresh ? 20_000 : 300_000 })
      return { data }
    }
  )
  app.get('/health/last', { preHandler: requireAdmin }, async () => ({ data: lastAiHealth() }))

  // ─── review queue ─────────────────────────────────────────────────────────
  app.get<{ Querystring: { status?: string; cause?: string; limit?: string } }>(
    '/review-queue',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const status =
        req.query?.status === 'handled' ? 'handled' : req.query?.status === 'all' ? 'all' : 'open'
      const causeFilter = CAUSES.includes(req.query?.cause as Cause)
        ? (req.query.cause as Cause)
        : null
      const limit = Math.min(100, Math.max(1, Number(req.query?.limit) || 50))
      const fb = (await db('nivaro_ai_feedback as f')
        .leftJoin('nivaro_users as u', 'u.id', 'f.user')
        .where('f.rating', -1)
        .orderBy('f.created_at', 'desc')
        .limit(300)
        .select(
          'f.request_id',
          'f.comment',
          'f.created_at',
          'f.user',
          'u.first_name',
          'u.last_name'
        )) as Array<{
        request_id: string
        comment: string | null
        created_at: string
        user: string
        first_name: string | null
        last_name: string | null
      }>
      const ids = [...new Set(fb.map((r) => r.request_id))]
      if (ids.length === 0) return reply.send({ data: { items: [], counts: {}, total: 0 } })
      const marks = (await db('nivaro_activity')
        .whereIn('action', ['ai-review-handled', 'ai-review-cause'])
        .where({ collection: 'nivaro_ai_feedback' })
        .whereIn('item', ids)
        .orderBy('id', 'asc')
        .select('action', 'item', 'comment', 'timestamp')) as Array<{
        action: string
        item: string
        comment: string | null
        timestamp: string
      }>
      const handled = new Map<string, string>()
      const causeSet = new Map<string, Cause>()
      for (const m of marks) {
        if (m.action === 'ai-review-handled') handled.set(m.item, m.timestamp)
        else if (CAUSES.includes(m.comment as Cause)) causeSet.set(m.item, m.comment as Cause)
      }
      const wanted = ids.filter((id) =>
        status === 'all' ? true : status === 'handled' ? handled.has(id) : !handled.has(id)
      )
      // The window is bounded before the call bodies are read — they are large.
      const page = wanted.slice(0, causeFilter ? 150 : limit)
      const calls = page.length
        ? ((await db('nivaro_ai_calls')
            .whereIn('request_id', page)
            .orderBy('id', 'asc')
            .select('request_id', 'request', 'response', 'feature')) as Array<{
            request_id: string
            request: string | null
            response: string | null
            feature: string
          }>)
        : []
      const byReq = new Map<string, typeof calls>()
      for (const c of calls) {
        const a = byReq.get(c.request_id) ?? []
        a.push(c)
        byReq.set(c.request_id, a)
      }
      const playbooks = page.length
        ? ((await db('nivaro_ai_playbooks')
            .whereIn('request_id', page)
            .select('id', 'request_id')) as Array<{
            id: number
            request_id: string
          }>)
        : []
      const pbBy = new Map(playbooks.map((p) => [p.request_id, Number(p.id)]))
      const first = new Map<string, (typeof fb)[number]>()
      for (const r of fb) if (!first.has(r.request_id)) first.set(r.request_id, r)

      const items = page.map((id) => {
        const f = first.get(id)!
        const ev = evidenceFromCalls(byReq.get(id) ?? [])
        const auto = classifyCause({
          question: ev.question,
          answer: ev.answer,
          comment: f.comment,
          tools: ev.tools,
          toolErrors: ev.toolErrors
        })
        const cause = causeSet.get(id) ?? auto
        return {
          request_id: id,
          created_at: f.created_at,
          person: [f.first_name, f.last_name].filter(Boolean).join(' ') || null,
          comment: f.comment,
          feature: byReq.get(id)?.[0]?.feature ?? null,
          question: ev.question,
          answer: ev.answer,
          tools: ev.tools,
          tool_errors: ev.toolErrors,
          cause,
          cause_label: CAUSE_LABELS[cause],
          cause_overridden: causeSet.has(id),
          handled_at: handled.get(id) ?? null,
          playbook_id: pbBy.get(id) ?? null
        }
      })
      const counts: Record<string, number> = {}
      for (const i of items) counts[i.cause] = (counts[i.cause] ?? 0) + 1
      const shown = (causeFilter ? items.filter((i) => i.cause === causeFilter) : items).slice(
        0,
        limit
      )
      return reply.send({ data: { items: shown, counts, total: wanted.length } })
    }
  )

  app.post<{ Params: { requestId: string } }>(
    '/review-queue/:requestId/handle',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const id = req.params.requestId
      if (!ID_RE.test(id)) return reply.code(400).send({ error: 'Bad request id' })
      const body = (req.body ?? {}) as { action?: string; hint?: string; cause?: string }
      const exists = await db('nivaro_ai_feedback')
        .where({ request_id: id, rating: -1 })
        .first('id')
      if (!exists)
        return reply.code(404).send({ error: 'No thumbs-down answer matches that request' })
      const mark = (action: string, comment: string) =>
        logActivity({
          action,
          user: req.user!.id,
          collection: 'nivaro_ai_feedback',
          item: id,
          comment,
          req
        })
      switch (body.action) {
        case 'handled':
          await mark('ai-review-handled', 'marked handled')
          return reply.send({ data: { ok: true } })
        case 'set_cause': {
          if (!CAUSES.includes(body.cause as Cause))
            return reply.code(400).send({ error: 'Unknown cause' })
          await mark('ai-review-cause', String(body.cause))
          return reply.send({ data: { ok: true } })
        }
        case 'delete_playbook': {
          const n = await db('nivaro_ai_playbooks').where({ request_id: id }).del()
          bustPlaybookCache()
          await mark('ai-review-handled', `deleted ${n} playbook(s)`)
          return reply.send({ data: { deleted: n } })
        }
        case 'add_hint': {
          const hint = typeof body.hint === 'string' ? body.hint.trim().slice(0, 500) : ''
          if (!hint) return reply.code(400).send({ error: 'The hint is empty' })
          const row = (await db('nivaro_settings')
            .orderBy('id', 'asc')
            .first('id', 'ai_chat_guide')) as
            | { id: unknown; ai_chat_guide: string | null }
            | undefined
          if (!row) return reply.code(500).send({ error: 'No settings row' })
          const next = `${(row.ai_chat_guide ?? '').trim()}\n${hint}`.trim()
          await db('nivaro_settings').where({ id: row.id }).update({ ai_chat_guide: next })
          await mark('ai-review-handled', `added a hint to the data guide (${hint.length} chars)`)
          return reply.send({ data: { ok: true } })
        }
        default:
          return reply.code(400).send({ error: 'Unknown action' })
      }
    }
  )

  // ─── compare models (#1866) ───────────────────────────────────────────────
  const parseCompare = async (body: Record<string, unknown>) => {
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
    const system = typeof body.system === 'string' ? body.system.trim() : ''
    const models = Array.isArray(body.models)
      ? [...new Set(body.models.map((m) => String(m).trim()).filter(Boolean))]
      : []
    const maxTokens = Math.min(2000, Math.max(50, Number(body.max_tokens) || 800))
    if (!prompt) return { error: 'The prompt is empty' }
    if (prompt.length + system.length > 40_000)
      return { error: 'The prompt is too long (40,000 characters)' }
    if (models.length !== 2) return { error: 'Pick exactly two models' }
    const allowed = await allowedModels()
    const bad = models.filter((m) => !allowed.includes(m) && !priceFor(m))
    if (bad.length) return { error: `Not a configured model: ${bad.join(', ')}` }
    const est = models.map((m) =>
      estimateRun(
        m,
        { inputTokens: estimateTokens(prompt + system) + 20, outputTokens: maxTokens },
        1
      )
    )
    return { prompt, system, models, maxTokens, est }
  }
  const totalOf = (est: CostEstimate[]) =>
    est.every((e) => e.cost_usd != null) ? est.reduce((n, e) => n + (e.cost_usd ?? 0), 0) : null

  app.post('/compare/estimate', { preHandler: requireAdmin }, async (req, reply) => {
    const p = await parseCompare((req.body ?? {}) as Record<string, unknown>)
    if ('error' in p) return reply.code(400).send({ error: p.error })
    return reply.send({
      data: {
        estimates: p.est,
        total_usd: totalOf(p.est),
        note: 'An upper bound: the answer may be shorter than the maximum.'
      }
    })
  })

  app.post('/compare/run', { preHandler: requireAdmin }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const p = await parseCompare(body)
    if ('error' in p) return reply.code(400).send({ error: p.error })
    // The estimate is shown first and echoed back: a run without it is refused.
    const total = totalOf(p.est)
    const confirmed = Number(body.confirmed_cost_usd)
    if (!Number.isFinite(confirmed) || (total != null && confirmed + 1e-9 < total)) {
      return reply
        .code(409)
        .send({ error: 'Confirm the cost estimate first', estimates: p.est, total_usd: total })
    }
    const user = req.user!
    const results = await Promise.all(
      p.models.map(async (model) => {
        const t0 = Date.now()
        try {
          const client = await getAiClient({ model, fallback: false })
          if (!client) throw new Error('AI is not configured')
          const res = await client.messages.create({
            model,
            max_tokens: p.maxTokens,
            ...(p.system ? { system: p.system } : {}),
            messages: [{ role: 'user', content: p.prompt }]
          })
          const text = res.content
            .map((b) => (b.type === 'text' ? b.text : ''))
            .join('')
            .trim()
          const input = res.usage?.input_tokens ?? null
          const output = res.usage?.output_tokens ?? null
          return {
            model,
            answered_by: res.model || model,
            text,
            input_tokens: input,
            output_tokens: output,
            cost_usd: costOf(res.model || model, { input, output }),
            latency_ms: Date.now() - t0
          }
        } catch (err) {
          return {
            model,
            error: String((err as Error)?.message ?? err).slice(0, 300),
            latency_ms: Date.now() - t0
          }
        }
      })
    )
    await logActivity({
      action: 'ai-compare-models',
      user: user.id,
      comment: `${p.models.join(' vs ')} · prompt ${p.prompt.length} chars · $${results
        .reduce((n, r) => n + (('cost_usd' in r && r.cost_usd) || 0), 0)
        .toFixed(4)}`,
      req
    })
    return reply.send({ data: { results } })
  })

  // ─── replay recent questions (#1916) ──────────────────────────────────────
  /** The newest standalone Ask AI questions from the log, with what the current model did. */
  async function loadReplayCandidates(count: number) {
    const firsts = (await db('nivaro_ai_calls')
      .where({ feature: 'chat', status: 'ok', rounds: 1 })
      .whereNotNull('user')
      .whereNotNull('request_id')
      .orderBy('id', 'desc')
      .limit(count * 3)
      .select('request_id', 'user', 'request')) as Array<{
      request_id: string
      user: string
      request: string | null
    }>
    const picked: Array<{ request_id: string; user: string; question: string }> = []
    const seen = new Set<string>()
    for (const f of firsts) {
      if (seen.has(f.request_id)) continue
      const q = extractQuestion(f.request)
      if (!q) continue
      seen.add(f.request_id)
      picked.push({ request_id: f.request_id, user: String(f.user), question: q })
      if (picked.length >= count) break
    }
    if (picked.length === 0) return []
    const all = (await db('nivaro_ai_calls')
      .whereIn(
        'request_id',
        picked.map((p) => p.request_id)
      )
      .orderBy('id', 'asc')
      .select(
        'request_id',
        'request',
        'response',
        'input_tokens',
        'output_tokens',
        'cost_usd',
        'latency_ms',
        'rounds'
      )) as Array<{
      request_id: string
      request: string | null
      response: string | null
      input_tokens: number | null
      output_tokens: number | null
      cost_usd: number | null
      latency_ms: number | null
    }>
    const grouped = new Map<string, typeof all>()
    for (const c of all) {
      const a = grouped.get(c.request_id) ?? []
      a.push(c)
      grouped.set(c.request_id, a)
    }
    return picked.map((p) => {
      const calls = grouped.get(p.request_id) ?? []
      const ev = evidenceFromCalls(calls)
      return {
        ...p,
        input_tokens: calls.reduce((n, c) => n + (Number(c.input_tokens) || 0), 0),
        output_tokens: calls.reduce((n, c) => n + (Number(c.output_tokens) || 0), 0),
        original: {
          answer: ev.answer,
          tools: ev.tools,
          rounds: calls.length,
          cost_usd: calls.some((c) => c.cost_usd != null)
            ? calls.reduce((n, c) => n + (Number(c.cost_usd) || 0), 0)
            : null,
          latency_ms: calls.reduce((n, c) => n + (Number(c.latency_ms) || 0), 0)
        }
      }
    })
  }

  const parseReplay = async (body: Record<string, unknown>) => {
    const model = typeof body.model === 'string' ? body.model.trim() : ''
    const count = Math.min(50, Math.max(1, Number(body.count) || 50))
    if (!model) return { error: 'Name the candidate model' }
    const allowed = await allowedModels()
    if (!allowed.includes(model) && !priceFor(model))
      return { error: `Not a configured model: ${model}` }
    const cands = await loadReplayCandidates(count)
    if (cands.length === 0) return { error: 'No recent standalone Ask AI questions in the log' }
    // Priced from what the real runs consumed — the tokens are logged facts.
    const input = cands.reduce((n, c) => n + c.input_tokens, 0)
    const output = cands.reduce((n, c) => n + c.output_tokens, 0)
    const est: CostEstimate = {
      model,
      calls: cands.length,
      input_tokens: input,
      output_tokens: output,
      cost_usd: costOf(model, { input, output })
    }
    return { model, cands, est }
  }

  app.post('/replay/estimate', { preHandler: requireAdmin }, async (req, reply) => {
    const p = await parseReplay((req.body ?? {}) as Record<string, unknown>)
    if ('error' in p) return reply.code(400).send({ error: p.error })
    return reply.send({
      data: {
        estimate: p.est,
        questions: p.cands.map((c) => ({ request_id: c.request_id, question: c.question }))
      }
    })
  })

  app.post('/replay/run', { preHandler: requireAdmin }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const p = await parseReplay(body)
    if ('error' in p) return reply.code(400).send({ error: p.error })
    const confirmed = Number(body.confirmed_cost_usd)
    const total = p.est.cost_usd
    if (!Number.isFinite(confirmed) || (total != null && confirmed + 1e-9 < total)) {
      return reply.code(409).send({ error: 'Confirm the cost estimate first', estimate: p.est })
    }
    const store = currentStoreId()
    if ([...replayRuns.values()].some((r) => r.status === 'running' && r.store === store)) {
      return reply.code(409).send({ error: 'A replay is already running' })
    }
    const admin = req.user!
    const run: ReplayRun = {
      id: randomUUID(),
      user: String(admin.id),
      store,
      model: p.model,
      status: 'running',
      started_at: new Date().toISOString(),
      total: p.cands.length,
      done: 0,
      items: []
    }
    replayRuns.set(run.id, run)
    for (const [k, v] of replayRuns) {
      if (v.status !== 'running' && Date.now() - new Date(v.started_at).getTime() > 3_600_000)
        replayRuns.delete(k)
    }
    await logActivity({
      action: 'ai-replay-questions',
      user: admin.id,
      comment: `${p.cands.length} question(s) on ${p.model} · estimate $${(total ?? 0).toFixed(4)}`,
      req
    })
    // Detached: each question runs as the person who asked it, so the tools
    // read only what that person can. Proposals are refused (readOnly).
    void (async () => {
      try {
        for (const c of p.cands) {
          const asker = (await db('nivaro_users')
            .where({ id: c.user, status: 'active' })
            .first()
            .catch(() => null)) as User | null
          const item: ReplayItem = {
            request_id: c.request_id,
            question: c.question,
            asker: asker
              ? `${asker.first_name ?? ''} ${asker.last_name ?? ''}`.trim() || asker.email
              : '(inactive)',
            original: c.original
          }
          if (!asker) {
            item.replay = {
              answer: '',
              tools: [],
              rounds: 0,
              cost_usd: null,
              latency_ms: 0,
              error: 'The person who asked is no longer active'
            }
          } else {
            const t0 = Date.now()
            let traceId: string | null = null
            try {
              // billed to the admin who started the run, so it counts against their budget
              const out = await runInTrace('/api/ai/replay/run', String(admin.id), async () => {
                traceId = currentTraceMeta()?.id ?? null
                const client = await getAiClient({ model: p.model, fallback: false })
                if (!client) throw new Error('AI is not configured')
                const system = await buildChatSystemPrompt(asker)
                return runChatLoop({
                  client,
                  model: p.model,
                  system,
                  user: asker,
                  convo: [{ role: 'user', content: c.question }],
                  readOnly: true
                })
              })
              let cost: number | null = null
              if (traceId) {
                const r = (await db('nivaro_ai_calls')
                  .where({ request_id: traceId })
                  .sum({ total: 'cost_usd' })
                  .first()
                  .catch(() => null)) as { total?: unknown } | null
                cost = r?.total == null ? null : Number(r.total)
              }
              item.replay = {
                answer: out.text,
                tools: out.trace.map((t) => t.tool),
                rounds: out.rounds,
                cost_usd: cost,
                latency_ms: Date.now() - t0
              }
            } catch (err) {
              item.replay = {
                answer: '',
                tools: [],
                rounds: 0,
                cost_usd: null,
                latency_ms: Date.now() - t0,
                error: String((err as Error)?.message ?? err).slice(0, 300)
              }
              // a spent budget or a down provider will not recover mid-run
              if ((err as { code?: string }).code === 'AI_BUDGET_EXCEEDED') {
                run.items.push(item)
                run.done++
                throw err
              }
            }
          }
          run.items.push(item)
          run.done++
        }
        run.status = 'done'
      } catch (err) {
        run.status = 'error'
        run.error = String((err as Error)?.message ?? err).slice(0, 300)
      } finally {
        run.finished_at = new Date().toISOString()
      }
    })()
    return reply.code(202).send({ data: { run_id: run.id } })
  })

  app.get<{ Params: { id: string } }>(
    '/replay/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const found = replayRuns.get(req.params.id)
      const run =
        found && canSeeReplay(found, String(req.user!.id), currentStoreId()) ? found : undefined
      if (!run)
        return reply
          .code(404)
          .send({ error: 'No such replay on this server (they are kept for an hour)' })
      return reply.send({ data: run })
    }
  )

  /** The provider card text for the page. */
  app.get('/quality/overview', { preHandler: requireAdmin }, async () => {
    const info = await describeAiProvider()
    const { cfg } = await readQuality()
    return {
      data: {
        provider: info.provider,
        configured: info.configured,
        model: info.model,
        quality: cfg
      }
    }
  })
}
