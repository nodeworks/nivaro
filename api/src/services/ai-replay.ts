import { db } from '../db/index.js'
import type { User } from '../types.js'
import { buildChatSystemPrompt } from './ai-chat.js'
import { runChatLoop } from './ai-chat-loop.js'
import { getAiClient } from './ai-client.js'
import { evidenceFromCalls, extractQuestion } from './ai-quality.js'
import { currentTraceMeta, runInTrace } from './request-trace.js'

/**
 * Replay of recent Ask AI questions on another model (#1916). The run state
 * and the runner live here so the route and the model catalogue watch (#2732)
 * share one implementation.
 */

export interface ReplayItem {
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
export interface ReplayRun {
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
export const replayRuns = new Map<string, ReplayRun>()

/** The newest standalone Ask AI questions from the log, with what the current model did. */
export async function loadReplayCandidates(count: number) {
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

/**
 * Run the questions one by one into `run`. Each question runs as the person
 * who asked it, so the tools read only what that person can; proposals are
 * refused (readOnly). Billed to `adminId`, so it counts against that admin's
 * budget.
 */
export async function executeReplay(
  run: ReplayRun,
  cands: Awaited<ReturnType<typeof loadReplayCandidates>>,
  model: string,
  adminId: string
): Promise<void> {
  try {
    for (const c of cands) {
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
          const out = await runInTrace('/api/ai/replay/run', String(adminId), async () => {
            traceId = currentTraceMeta()?.id ?? null
            const client = await getAiClient({ model: model, fallback: false })
            if (!client) throw new Error('AI is not configured')
            const system = await buildChatSystemPrompt(asker)
            return runChatLoop({
              client,
              model: model,
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
}
