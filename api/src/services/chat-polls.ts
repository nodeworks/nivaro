import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import type { User } from '../types.js'
import { tenantState } from './ai-tenant-state.js'
import { canSeeRoom } from './chat.js'
import { ChatSendError, postChatMessage } from './chat-send.js'
import { tenantScopedRoom } from './tenant-rooms.js'

/**
 * Chat polls (#2337). A poll is a normal chat message (the question, so it
 * reads fine in digests, search and push) plus a row in nivaro_chat_polls
 * keyed by the message id; votes are one row per person per option.
 *
 * Votes are checked against the room: voting needs canSeeRoom. An anonymous
 * poll never returns who voted what — only counts and the viewer's own picks.
 */

export const MAX_POLL_OPTIONS = 10
export const MIN_POLL_OPTIONS = 2

export interface PollOptionView {
  index: number
  label: string
  count: number
  /** Voter display names — absent on an anonymous poll. */
  voters?: Array<{ id: string; name: string | null }>
}

export interface PollView {
  id: number
  message_id: number
  question: string
  multiple: boolean
  anonymous: boolean
  closes_at: string | null
  closed_at: string | null
  closed: boolean
  options: PollOptionView[]
  /** Option indexes the viewer picked. */
  mine: number[]
  /** People who voted at least once. */
  total_voters: number
  /** The viewer wrote the poll and may close it early. */
  can_close: boolean
}

// Per tenant: each tenant database is probed on its own.
const probe = tenantState<{ ok: boolean | null; at: number }>(() => ({ ok: null, at: 0 }))
/** A tenant behind migration 430 simply has no polls. A hit caches; a miss re-probes. */
export async function pollTablesExist(): Promise<boolean> {
  const p = probe()
  if (p.ok === true) return true
  if (p.ok === false && Date.now() - p.at < 60_000) return false
  try {
    p.ok =
      (await db.schema.hasTable('nivaro_chat_polls')) &&
      (await db.schema.hasTable('nivaro_chat_poll_votes'))
  } catch {
    p.ok = false
  }
  p.at = Date.now()
  return p.ok
}

function parseOptions(raw: unknown): string[] {
  try {
    const arr = JSON.parse(String(raw ?? '[]'))
    return Array.isArray(arr) ? arr.map(String) : []
  } catch {
    return []
  }
}

/** Trim, drop blanks, dedupe case-insensitively, cap. Pure. */
export function cleanPollOptions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const o of raw) {
    const label = String(o ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 100)
    if (!label || seen.has(label.toLowerCase())) continue
    seen.add(label.toLowerCase())
    out.push(label)
    if (out.length >= MAX_POLL_OPTIONS) break
  }
  return out
}

/**
 * Validate the option indexes a person is voting for. Single-choice polls take
 * exactly one; multiple takes one or more. Returns the cleaned unique list or
 * a message. Pure.
 */
export function validateVote(
  picks: unknown,
  optionCount: number,
  multiple: boolean
): { ok: true; picks: number[] } | { ok: false; error: string } {
  if (!Array.isArray(picks)) return { ok: false, error: 'options must be a list' }
  const uniq = [...new Set(picks.map((p) => Number(p)))]
  if (uniq.some((n) => !Number.isInteger(n) || n < 0 || n >= optionCount))
    return { ok: false, error: 'Unknown option' }
  if (uniq.length === 0) return { ok: true, picks: [] } // clearing a vote
  if (!multiple && uniq.length > 1) return { ok: false, error: 'This poll takes one answer' }
  return { ok: true, picks: uniq.sort((a, b) => a - b) }
}

/** The line posted into the room when a poll closes. Pure. */
export function pollSummaryLine(
  question: string,
  options: Array<{ label: string; count: number }>,
  totalVoters: number
): string {
  if (totalVoters === 0) return `Poll closed: "${question}" — no votes.`
  const top = Math.max(...options.map((o) => o.count))
  const winners = options.filter((o) => o.count === top)
  const tally = options.map((o) => `${o.label} ${o.count}`).join(' · ')
  const lead =
    winners.length === 1
      ? `${winners[0].label} won`
      : `Tie: ${winners.map((w) => w.label).join(', ')}`
  return `Poll closed: "${question}" — ${lead} (${tally}; ${totalVoters} ${
    totalVoters === 1 ? 'person' : 'people'
  } voted).`
}

interface PollRow {
  id: number
  message_id: number
  room: string
  question: string
  options: string
  multiple: unknown
  anonymous: unknown
  closes_at: Date | string | null
  closed_at: Date | string | null
  created_by: string | null
}

function isClosed(p: Pick<PollRow, 'closes_at' | 'closed_at'>, now = Date.now()): boolean {
  if (p.closed_at) return true
  return !!p.closes_at && new Date(String(p.closes_at)).getTime() <= now
}

/** Polls for a window of message ids, with counts and the viewer's own picks. */
export async function loadPolls(
  messageIds: number[],
  viewerId: string
): Promise<Map<number, PollView>> {
  const out = new Map<number, PollView>()
  if (!messageIds.length || !(await pollTablesExist())) return out
  const polls = (await db('nivaro_chat_polls').whereIn('message_id', messageIds)) as PollRow[]
  if (!polls.length) return out
  const votes = (await db('nivaro_chat_poll_votes as v')
    .leftJoin('nivaro_users as u', 'u.id', 'v.user')
    .whereIn(
      'v.poll_id',
      polls.map((p) => p.id)
    )
    .select('v.poll_id', 'v.option_index', 'v.user', 'u.first_name', 'u.last_name')) as Array<
    Record<string, unknown>
  >
  const me = viewerId.toUpperCase()
  for (const p of polls) {
    const labels = parseOptions(p.options)
    const mine = new Set<number>()
    const voterSet = new Set<string>()
    const counts = labels.map(() => 0)
    const names: Array<Array<{ id: string; name: string | null }>> = labels.map(() => [])
    for (const v of votes) {
      if (Number(v.poll_id) !== p.id) continue
      const idx = Number(v.option_index)
      if (idx < 0 || idx >= labels.length) continue
      const uid = String(v.user).toUpperCase()
      counts[idx]++
      voterSet.add(uid)
      if (uid === me) mine.add(idx)
      names[idx].push({
        id: uid,
        name: [v.first_name, v.last_name].filter(Boolean).join(' ') || null
      })
    }
    const anonymous = !!p.anonymous
    out.set(Number(p.message_id), {
      id: p.id,
      message_id: Number(p.message_id),
      question: p.question,
      multiple: !!p.multiple,
      anonymous,
      closes_at: p.closes_at ? new Date(String(p.closes_at)).toISOString() : null,
      closed_at: p.closed_at ? new Date(String(p.closed_at)).toISOString() : null,
      closed: isClosed(p),
      options: labels.map((label, index) => ({
        index,
        label,
        count: counts[index],
        ...(anonymous ? {} : { voters: names[index].slice(0, 30) })
      })),
      mine: [...mine].sort((a, b) => a - b),
      total_voters: voterSet.size,
      can_close: String(p.created_by ?? '').toUpperCase() === me
    })
  }
  return out
}

export interface CreatePollInput {
  room: string
  question: string
  options: unknown
  multiple?: boolean
  anonymous?: boolean
  closesAt?: string | null
  parentId?: number | null
}

/** Post a poll: the question as a message, then its poll row. */
export async function createPoll(
  app: FastifyInstance,
  actor: {
    user: User
    isAdmin?: boolean
    masqueradeAdminId?: string | null
    /** The OAuth app / API key that posted it (#2492). */
    viaApp?: string | null
    viaRef?: string | null
  },
  input: CreatePollInput
): Promise<{ message_id: number; poll_id: number }> {
  if (!(await pollTablesExist()))
    throw new ChatSendError(
      503,
      'Polls are not available yet on this database',
      'POLLS_UNAVAILABLE'
    )
  const question = String(input.question ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300)
  if (!question) throw new ChatSendError(400, 'A poll needs a question', 'POLL_QUESTION')
  const options = cleanPollOptions(input.options)
  if (options.length < MIN_POLL_OPTIONS)
    throw new ChatSendError(400, 'A poll needs at least two different options', 'POLL_OPTIONS')
  let closesAt: Date | null = null
  if (input.closesAt) {
    closesAt = new Date(input.closesAt)
    if (Number.isNaN(closesAt.getTime()) || closesAt.getTime() <= Date.now())
      throw new ChatSendError(400, 'The close time must be in the future', 'POLL_CLOSE_TIME')
  }
  // postChatMessage enforces visibility, announce-only rooms and rate limits.
  const row = await postChatMessage(
    app,
    {
      user: actor.user,
      isAdmin: actor.isAdmin,
      masqueradeAdminId: actor.masqueradeAdminId ?? null,
      viaApp: actor.viaApp ?? null,
      viaRef: actor.viaRef ?? null
    },
    { room: input.room, message: `📊 ${question}`, parentId: input.parentId ?? null }
  )
  const ins = await db('nivaro_chat_polls')
    .insert({
      message_id: row.id,
      room: row.room,
      question,
      options: JSON.stringify(options),
      multiple: !!input.multiple,
      anonymous: !!input.anonymous,
      closes_at: closesAt,
      created_by: actor.user.id
    })
    .returning('id')
  const first = Array.isArray(ins) ? ins[0] : ins
  const pollId = Number(typeof first === 'object' && first ? (first as { id: number }).id : first)
  app.io
    ?.to(tenantScopedRoom(`chat:${row.room}`))
    .emit('chat:message', { room: row.room, touch: true })
  return { message_id: row.id, poll_id: pollId }
}

/** Close a poll once (atomic claim) and post the summary line. */
export async function closePoll(app: FastifyInstance, pollId: number): Promise<boolean> {
  const claimed = await db('nivaro_chat_polls')
    .where('id', pollId)
    .whereNull('closed_at')
    .update({ closed_at: new Date() })
  // knex/mssql reports the row count of an UPDATE as a number.
  if (!Number(claimed)) return false
  const p = (await db('nivaro_chat_polls').where('id', pollId).first()) as PollRow | undefined
  if (!p) return false
  const view = (
    await loadPolls([Number(p.message_id)], '00000000-0000-0000-0000-000000000000')
  ).get(Number(p.message_id))
  if (view) {
    try {
      await postChatMessage(
        app,
        { user: null, senderId: null, senderName: 'Nivaro', system: true, skipVisibility: true },
        {
          room: p.room,
          message: pollSummaryLine(view.question, view.options, view.total_voters),
          parentId: null
        }
      )
    } catch (err) {
      app.log.warn({ err, pollId }, 'poll summary line failed')
    }
  }
  app.io?.to(tenantScopedRoom(`chat:${p.room}`)).emit('chat:message', { room: p.room, touch: true })
  return true
}

/** Close every poll whose time has passed. Cron + lazy callers. */
export async function closeDuePolls(app: FastifyInstance): Promise<number> {
  if (!(await pollTablesExist())) return 0
  const due = (await db('nivaro_chat_polls')
    .whereNull('closed_at')
    .whereNotNull('closes_at')
    .where('closes_at', '<=', new Date())
    .select('id')
    .limit(50)) as Array<{ id: number }>
  let n = 0
  for (const p of due) if (await closePoll(app, Number(p.id))) n++
  return n
}

/** Record or replace a person's votes. */
export async function castVote(
  app: FastifyInstance,
  user: User,
  pollId: number,
  picks: unknown
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  if (!(await pollTablesExist())) return { ok: false, status: 503, error: 'Polls unavailable' }
  const p = (await db('nivaro_chat_polls').where('id', pollId).first()) as PollRow | undefined
  if (!p) return { ok: false, status: 404, error: 'Not found' }
  if (!(await canSeeRoom(user, p.room))) return { ok: false, status: 403, error: 'Forbidden' }
  if (isClosed(p)) {
    await closePoll(app, p.id).catch(() => false)
    return { ok: false, status: 409, error: 'This poll is closed' }
  }
  const v = validateVote(picks, parseOptions(p.options).length, !!p.multiple)
  if (!v.ok) return { ok: false, status: 400, error: v.error }
  await db.transaction(async (trx) => {
    await trx('nivaro_chat_poll_votes').where({ poll_id: p.id, user: user.id }).del()
    if (v.picks.length)
      await trx('nivaro_chat_poll_votes').insert(
        v.picks.map((option_index) => ({ poll_id: p.id, option_index, user: user.id }))
      )
  })
  app.io?.to(tenantScopedRoom(`chat:${p.room}`)).emit('chat:message', { room: p.room, touch: true })
  return { ok: true }
}
