import { db } from '../../db/index.js'
import { isWithheld, parseJsonArray, parseJsonObject } from '../ai-conversations.js'
import { likeContains, personName } from './query.js'
import { buildTranscript } from './transcript.js'

/**
 * The whole Ask AI conversation behind a logged call (admin AI hub → Usage →
 * a call → Open conversation). Every turn in order, each answer with the model
 * calls that produced it folded under it, thumbs and comments, cost per turn
 * and in total. A call links to its turn by the request id the answer stored
 * (`meta.request_id`), a turn to its calls by the same id.
 *
 * Calls logged since migration 539 carry `conversation_id`; older ones are
 * found among the asker's own (and shared-with-them) conversations touched
 * after the call. A question asked with history off has no stored thread —
 * the thread is then rebuilt from the call's own request (what the model was
 * sent), marked `reconstructed`.
 */

export interface ThreadCall {
  id: number
  created_at: string
  model: string
  status: string
  stop_reason: string | null
  latency_ms: number
  input_tokens: number | null
  output_tokens: number | null
  cache_read_tokens: number | null
  cost_usd: number | null
  tool_calls: number | null
  tools: string[]
}

export interface ThreadFeedback {
  rating: number
  comment: string | null
  user_name: string
  at: string
}

export interface ThreadTurn {
  /** The question message id ('' when rebuilt). */
  question_id: string
  question: string
  asked_by: string | null
  asked_at: string | null
  answer_id: string | null
  answer: string | null
  answered_at: string | null
  withheld: boolean
  request_id: string | null
  /** Tool steps the answer stored (name, summary, error). */
  trace: Array<{ tool: string; summary: string | null; error: boolean }>
  calls: ThreadCall[]
  cost_usd: number
  tokens: number
  latency_ms: number
  feedback: ThreadFeedback[]
}

export interface Thread {
  conversation: {
    id: string
    title: string
    owner: string | null
    owner_name: string
    created_at: string | null
    updated_at: string | null
    message_count: number
    parent_id: string | null
  } | null
  reconstructed: boolean
  turns: ThreadTurn[]
  totals: { turns: number; calls: number; cost_usd: number; tokens: number; latency_ms: number }
}

const iso = (v: unknown): string | null =>
  v == null ? null : v instanceof Date ? v.toISOString() : String(v)

const toolsList = (v: unknown): string[] =>
  String(v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

export function threadCallOf(r: Record<string, unknown>): ThreadCall {
  return {
    id: Number(r.id),
    created_at: iso(r.created_at) ?? '',
    model: String(r.model ?? ''),
    status: String(r.status ?? ''),
    stop_reason: (r.stop_reason as string | null) ?? null,
    latency_ms: Number(r.latency_ms ?? 0),
    input_tokens: r.input_tokens == null ? null : Number(r.input_tokens),
    output_tokens: r.output_tokens == null ? null : Number(r.output_tokens),
    cache_read_tokens: r.cache_read_tokens == null ? null : Number(r.cache_read_tokens),
    cost_usd: r.cost_usd == null ? null : Number(r.cost_usd),
    tool_calls: r.tool_calls == null ? null : Number(r.tool_calls),
    tools: toolsList(r.tools)
  }
}

export const THREAD_CALL_COLUMNS = [
  'id',
  'request_id',
  'created_at',
  'model',
  'status',
  'stop_reason',
  'latency_ms',
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cost_usd',
  'tool_calls'
]

/** Pure: per-turn figures from its calls. */
export function turnFigures(calls: ThreadCall[]): {
  cost_usd: number
  tokens: number
  latency_ms: number
} {
  return {
    cost_usd: calls.reduce((s, c) => s + (c.cost_usd ?? 0), 0),
    tokens: calls.reduce((s, c) => s + (c.input_tokens ?? 0) + (c.output_tokens ?? 0), 0),
    latency_ms: calls.reduce((s, c) => s + c.latency_ms, 0)
  }
}

/** The conversation a logged call belongs to, or null. */
export async function conversationForCall(call: {
  request_id: string | null
  user: string | null
  created_at: Date | string
  conversation_id?: string | null
}): Promise<{ id: string; message_id: string | null } | null> {
  if (call.conversation_id) {
    const msg = call.request_id
      ? await answerMessageFor(call.conversation_id, call.request_id)
      : null
    return { id: call.conversation_id, message_id: msg }
  }
  if (!call.request_id || !call.user) return null
  const since = new Date(new Date(call.created_at).getTime() - 60_000)
  const own = (await db('nivaro_ai_conversations')
    .where('owner', call.user)
    .where('updated_at', '>=', since)
    .orderBy('updated_at', 'asc')
    .limit(200)
    .pluck('id')) as string[]
  const shared = (await db('nivaro_ai_conversation_shares as s')
    .join('nivaro_ai_conversations as v', 'v.id', 's.conversation_id')
    .where('s.user', call.user)
    .where('v.updated_at', '>=', since)
    .limit(100)
    .select('v.id')
    .catch(() => [])) as Array<{ id: string }>
  const ids = [...new Set([...own.map(String), ...shared.map((r) => String(r.id))])]
  if (!ids.length) return null
  const hit = (await db('nivaro_ai_conversation_messages')
    .whereIn('conversation_id', ids)
    .where('role', 'assistant')
    .whereRaw("meta LIKE ? ESCAPE '\\'", [likeContains(`"request_id":"${call.request_id}"`)])
    .first('id', 'conversation_id')) as { id: unknown; conversation_id: string } | undefined
  return hit ? { id: String(hit.conversation_id), message_id: String(hit.id) } : null
}

async function answerMessageFor(conversationId: string, requestId: string): Promise<string | null> {
  const hit = (await db('nivaro_ai_conversation_messages')
    .where('conversation_id', conversationId)
    .where('role', 'assistant')
    .whereRaw("meta LIKE ? ESCAPE '\\'", [likeContains(`"request_id":"${requestId}"`)])
    .first('id')) as { id: unknown } | undefined
  return hit ? String(hit.id) : null
}

async function namesFor(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const clean = [...new Set(ids.filter(Boolean))]
  for (let i = 0; i < clean.length; i += 500) {
    const rows = (await db('nivaro_users')
      .whereIn('id', clean.slice(i, i + 500))
      .select('id', 'first_name', 'last_name', 'email')) as Array<Record<string, unknown>>
    for (const r of rows) out.set(String(r.id).toLowerCase(), personName(r))
  }
  return out
}

async function callsFor(requestIds: string[]): Promise<Map<string, ThreadCall[]>> {
  const by = new Map<string, ThreadCall[]>()
  const clean = [...new Set(requestIds.filter(Boolean))]
  for (let i = 0; i < clean.length; i += 400) {
    const q = db('nivaro_ai_calls')
      .whereIn('request_id', clean.slice(i, i + 400))
      .orderBy('id', 'asc')
      .limit(4000)
      .select(...THREAD_CALL_COLUMNS)
    const { callLogColumnsSupported } = await import('./columns.js')
    if (await callLogColumnsSupported()) q.select('tools')
    for (const r of (await q) as Array<Record<string, unknown>>) {
      const k = String(r.request_id)
      const a = by.get(k) ?? []
      a.push(threadCallOf(r))
      by.set(k, a)
    }
  }
  return by
}

async function feedbackFor(requestIds: string[]): Promise<Map<string, ThreadFeedback[]>> {
  const by = new Map<string, ThreadFeedback[]>()
  const clean = [...new Set(requestIds.filter(Boolean))]
  for (let i = 0; i < clean.length; i += 400) {
    const rows = (await db('nivaro_ai_feedback as f')
      .leftJoin('nivaro_users as u', 'u.id', 'f.user')
      .whereIn('f.request_id', clean.slice(i, i + 400))
      .select(
        'f.request_id',
        'f.rating',
        'f.comment',
        'f.created_at',
        'f.user',
        'u.first_name',
        'u.last_name',
        'u.email'
      )
      .catch(() => [])) as Array<Record<string, unknown>>
    for (const r of rows) {
      const k = String(r.request_id)
      const a = by.get(k) ?? []
      a.push({
        rating: Number(r.rating),
        comment: (r.comment as string | null) ?? null,
        user_name: personName(r),
        at: iso(r.created_at) ?? ''
      })
      by.set(k, a)
    }
  }
  return by
}

function totalsOf(turns: ThreadTurn[]): Thread['totals'] {
  return {
    turns: turns.length,
    calls: turns.reduce((s, t) => s + t.calls.length, 0),
    cost_usd: turns.reduce((s, t) => s + t.cost_usd, 0),
    tokens: turns.reduce((s, t) => s + t.tokens, 0),
    latency_ms: turns.reduce((s, t) => s + t.latency_ms, 0)
  }
}

/** A stored conversation, every turn with its calls. Null when it is gone. */
export async function loadThread(conversationId: string): Promise<Thread | null> {
  const conv = (await db('nivaro_ai_conversations').where({ id: conversationId }).first()) as
    | Record<string, unknown>
    | undefined
  if (!conv) return null
  const msgs = (await db('nivaro_ai_conversation_messages')
    .where({ conversation_id: conversationId })
    .orderBy('id', 'asc')
    .limit(1000)
    .select('id', 'role', 'author', 'content', 'trace', 'meta', 'created_at')) as Array<
    Record<string, unknown>
  >
  const names = await namesFor([
    String(conv.owner ?? ''),
    ...msgs.map((m) => String(m.author ?? ''))
  ])
  const nameOf = (id: unknown) =>
    id ? (names.get(String(id).toLowerCase()) ?? 'Unknown person') : null

  const turns: ThreadTurn[] = []
  let open: ThreadTurn | null = null
  for (const m of msgs) {
    if (m.role === 'user') {
      open = {
        question_id: String(m.id),
        question: isWithheld(m as never) ? '' : String(m.content ?? ''),
        asked_by: nameOf(m.author),
        asked_at: iso(m.created_at),
        answer_id: null,
        answer: null,
        answered_at: null,
        withheld: isWithheld(m as never),
        request_id: null,
        trace: [],
        calls: [],
        cost_usd: 0,
        tokens: 0,
        latency_ms: 0,
        feedback: []
      }
      turns.push(open)
      continue
    }
    const meta = parseJsonObject(m.meta)
    const t: ThreadTurn =
      open && open.answer_id == null
        ? open
        : {
            question_id: '',
            question: '',
            asked_by: null,
            asked_at: null,
            answer_id: null,
            answer: null,
            answered_at: null,
            withheld: false,
            request_id: null,
            trace: [],
            calls: [],
            cost_usd: 0,
            tokens: 0,
            latency_ms: 0,
            feedback: []
          }
    if (t !== open) turns.push(t)
    const withheld = isWithheld(m as never)
    t.answer_id = String(m.id)
    t.answer = withheld ? null : String(m.content ?? '')
    t.answered_at = iso(m.created_at)
    t.withheld = t.withheld || withheld
    t.request_id = typeof meta.request_id === 'string' ? meta.request_id : null
    t.trace = parseJsonArray<{ tool?: unknown; summary?: unknown }>(m.trace).map((e) => {
      const summary = typeof e.summary === 'string' ? e.summary : null
      return {
        tool: String(e.tool ?? 'tool'),
        summary,
        error: !!summary && /^error\b/i.test(summary)
      }
    })
    open = null
  }

  const reqIds = turns.map((t) => t.request_id).filter((x): x is string => !!x)
  const [calls, feedback] = await Promise.all([callsFor(reqIds), feedbackFor(reqIds)])
  for (const t of turns) {
    if (!t.request_id) continue
    t.calls = calls.get(t.request_id) ?? []
    t.feedback = feedback.get(t.request_id) ?? []
    Object.assign(t, turnFigures(t.calls))
  }
  return {
    conversation: {
      id: String(conv.id),
      title: String(conv.title ?? ''),
      owner: (conv.owner as string | null) ?? null,
      owner_name: nameOf(conv.owner) ?? 'Unknown person',
      created_at: iso(conv.created_at),
      updated_at: iso(conv.updated_at),
      message_count: Number(conv.message_count ?? msgs.length),
      parent_id: (conv.parent_id as string | null) ?? null
    },
    reconstructed: false,
    turns,
    totals: totalsOf(turns)
  }
}

/**
 * Pure: the thread as the model was sent it in one call (history off, or a
 * chat-bot question): earlier turns paired up, then this question and the
 * answer the request's last call gave.
 */
export function rebuildThread(
  lastCall: { request: string | null; response: string | null; stop_reason: string | null },
  requestId: string | null,
  askedBy: string | null
): ThreadTurn[] {
  const t = buildTranscript(lastCall.request, lastCall.response, {
    stopReason: lastCall.stop_reason
  })
  const blank = (): ThreadTurn => ({
    question_id: '',
    question: '',
    asked_by: askedBy,
    asked_at: null,
    answer_id: null,
    answer: null,
    answered_at: null,
    withheld: false,
    request_id: null,
    trace: [],
    calls: [],
    cost_usd: 0,
    tokens: 0,
    latency_ms: 0,
    feedback: []
  })
  const turns: ThreadTurn[] = []
  let cur: ThreadTurn | null = null
  for (const e of t.earlier) {
    if (e.role === 'user') {
      cur = { ...blank(), question: e.text }
      turns.push(cur)
    } else {
      if (!cur || cur.answer != null) {
        cur = blank()
        turns.push(cur)
      }
      cur.answer = e.text
    }
  }
  const q = t.steps.find((s) => s.kind === 'question')
  const answers = t.steps.filter((s) => s.kind === 'answer') as Array<{ text: string }>
  const last: ThreadTurn = {
    ...blank(),
    question: q && q.kind === 'question' ? q.text : '',
    answer: answers.length ? answers[answers.length - 1].text : null,
    request_id: requestId,
    trace: t.steps
      .filter((s) => s.kind === 'tool')
      .map((s) =>
        s.kind === 'tool'
          ? { tool: s.name, summary: s.result?.text ?? null, error: !!s.result?.error }
          : { tool: '', summary: null, error: false }
      )
  }
  turns.push(last)
  return turns
}

/** The thread for a call that has no stored conversation. */
export async function rebuiltThreadFor(call: {
  request_id: string | null
  user: string | null
  id: number
}): Promise<Thread> {
  const last = (await db('nivaro_ai_calls')
    .where(call.request_id ? { request_id: call.request_id } : { id: call.id })
    .orderBy('id', 'desc')
    .first('request', 'response', 'stop_reason')) as
    | { request: string | null; response: string | null; stop_reason: string | null }
    | undefined
  const names = await namesFor(call.user ? [call.user] : [])
  const askedBy = call.user ? (names.get(call.user.toLowerCase()) ?? 'Unknown person') : null
  const turns = last ? rebuildThread(last, call.request_id, askedBy) : []
  const final = turns[turns.length - 1]
  if (final && call.request_id) {
    const [calls, fb] = await Promise.all([
      callsFor([call.request_id]),
      feedbackFor([call.request_id])
    ])
    final.calls = calls.get(call.request_id) ?? []
    final.feedback = fb.get(call.request_id) ?? []
    Object.assign(final, turnFigures(final.calls))
  }
  return { conversation: null, reconstructed: true, turns, totals: totalsOf(turns) }
}

/** Request ids of a conversation's answers (the call-log filter's older rows). */
export async function conversationRequestIds(conversationId: string): Promise<string[]> {
  const rows = (await db('nivaro_ai_conversation_messages')
    .where({ conversation_id: conversationId, role: 'assistant' })
    .orderBy('id', 'asc')
    .limit(400)
    .select('meta')
    .catch(() => [])) as Array<{ meta: unknown }>
  return rows
    .map((r) => parseJsonObject(r.meta).request_id)
    .filter((x): x is string => typeof x === 'string')
}
