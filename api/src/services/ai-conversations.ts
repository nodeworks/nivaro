import { randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import { db } from '../db/index.js'
import { csvCell } from '../lib/csv-cell.js'
import type { User } from '../types.js'
import type { ChatTraceEntry } from './ai-chat-loop.js'
import { hashToolResult } from './ai-result-hash.js'

/**
 * Ask AI conversations (#1833 history, #1809 sharing, #1883 branches, #1851
 * posting to chat). Tables: migration 433.
 *
 * THE SHARING RULE. A conversation can be read by its owner, by people it was
 * shared with, and by people who can see a chat room it was posted to. Every
 * QUESTION in it is readable by all of them. An ANSWER is readable by the
 * person whose access produced it (`author`) — and by anyone else only when
 * re-running every tool call the answer made, AS THAT VIEWER, gives back
 * exactly what the model saw (same fingerprint, see ai-result-hash.ts) AND
 * every earlier answer in the thread is readable by that viewer too (the
 * model saw those, so a clean answer can still quote a hidden one). An
 * answer with no replayable call, a call that errored, or a tool the replay
 * does not know (proposals, plans, custom SQL, the person's own tasks,
 * anything added later) is private to its author. Admins get no bypass: a
 * conversation is the person's own, like a direct message.
 *
 * A follow-up asked by a viewer is built from the turns THAT viewer may read
 * — a hidden answer goes to the model as a placeholder — and runs with the
 * viewer's permissions, so nothing they cannot read reaches their answer.
 */

export interface ConversationRow {
  id: string
  owner: string
  title: string
  pinned: boolean | number
  parent_id: string | null
  branch_from: number | string | null
  message_count: number
  created_at: Date | string
  updated_at: Date | string
}

export interface MessageRow {
  id: number | string
  conversation_id: string
  role: 'user' | 'assistant'
  author: string | null
  content: string
  trace: string | null
  proposals: string | null
  meta: string | null
  created_at: Date | string
}

export type ConversationAccess = 'owner' | 'shared' | 'room'

/**
 * The tools whose calls only READ, and so may be replayed as a viewer to
 * decide visibility. Anything not listed keeps an answer private — the
 * default for every new tool. Deliberately left out:
 *  - run_custom_query (arbitrary saved SQL re-run on every view),
 *    propose_action / propose_plan (they draft single-use actions);
 *  - my_tasks, my_watches, past_state (the asker's own lists and watches);
 *  - explain_access, explain_person_access, who_can_act, explain_owners
 *    (they describe the asker's or a person's access — not for others);
 *  - search_docs (a replay would record a docs miss against the reader);
 *  - traffic_snapshot (administrators only);
 *  - config_lookup (administrators only), my_team (the asker's own reports),
 *    report_data (the asker's view of a report under the filters on their
 *    screen) — answers about one person's position, not for others;
 *  - page_context (#1835): not a tool but a trace entry the chat route adds
 *    when the page's record, list, report or documents rode the question —
 *    that context never replays, so such an answer stays its author's.
 */
export const REPLAYABLE_TOOLS = new Set([
  'list_collections',
  'query_items',
  'aggregate',
  'semantic_search',
  'record_event_path',
  'record_integrity',
  'queue_summary',
  'search_help_videos',
  'integration_status'
])

/** Tools whose rows an answer can export (#1841) — re-run as the CALLER, so
 *  saved SQL is fine here even though it never decides visibility. */
export const EXPORTABLE_TOOLS = new Set(
  [...REPLAYABLE_TOOLS, 'run_custom_query'].filter((t) => t !== 'list_collections')
)

/**
 * A tombstone: a message whose content and trace are gone but whose place in
 * the thread is kept. It is what a branch holds where the brancher could not
 * read an answer, and what deleting someone else's message leaves. A
 * tombstone counts as a HIDDEN answer for every viewer — so the
 * earlier-answers chain in messagesForViewer can never be unblocked by
 * copying or deleting rows.
 */
export const WITHHELD_META = '{"withheld":true}'

export function isWithheld(row: Pick<MessageRow, 'meta'>): boolean {
  return parseJsonObject(row.meta).withheld === true
}

const CONTENT_CAP = 60_000
const TRACE_CAP = 32_000

const sameId = (a: unknown, b: unknown) =>
  a != null && b != null && String(a).toUpperCase() === String(b).toUpperCase()

export function parseJsonArray<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[]
  if (typeof raw !== 'string' || !raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? (v as T[]) : []
  } catch {
    return []
  }
}

export function parseJsonObject(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw !== 'string' || !raw) return {}
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch {
    return {}
  }
}

/** A short title from the first question. */
export function titleFromQuestion(q: string): string {
  const one = q.replace(/\s+/g, ' ').trim()
  return one.length > 80 ? `${one.slice(0, 79)}…` : one || 'New conversation'
}

// ── Access ───────────────────────────────────────────────────────────────────

export async function getConversation(id: string): Promise<ConversationRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null
  return ((await db('nivaro_ai_conversations').where({ id }).first()) as ConversationRow) ?? null
}

/**
 * How `user` may reach the conversation, or null. Room shares go through the
 * chat's own visibility check, so a reader of a posted conversation is
 * exactly someone who can read the room it was posted to.
 */
export async function conversationAccess(
  user: User,
  conv: ConversationRow
): Promise<ConversationAccess | null> {
  if (sameId(conv.owner, user.id)) return 'owner'
  const shares = (await db('nivaro_ai_conversation_shares')
    .where({ conversation_id: conv.id })
    .select('user', 'room')) as Array<{ user: string | null; room: string | null }>
  if (shares.some((s) => sameId(s.user, user.id))) return 'shared'
  const rooms = shares.map((s) => s.room).filter((r): r is string => !!r)
  if (rooms.length) {
    const { canSeeRoom } = await import('./chat.js')
    for (const room of rooms) {
      if (await canSeeRoom(user, room).catch(() => false)) return 'room'
    }
  }
  return null
}

/** Owner + the people it is shared with (room readers are not enumerated). */
export async function participantsOf(conv: ConversationRow): Promise<string[]> {
  const users = (await db('nivaro_ai_conversation_shares')
    .where({ conversation_id: conv.id })
    .whereNotNull('user')
    .pluck('user')) as string[]
  const out = new Map<string, string>()
  for (const u of [conv.owner, ...users]) out.set(String(u).toUpperCase(), String(u))
  return [...out.values()]
}

// ── Visibility of answers ────────────────────────────────────────────────────

export type ReplayFn = (
  user: User,
  tool: string,
  input: Record<string, unknown>
) => Promise<{ result: unknown }>

const verdicts = new Map<string, { visible: boolean; at: number }>()
// Short: a verdict must not outlive a change to the viewer's access by long.
const VERDICT_TTL_MS = 60_000

/** Tool replays one request may spend on visibility checks (#1809 D7). */
export const REPLAY_BUDGET_PER_REQUEST = 10
export interface ReplayBudget {
  left: number
}

/** Test seam: forget cached verdicts. */
export function clearVisibilityCache(): void {
  verdicts.clear()
}

/**
 * Can this answer be shown to anyone but its author at all, judged from the
 * trace alone? Needs at least one call, every call a replayable read with a
 * fingerprint, and none that errored (error text can carry SQL or field
 * names). An answer with no calls (a restatement of earlier turns) never is.
 */
export function shareableTrace(trace: ChatTraceEntry[]): boolean {
  if (trace.length === 0) return false
  return trace.every(
    (e) =>
      !!e &&
      typeof e.tool === 'string' &&
      REPLAYABLE_TOOLS.has(e.tool) &&
      typeof e.result_hash === 'string' &&
      !(typeof e.summary === 'string' && e.summary.startsWith('error:'))
  )
}

/**
 * May `viewer` read this answer (its own trace only — messagesForViewer also
 * requires every earlier answer to be readable)? Its author always may.
 * Anyone else only when the trace is shareable and every call replays, as
 * them, to the same fingerprint. `budget` caps the replays one request may
 * run; an answer it cannot afford is withheld this time (not cached).
 */
export async function answerVisibleTo(
  viewer: User,
  msg: Pick<MessageRow, 'id' | 'author' | 'trace'>,
  replay?: ReplayFn,
  budget?: ReplayBudget
): Promise<boolean> {
  if (sameId(msg.author, viewer.id)) return true
  const key = `${msg.id}:${String(viewer.id).toUpperCase()}`
  const hit = verdicts.get(key)
  if (hit && Date.now() - hit.at < VERDICT_TTL_MS) return hit.visible
  const trace = parseJsonArray<ChatTraceEntry>(msg.trace)
  let visible = shareableTrace(trace)
  if (visible && budget) {
    if (budget.left < trace.length) return false
    budget.left -= trace.length
  }
  const run: ReplayFn =
    replay ??
    (async (u, tool, input) => {
      const { executeChatTool } = await import('./ai-chat.js')
      return executeChatTool(u, tool, input)
    })
  for (const entry of visible ? trace : []) {
    try {
      const { result } = await run(viewer, entry.tool, entry.input ?? {})
      if (hashToolResult(result) !== entry.result_hash) {
        visible = false
        break
      }
    } catch {
      visible = false
      break
    }
  }
  if (verdicts.size > 2000) verdicts.clear()
  verdicts.set(key, { visible, at: Date.now() })
  return visible
}

// ── Reading ──────────────────────────────────────────────────────────────────

export async function listMessages(conversationId: string): Promise<MessageRow[]> {
  return (await db('nivaro_ai_conversation_messages')
    .where({ conversation_id: conversationId })
    .orderBy('id', 'asc')) as MessageRow[]
}

export interface ViewMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  author: { id: string; name: string } | null
  created_at: string
  /** Assistant turns: false = withheld from this viewer (content is empty). */
  visible: boolean
  /** Answered with this viewer's own access. */
  own: boolean
  trace: ChatTraceEntry[]
  proposals: Array<Record<string, unknown>>
  meta: Record<string, unknown>
}

const PLACEHOLDER =
  '(An answer given to another participant with their access. It is not shown to you — ask again to get an answer with yours.)'

export async function namesFor(ids: string[]): Promise<Map<string, string>> {
  const uniq = [...new Set(ids.filter(Boolean).map((i) => String(i).toUpperCase()))]
  const out = new Map<string, string>()
  if (!uniq.length) return out
  const rows = (await db('nivaro_users')
    .whereIn('id', uniq)
    .select('id', 'first_name', 'last_name', 'email')
    .catch(() => [])) as Array<Record<string, unknown>>
  for (const r of rows) {
    const name = [r.first_name, r.last_name].filter(Boolean).join(' ').trim()
    out.set(String(r.id).toUpperCase(), name || String(r.email ?? 'Someone'))
  }
  return out
}

/** Live outcome of each drafted proposal (#1833 — "proposals and their outcome"). */
async function proposalOutcomes(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const uniq = [...new Set(ids.filter((i) => /^[0-9a-f-]{36}$/i.test(i)))]
  if (!uniq.length) return out
  const rows = (await db('nivaro_ai_proposals')
    .whereIn('id', uniq)
    .select('id', 'status')
    .catch(() => [])) as Array<{ id: string; status: string }>
  for (const r of rows) out.set(String(r.id).toUpperCase(), r.status)
  return out
}

/**
 * The thread as `viewer` may see it. Another person's answer shows only when
 * its own calls replay clean AND every earlier answer is readable by this
 * viewer — the model saw those earlier answers and may repeat them. Once one
 * answer is hidden, no later answer by someone else is replayed at all.
 */
export async function messagesForViewer(
  viewer: User,
  rows: MessageRow[],
  replay?: ReplayFn,
  budget: ReplayBudget = { left: REPLAY_BUDGET_PER_REQUEST }
): Promise<ViewMessage[]> {
  const names = await namesFor(rows.map((r) => r.author ?? ''))
  const proposalIds: string[] = []
  const out: ViewMessage[] = []
  let earlierAllVisible = true
  for (const r of rows) {
    const own = sameId(r.author, viewer.id)
    const withheld = isWithheld(r)
    const visible =
      !withheld &&
      (r.role === 'user' ||
        own ||
        (earlierAllVisible && (await answerVisibleTo(viewer, r, replay, budget))))
    if (r.role === 'assistant' && !visible) earlierAllVisible = false
    // Proposals are single-use and only their proposer may act on them.
    const proposals = own && visible ? parseJsonArray<Record<string, unknown>>(r.proposals) : []
    for (const p of proposals)
      if (typeof p.proposal_id === 'string') proposalIds.push(p.proposal_id)
    // Plans (#1807) ride meta and, like proposals, belong to their asker —
    // so do memory offers (#1845), a kept "remember that" note (#1804), and
    // the follow-up questions and choice pickers (#1834, #1937), which are
    // built from the asker's own tool results.
    const meta = visible ? parseJsonObject(r.meta) : {}
    if (!own) {
      delete meta.plans
      delete meta.memory_suggestions
      delete meta.remembered
      delete meta.followups
      delete meta.choices
    }
    out.push({
      id: String(r.id),
      role: r.role,
      content: visible ? r.content : '',
      author: r.author
        ? { id: String(r.author), name: names.get(String(r.author).toUpperCase()) ?? 'Someone' }
        : null,
      created_at: new Date(r.created_at).toISOString(),
      visible,
      own,
      trace: visible ? parseJsonArray<ChatTraceEntry>(r.trace) : [],
      proposals,
      meta
    })
  }
  const outcomes = await proposalOutcomes(proposalIds)
  for (const m of out) {
    for (const p of m.proposals) {
      const s = outcomes.get(String(p.proposal_id ?? '').toUpperCase())
      if (s) p.status = s
    }
  }
  return out
}

/**
 * The history to send the model for `viewer`'s next question: alternating
 * user/assistant turns, hidden answers replaced by a placeholder, two
 * questions in a row (an answer that failed) folded together.
 */
export function historyFromView(
  view: Array<Pick<ViewMessage, 'role' | 'content' | 'visible'>>
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const out: Array<{ role: 'user' | 'assistant'; content: string }> = []
  for (const m of view) {
    const content = m.role === 'assistant' && !m.visible ? PLACEHOLDER : m.content
    if (!content) continue
    const last = out[out.length - 1]
    if (last && last.role === m.role) last.content = `${last.content}\n\n${content}`
    else out.push({ role: m.role, content })
  }
  while (out.length && out[0].role !== 'user') out.shift()
  while (out.length && out[out.length - 1].role !== 'assistant') out.pop()
  return out
}

// ── Writing ──────────────────────────────────────────────────────────────────

export async function createConversation(
  owner: string,
  title: string,
  extra: { parent_id?: string | null; branch_from?: number | null } = {}
): Promise<ConversationRow> {
  const id = randomUUID()
  const now = new Date()
  const row = {
    id,
    owner,
    title: titleFromQuestion(title).slice(0, 200),
    pinned: false,
    parent_id: extra.parent_id ?? null,
    branch_from: extra.branch_from ?? null,
    message_count: 0,
    created_at: now,
    updated_at: now
  }
  await db('nivaro_ai_conversations').insert(row)
  return row
}

export async function appendMessage(
  conversationId: string,
  m: {
    role: 'user' | 'assistant'
    author: string | null
    content: string
    trace?: unknown[]
    proposals?: unknown[]
    meta?: Record<string, unknown>
  }
): Promise<string> {
  const trace = m.trace?.length ? JSON.stringify(m.trace) : null
  const inserted = await db('nivaro_ai_conversation_messages')
    .insert({
      conversation_id: conversationId,
      role: m.role,
      author: m.author,
      content: String(m.content ?? '').slice(0, CONTENT_CAP),
      // An oversized trace keeps its fingerprints honest by being dropped
      // whole: a cut trace would claim fewer tool calls than the answer made.
      trace:
        trace && trace.length <= TRACE_CAP
          ? trace
          : trace
            ? '[{"tool":"(trace too large)"}]'
            : null,
      proposals: m.proposals?.length ? JSON.stringify(m.proposals) : null,
      meta: m.meta && Object.keys(m.meta).length ? JSON.stringify(m.meta) : null,
      created_at: new Date()
    })
    .returning('id')
  const first = (inserted as unknown[])[0]
  const id = first && typeof first === 'object' ? (first as { id: unknown }).id : first
  await db('nivaro_ai_conversations')
    .where({ id: conversationId })
    .update({ updated_at: new Date(), message_count: db.raw('message_count + 1') })
  return String(id)
}

/**
 * Remove a message's content but keep its place (see WITHHELD_META). Used
 * whenever the message is not the remover's own: the row stays a hidden
 * turn, so later answers that may quote it stay hidden too.
 */
export async function tombstoneMessage(conversationId: string, messageId: string): Promise<void> {
  await db('nivaro_ai_conversation_messages')
    .where({ conversation_id: conversationId, id: messageId })
    .update({ content: '', trace: null, proposals: null, meta: WITHHELD_META })
}

/** Delete outright — only ever for the caller's OWN message (or a failed turn). */
export async function deleteMessage(conversationId: string, messageId: string): Promise<void> {
  const n = await db('nivaro_ai_conversation_messages')
    .where({ conversation_id: conversationId, id: messageId })
    .del()
  if (n) {
    await db('nivaro_ai_conversations')
      .where({ id: conversationId })
      .where('message_count', '>', 0)
      .update({ message_count: db.raw('message_count - 1') })
  }
}

/**
 * Branch (#1883): a new conversation owned by `user`, holding every message
 * of the source BEFORE the edited question, as `user` may read them — an
 * answer withheld from them is copied as a tombstone. Readable copies keep
 * their author and trace, so the sharing rule still decides who else reads
 * each answer. The caller
 * then asks the edited question in the branch.
 */
export async function branchConversation(
  user: User,
  source: ConversationRow,
  fromMessageId: string,
  editedQuestion: string
): Promise<ConversationRow | null> {
  const rows = await listMessages(source.id)
  const idx = rows.findIndex((r) => String(r.id) === String(fromMessageId))
  if (idx < 0 || rows[idx].role !== 'user') return null
  // A branch from the first question is a new question; a later edit keeps
  // the original's title (the edit is what differs, and the list nests it).
  const branch = await createConversation(
    String(user.id),
    idx === 0 ? editedQuestion || source.title : source.title,
    { parent_id: source.id, branch_from: Number(rows[idx].id) }
  )
  const prefix = rows.slice(0, idx)
  // Copy only what the brancher may read: an answer withheld from them (or
  // already a tombstone) becomes a tombstone — never its content or trace —
  // keeping its author, so it still counts as hidden in the new thread.
  const view = await messagesForViewer(user, prefix)
  for (const [i, r] of prefix.entries()) {
    const shown = view[i]?.visible === true && !isWithheld(r)
    await db('nivaro_ai_conversation_messages').insert({
      conversation_id: branch.id,
      role: r.role,
      author: r.author,
      content: shown ? r.content : '',
      trace: shown ? r.trace : null,
      proposals: null,
      meta: shown ? r.meta : WITHHELD_META,
      created_at: r.created_at
    })
  }
  if (prefix.length) {
    await db('nivaro_ai_conversations')
      .where({ id: branch.id })
      .update({ message_count: prefix.length })
    branch.message_count = prefix.length
  }
  return branch
}

// ── Listing ──────────────────────────────────────────────────────────────────

export interface ConversationListItem {
  id: string
  title: string
  pinned: boolean
  parent_id: string | null
  branch_from: string | null
  message_count: number
  created_at: string
  updated_at: string
  owner: { id: string; name: string }
  /** 'owner' or 'shared' (shared with me by someone else). */
  access: 'owner' | 'shared'
  share_count: number
}

const escapeLike = (s: string) => s.replace(/[\\%_[]/g, (c) => `\\${c}`)

/**
 * Search titles and message text — but only text the viewer could read
 * anyway: every question, and answers given with the viewer's own access.
 * Another person's answer is never matched (it may be withheld from them).
 */
export function applyConversationSearch(
  k: Knex,
  q: Knex.QueryBuilder,
  term: string,
  viewerId: string
): Knex.QueryBuilder {
  const like = `%${escapeLike(term.slice(0, 120))}%`
  return q.where((w) => {
    w.whereRaw("c.title LIKE ? ESCAPE '\\'", [like]).orWhereExists(
      k('nivaro_ai_conversation_messages as m')
        .whereRaw('m.conversation_id = c.id')
        .whereRaw("m.content LIKE ? ESCAPE '\\'", [like])
        .where((r) => r.where('m.role', 'user').orWhere('m.author', viewerId))
        .select(k.raw('1'))
    )
  })
}

export async function listConversations(
  user: User,
  opts: { q?: string; pinned?: boolean; limit?: number } = {}
): Promise<ConversationListItem[]> {
  const limit = Math.min(Math.max(Number(opts.limit) || 100, 1), 300)
  const sharedIds = (await db('nivaro_ai_conversation_shares')
    .where({ user: user.id })
    .select('conversation_id', 'pinned')) as Array<{ conversation_id: string; pinned: unknown }>
  const sharedPinned = new Map(sharedIds.map((s) => [s.conversation_id.toUpperCase(), !!s.pinned]))
  const q = db('nivaro_ai_conversations as c').where((w) => {
    w.where('c.owner', user.id)
    if (sharedIds.length)
      w.orWhereIn(
        'c.id',
        sharedIds.map((s) => s.conversation_id)
      )
  })
  const term = opts.q?.trim()
  if (term) applyConversationSearch(db, q, term, String(user.id))
  const rows = (await q
    .orderBy('c.updated_at', 'desc')
    .limit(limit)
    .select('c.*')) as ConversationRow[]
  const counts = rows.length
    ? ((await db('nivaro_ai_conversation_shares')
        .whereIn(
          'conversation_id',
          rows.map((r) => r.id)
        )
        .groupBy('conversation_id')
        .select('conversation_id')
        .count({ n: 'id' })) as Array<{ conversation_id: string; n: number | string }>)
    : []
  const shareCount = new Map(counts.map((c) => [c.conversation_id.toUpperCase(), Number(c.n)]))
  const names = await namesFor(rows.map((r) => r.owner))
  let items = rows.map((r): ConversationListItem => {
    const mine = sameId(r.owner, user.id)
    return {
      id: r.id,
      title: r.title,
      pinned: mine ? !!r.pinned : (sharedPinned.get(r.id.toUpperCase()) ?? false),
      parent_id: r.parent_id,
      branch_from: r.branch_from != null ? String(r.branch_from) : null,
      message_count: Number(r.message_count) || 0,
      created_at: new Date(r.created_at).toISOString(),
      updated_at: new Date(r.updated_at).toISOString(),
      owner: { id: String(r.owner), name: names.get(String(r.owner).toUpperCase()) ?? 'Someone' },
      access: mine ? 'owner' : 'shared',
      share_count: shareCount.get(r.id.toUpperCase()) ?? 0
    }
  })
  if (opts.pinned) items = items.filter((i) => i.pinned)
  // Pinned first, then newest.
  return items.sort((a, b) => Number(b.pinned) - Number(a.pinned))
}

/**
 * "Also delete my saved conversations" (history opt-out): every conversation
 * the caller OWNS — branches included — with its messages and its shares to
 * other people (FK cascade). Conversations other people shared with the
 * caller are theirs and stay.
 */
export async function deleteOwnConversations(userId: string): Promise<number> {
  return (await db('nivaro_ai_conversations').where({ owner: userId }).del()) as number
}

// ── Retention ────────────────────────────────────────────────────────────────

/**
 * Prune conversations untouched past the retention window
 * (nivaro_settings.ai_conversation_retention_days: NULL = 180, 0 = keep
 * forever). Pinned conversations are kept. Messages and shares go with the
 * conversation (FK cascade).
 */
export async function pruneConversations(): Promise<number> {
  const s = (await db('nivaro_settings')
    .where({ id: 1 })
    .first('ai_conversation_retention_days')
    .catch(() => null)) as { ai_conversation_retention_days?: number | null } | null
  if (!s) return 0
  const raw = s.ai_conversation_retention_days
  const days = raw == null ? 180 : Number(raw)
  if (!Number.isFinite(days) || days <= 0) return 0
  const cutoff = new Date(Date.now() - days * 86_400_000)
  // Kept when ANY participant pinned it — the owner (pinned) or a person it
  // was shared with (their own share row's pinned).
  // (No alias on a DELETE — mssql; conversation_id is NOT NULL, so NOT IN is safe.)
  return (await db('nivaro_ai_conversations')
    .where('updated_at', '<', cutoff)
    .where('pinned', false)
    .whereNotIn(
      'id',
      db('nivaro_ai_conversation_shares').where('pinned', true).select('conversation_id')
    )
    .del()) as number
}

export { sameId as sameUserId }

/** Rows for export (#1841): the first array of objects in a tool result. */
export function rowsFromToolResult(result: unknown): Array<Record<string, unknown>> {
  const pick = (v: unknown): Array<Record<string, unknown>> | null =>
    Array.isArray(v) && v.every((r) => r && typeof r === 'object' && !Array.isArray(r))
      ? (v as Array<Record<string, unknown>>)
      : null
  const direct = pick(result)
  if (direct) return direct.map(flattenRow)
  if (result && typeof result === 'object') {
    const obj = result as Record<string, unknown>
    for (const k of ['rows', 'data', 'groups', 'items', 'results', 'records', 'hits']) {
      const v = pick(obj[k])
      if (v) return v.map(flattenRow)
    }
    // A single aggregate row ({count: 12}) exports as one row.
    if (Object.values(obj).every((v) => v == null || typeof v !== 'object')) return [obj]
  }
  return []
}

/** Relation values the chat labels as {id, label} export as their label. */
export function flattenRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && 'label' in v) {
      out[k] = (v as { label: unknown }).label
    } else if (v && typeof v === 'object') {
      out[k] = JSON.stringify(v)
    } else out[k] = v
  }
  return out
}

/** "Open purchase orders by vendor" + time → open-purchase-orders-by-vendor-2026-10-12-1430 */
export function exportFileName(question: string, at = new Date()): string {
  const slug =
    question
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
      .replace(/-+$/, '') || 'ask-ai-answer'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${slug}-${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}`
}

export function toCsv(rows: Array<Record<string, unknown>>): string {
  const cols: string[] = []
  for (const r of rows) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k)
  // Real numbers stay numbers (a negative amount must not become text);
  // everything else goes through the formula-injection-safe cell.
  const cell = (v: unknown) =>
    typeof v === 'number' && Number.isFinite(v) ? String(v) : csvCell(v)
  return [cols.map(cell).join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join(
    '\r\n'
  )
}
