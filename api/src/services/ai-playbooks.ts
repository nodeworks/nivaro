/**
 * Ask AI playbooks — the chat's memory of what worked.
 *
 * After a standalone question is answered with tool calls, the question, its
 * embedding, the tool plan and the answer are stored. A later question that
 * embeds close to a stored one gets that plan as a worked example in the
 * system prompt: the model reuses the collection, the filter shape and the
 * dotted paths instead of rediscovering them over several rounds.
 *
 * Thumbs feedback (one per person per question) sums into the playbook's
 * rating; a net-negative playbook is never offered again. Nothing here changes
 * what the model may do — every tool call still runs as the requesting user.
 */
import { db } from '../db/index.js'
import { cosineSim, embedText } from './embeddings.js'

export interface PlaybookStep {
  tool: string
  input: Record<string, unknown>
}

export interface Playbook {
  id: number
  question: string
  plan: PlaybookStep[]
  answer: string
  rating: number | null
  use_count: number
  embedding: number[]
}

export interface TraceEntry {
  tool: string
  input: Record<string, unknown>
  summary: string
}

export const PLAYBOOK_LIMIT = 3
const MAX_QUESTION = 2000
const MAX_ANSWER = 1500
const MAX_PLAN_STEPS = 12
const MAX_INPUT_CHARS = 400
const CANDIDATE_CAP = 2000
const CACHE_MS = 60_000

/** Voyage vectors separate well; the local hash fallback needs a looser bar. */
export function similarityThreshold(): number {
  return process.env.VOYAGE_API_KEY ? 0.72 : 0.55
}

export function normalizeQuestion(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 500)
}

/** Successful tool calls only — an errored call is not part of the plan. */
export function planFromTrace(trace: TraceEntry[]): PlaybookStep[] {
  const out: PlaybookStep[] = []
  for (const t of trace) {
    if (!t?.tool || (typeof t.summary === 'string' && t.summary.startsWith('error:'))) continue
    out.push({ tool: t.tool, input: t.input ?? {} })
    if (out.length >= MAX_PLAN_STEPS) break
  }
  return out
}

/** Top `limit` candidates by cosine at or above `threshold`, best first. */
export function rankPlaybooks(
  candidates: Playbook[],
  query: number[],
  threshold: number,
  limit: number
): Array<Playbook & { score: number }> {
  const scored: Array<Playbook & { score: number }> = []
  for (const c of candidates) {
    if (c.rating != null && c.rating < 0) continue
    const score = cosineSim(query, c.embedding)
    if (score >= threshold) scored.push({ ...c, score })
  }
  scored.sort((a, b) => b.score - a.score || (b.rating ?? 0) - (a.rating ?? 0))
  return scored.slice(0, limit)
}

function stepText(s: PlaybookStep): string {
  let input = ''
  try {
    input = JSON.stringify(s.input ?? {})
  } catch {
    input = '{}'
  }
  if (input.length > MAX_INPUT_CHARS) input = `${input.slice(0, MAX_INPUT_CHARS)}…`
  return `${s.tool}(${input})`
}

/** The system-prompt block. Empty string when there is nothing to show. */
export function formatPlaybooksForPrompt(list: Playbook[]): string {
  if (list.length === 0) return ''
  const lines = list.map((p, i) => {
    const answer = p.answer.replace(/\s+/g, ' ').trim()
    const clipped = answer.length > 240 ? `${answer.slice(0, 240)}…` : answer
    return `${i + 1}. Q: ${p.question}\n   Plan: ${p.plan.map(stepText).join(' → ')}\n   Answer given: ${clipped}`
  })
  return `Answered before — similar questions and the tool plans that worked. Reuse a plan when the question matches (adapt the names and values); if none fits, ignore them:\n${lines.join('\n')}`
}

// ─── storage ────────────────────────────────────────────────────────────────

let cache: { at: number; rows: Playbook[] } | null = null

export function bustPlaybookCache(): void {
  cache = null
}

function parseArray<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string') return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

async function candidates(): Promise<Playbook[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.rows
  const rows = await db('nivaro_ai_playbooks')
    .select('id', 'question', 'embedding', 'plan', 'answer', 'rating', 'use_count')
    .where((b) => b.whereNull('rating').orWhere('rating', '>=', 0))
    .orderBy('updated_at', 'desc')
    .limit(CANDIDATE_CAP)
  const parsed: Playbook[] = []
  for (const r of rows as Array<Record<string, unknown>>) {
    const embedding = parseArray<number[]>(r.embedding, [])
    if (!Array.isArray(embedding) || embedding.length === 0) continue
    parsed.push({
      id: Number(r.id),
      question: String(r.question ?? ''),
      plan: parseArray<PlaybookStep[]>(r.plan, []),
      answer: typeof r.answer === 'string' ? r.answer : '',
      rating: r.rating == null ? null : Number(r.rating),
      use_count: Number(r.use_count ?? 0),
      embedding
    })
  }
  cache = { at: Date.now(), rows: parsed }
  return parsed
}

/**
 * Playbooks similar to `question`, best first. Bumps use counts in the
 * background. Never throws — a retrieval failure just means no examples.
 */
export async function retrievePlaybooks(
  question: string,
  opts: { limit?: number } = {}
): Promise<Array<Playbook & { score: number }>> {
  const q = question?.trim()
  if (!q) return []
  try {
    const [rows, embedding] = await Promise.all([candidates(), embedText(q.slice(0, MAX_QUESTION))])
    const picked = rankPlaybooks(
      rows,
      embedding,
      similarityThreshold(),
      opts.limit ?? PLAYBOOK_LIMIT
    )
    if (picked.length > 0) {
      const now = new Date()
      void db('nivaro_ai_playbooks')
        .whereIn(
          'id',
          picked.map((p) => p.id)
        )
        .update({ last_used_at: now })
        .increment('use_count', 1)
        .catch(() => undefined)
    }
    return picked
  } catch {
    return []
  }
}

/**
 * Store (or refresh) the playbook for a question the chat answered with tool
 * calls. Returns the row id, or null when there is nothing worth keeping.
 */
export async function recordPlaybook(args: {
  userId?: string | null
  requestId?: string | null
  question: string
  trace: TraceEntry[]
  answer: string
  rounds?: number
}): Promise<number | null> {
  const question = args.question?.trim().slice(0, MAX_QUESTION)
  const answer = args.answer?.trim().slice(0, MAX_ANSWER) ?? ''
  const plan = planFromTrace(args.trace ?? [])
  if (!question || !answer || plan.length === 0) return null
  let embedding: number[]
  try {
    embedding = await embedText(question)
  } catch {
    return null
  }
  const now = new Date()
  const norm = normalizeQuestion(question)
  const row = {
    updated_at: now,
    user: args.userId ?? null,
    request_id: args.requestId ?? null,
    question,
    question_norm: norm,
    embedding: JSON.stringify(embedding),
    plan: JSON.stringify(plan),
    answer,
    rounds: args.rounds ?? null,
    rating: null as number | null // a fresh answer starts unrated
  }
  const existing = await db('nivaro_ai_playbooks')
    .select('id')
    .where({ question_norm: norm })
    .first()
  let id: number
  if (existing) {
    id = Number(existing.id)
    await db('nivaro_ai_playbooks').where({ id }).update(row)
  } else {
    await db('nivaro_ai_playbooks').insert({ ...row, created_at: now, use_count: 0 })
    const created = await db('nivaro_ai_playbooks')
      .select('id')
      .where({ question_norm: norm })
      .orderBy('id', 'desc')
      .first()
    id = Number(created?.id ?? 0)
  }
  bustPlaybookCache()
  return id || null
}

// ─── feedback ───────────────────────────────────────────────────────────────

/** Upsert one person's thumbs for a question and re-sum the playbook rating. */
export async function recordFeedback(args: {
  requestId: string
  userId: string
  rating: 1 | -1
  comment?: string | null
}): Promise<void> {
  const now = new Date()
  const comment = args.comment?.trim().slice(0, 1000) || null
  const existing = await db('nivaro_ai_feedback')
    .select('id')
    .where({ request_id: args.requestId, user: args.userId })
    .first()
  if (existing) {
    await db('nivaro_ai_feedback')
      .where({ id: existing.id })
      .update({ rating: args.rating, comment, created_at: now })
  } else {
    await db('nivaro_ai_feedback').insert({
      created_at: now,
      request_id: args.requestId,
      user: args.userId,
      rating: args.rating,
      comment
    })
  }
  const sum = await db('nivaro_ai_feedback')
    .where({ request_id: args.requestId })
    .sum({ total: 'rating' })
    .first()
  const total = Number((sum as { total?: unknown } | undefined)?.total ?? 0)
  await db('nivaro_ai_playbooks')
    .where({ request_id: args.requestId })
    .update({ rating: total, updated_at: now })
  bustPlaybookCache()
}

export async function feedbackSummary(since: Date): Promise<{ up: number; down: number }> {
  const row = await db('nivaro_ai_feedback')
    .where('created_at', '>=', since)
    .first(
      db.raw('SUM(CASE WHEN rating > 0 THEN 1 ELSE 0 END) as up'),
      db.raw('SUM(CASE WHEN rating < 0 THEN 1 ELSE 0 END) as down')
    )
  const r = (row ?? {}) as { up?: unknown; down?: unknown }
  return { up: Number(r.up ?? 0), down: Number(r.down ?? 0) }
}
