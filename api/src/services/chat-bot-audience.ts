import { db } from '../db/index.js'
import type { User } from '../types.js'
import { REPLAYABLE_TOOLS } from './ai-conversations.js'
import { hashToolResult } from './ai-result-hash.js'
import type { RoomRecord } from './chat-records.js'

/**
 * Who may read what the assistant posts in a room (#1852, #1810).
 *
 * The assistant's tools run AS THE ASKER, but its reply lands in a room other
 * people read. So before a word of the answer reaches the room — streamed or
 * posted — every tool call behind it is checked against the room's audience:
 *
 *   people  everyone else who can open the room is known and few (a DM, a
 *           private channel, a small role channel): each call is replayed AS
 *           EACH OF THEM and must come back with the asker's exact result
 *           fingerprint (the shared-conversation rule, #1809).
 *   open    the audience is everyone, or everyone who can read a record — too
 *           many to replay. Only a read of the room's OWN row passes — a
 *           query_items pinned to it with link labels off (a label is ANOTHER
 *           record, under its own row rules), or its integration_status /
 *           record_integrity — and only when it replays identically for one
 *           member of every role that can read the collection (field access
 *           is per role; the row itself is the record every room reader can
 *           see by definition). Nothing about other records (record_event_path
 *           walks events, writes and partner calls) is sound to sample.
 *
 * Anything else — a call outside REPLAYABLE_TOOLS, an error, a mismatch, a
 * blown budget — sends the answer to the asker alone. The prompt context the
 * room already shows (its messages, the channel's description and pins, the
 * record's state/SLA/owners from the room header) needs no check.
 */

/** Room readers we are willing to replay for; more = the open rule. */
export const AUDIENCE_CAP = 20
/** Tool replays one answer may spend deciding its audience. */
export const REPLAY_BUDGET = 48
/** What an open room may be told: reads of the room's own row only. */
const OPEN_ROOM_TOOLS = new Set(['query_items', 'integration_status', 'record_integrity'])
/** Members of one role tried before a role counts as unverifiable. */
const REPS_PER_ROLE = 5

export type RoomAudience = { kind: 'people'; ids: string[] } | { kind: 'open' }

export type Verdict = 'room' | 'private'

/** One tool call of the answer, as the asker ran it. */
export interface BotCall {
  tool: string
  input: Record<string, unknown>
  /** Fingerprint of what the model was shown (hashToolResult). */
  hash: string
  failed: boolean
}

/** Tools whose output is the same for anyone and about nothing in the data. */
const NEUTRAL_TOOLS = new Set(['product_help', 'set_reminder'])
/** Tools that read one record named by {collection, id}. */
export const RECORD_TOOLS = new Set([
  'record_event_path',
  'record_integrity',
  'integration_status',
  'explain_access',
  'who_can_act',
  'explain_owners'
])

const upper = (v: unknown) => String(v ?? '').toUpperCase()

// ── Audience ─────────────────────────────────────────────────────────────────

export interface AudienceDeps {
  channel(key: string): Promise<{ visibility: string; role: string | null } | null>
  members(room: string): Promise<string[]>
  roleUserCount(roleId: string): Promise<number>
  roleUsers(roleId: string, limit: number): Promise<string[]>
}

const audienceDb: AudienceDeps = {
  async channel(key) {
    const { channelByKey } = await import('./chat.js')
    const ch = await channelByKey(key)
    if (!ch || ch.is_archived) return null
    return { visibility: ch.visibility, role: ch.role ?? null }
  },
  async members(room) {
    // Fresh read — someone added a minute ago reads the reply too.
    const rows = (await db('nivaro_chat_memberships').where({ room }).select('user')) as Array<{
      user: string
    }>
    return rows.map((r) => String(r.user))
  },
  async roleUserCount(roleId) {
    const row = (await db('nivaro_users')
      .where({ role: roleId, status: 'active' })
      .count({ n: '*' })
      .first()) as { n?: number | string } | undefined
    return Number(row?.n ?? 0)
  },
  async roleUsers(roleId, limit) {
    const rows = (await db('nivaro_users')
      .where({ role: roleId, status: 'active' })
      .limit(limit)
      .select('id')) as Array<{ id: string }>
    return rows.map((r) => String(r.id))
  }
}

/**
 * Everyone other than the asker (and the assistant) who can read `room`, or
 * `open` when that is everyone / unknowable / more than AUDIENCE_CAP.
 */
export async function roomAudience(
  room: string,
  askerId: string,
  botId: string | null,
  deps: AudienceDeps = audienceDb
): Promise<RoomAudience> {
  const { parseRoom } = await import('./chat.js')
  const parsed = parseRoom(room)
  const skip = new Set([upper(askerId), upper(botId)])
  const people = (ids: string[]): RoomAudience => {
    const uniq = [...new Set(ids.map(upper))].filter((id) => id && !skip.has(id))
    return uniq.length > AUDIENCE_CAP ? { kind: 'open' } : { kind: 'people', ids: uniq }
  }
  if (parsed.kind === 'dm') return people(parsed.participants ?? [])
  if (parsed.kind !== 'channel' || !parsed.channelKey) return { kind: 'open' }
  const ch = await deps.channel(parsed.channelKey)
  if (!ch || ch.visibility === 'open') return { kind: 'open' }
  const members = await deps.members(room)
  if (ch.visibility === 'private') return people(members)
  if (ch.visibility === 'role' && ch.role) {
    if ((await deps.roleUserCount(ch.role)) > AUDIENCE_CAP) return { kind: 'open' }
    return people([...members, ...(await deps.roleUsers(ch.role, AUDIENCE_CAP + 1))])
  }
  return { kind: 'open' }
}

// ── Record scoping (#1852) ───────────────────────────────────────────────────

/** The record's id or its room token, as the model might name it. */
function namesRecord(v: unknown, rec: RoomRecord): boolean {
  if (v == null || typeof v === 'object') return false
  const s = String(v).trim().toLowerCase()
  return s === rec.id.toLowerCase() || s === rec.token.toLowerCase()
}

const THIS_WORDS = new Set(['', 'this', 'it', 'this record', 'current', 'here'])

/**
 * In a record's room the record is the default subject: a record tool called
 * without a collection, or with "this" / the room token as its id, is pointed
 * at the record. Returns a new input; never widens a call to another record.
 */
export function scopeToRecord(
  tool: string,
  input: Record<string, unknown>,
  rec: RoomRecord | null
): Record<string, unknown> {
  if (!rec) return input
  const out = { ...input }
  const col = String(out.collection ?? '')
    .trim()
    .toLowerCase()
  if (RECORD_TOOLS.has(tool)) {
    if (THIS_WORDS.has(col)) out.collection = rec.collection
    if (out.collection === rec.collection) {
      const id = String(out.id ?? '')
        .trim()
        .toLowerCase()
      if (THIS_WORDS.has(id) || namesRecord(out.id, rec)) out.id = rec.id
    }
    return out
  }
  if (tool === 'query_items' && THIS_WORDS.has(col)) {
    out.collection = rec.collection
    if (out.filter == null && !out.search) out.filter = { id: { _eq: rec.id } }
  }
  return out
}

/** `{id: {_eq: X}}` / `{<match_field>: X}` naming the record, optionally in a one-item `_and`. */
function pinnedToRecord(filter: unknown, rec: RoomRecord): boolean {
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)) return false
  const keys = Object.keys(filter)
  if (keys.length !== 1) return false
  const key = keys[0]
  const v = (filter as Record<string, unknown>)[key]
  if (key === '_and') return Array.isArray(v) && v.length === 1 && pinnedToRecord(v[0], rec)
  if (key !== 'id' && key !== rec.match_field) return false
  const target =
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.keys(v).length === 1
        ? (v as Record<string, unknown>)._eq
        : undefined
      : v
  if (target == null) return false
  return key === 'id'
    ? String(target).toLowerCase() === rec.id.toLowerCase()
    : String(target).toLowerCase() === rec.token.toLowerCase()
}

/**
 * Does this call read only the room's own record? query_items must name the
 * record's collection, pin its filter to the record, search nothing and read
 * no dotted path (a hop reads ANOTHER record, under its own row rules).
 */
export function isRecordScopedCall(call: BotCall, rec: RoomRecord | null): boolean {
  if (!rec) return false
  const input = call.input ?? {}
  if (input.collection !== rec.collection) return false
  if (RECORD_TOOLS.has(call.tool)) return String(input.id ?? '') === rec.id
  if (call.tool !== 'query_items') return false
  if (input.search) return false
  if (!pinnedToRecord(input.filter, rec)) return false
  const fields = Array.isArray(input.fields) ? input.fields : []
  return fields.every((f) => typeof f === 'string' && !f.includes('.'))
}

// ── Verifying calls ──────────────────────────────────────────────────────────

export interface VerifyDeps {
  loadUsers(ids: string[]): Promise<User[]>
  replay(user: User, tool: string, input: Record<string, unknown>): Promise<unknown>
  canSeeRoom(user: User, room: string): Promise<boolean>
  /** Roles with at least one active member that may read `collection`. */
  rolesReading(collection: string): Promise<string[]>
  /** Active members of a role, the given (room-related) ids first. */
  roleMembers(roleId: string, prefer: string[], limit: number): Promise<User[]>
}

const verifyDb: VerifyDeps = {
  async loadUsers(ids) {
    if (!ids.length) return []
    return (await db('nivaro_users').whereIn('id', ids.slice(0, AUDIENCE_CAP + 2))) as User[]
  },
  async replay(user, tool, input) {
    const { executeChatTool } = await import('./ai-chat.js')
    return (await executeChatTool(user, tool, input)).result
  },
  async canSeeRoom(user, room) {
    const { canSeeRoom } = await import('./chat.js')
    return canSeeRoom(user, room).catch(() => false)
  },
  async rolesReading(collection) {
    const rows = (await db('nivaro_roles as r')
      .whereExists((q) =>
        q
          .select(db.raw('1'))
          .from('nivaro_users as u')
          .whereRaw('u.role = r.id')
          .where('u.status', 'active')
      )
      .where((w) =>
        w
          .where('r.admin_access', true)
          .orWhereExists((q) =>
            q
              .select(db.raw('1'))
              .from('nivaro_policies as p')
              .whereRaw('p.role = r.id')
              .where('p.action', 'read')
              .whereIn('p.collection', [collection, '*'])
          )
      )
      .select('r.id')) as Array<{ id: string }>
    return rows.map((r) => String(r.id))
  },
  async roleMembers(roleId, prefer, limit) {
    const out: User[] = []
    const seen = new Set<string>()
    const take = (rows: User[]) => {
      for (const u of rows) {
        const k = upper(u.id)
        if (seen.has(k) || out.length >= limit) continue
        seen.add(k)
        out.push(u)
      }
    }
    if (prefer.length) {
      take(
        (await db('nivaro_users')
          .whereIn('id', prefer.slice(0, 200))
          .where({ role: roleId, status: 'active' })
          .limit(limit)) as User[]
      )
    }
    if (out.length < limit) {
      take(
        (await db('nivaro_users')
          .where({ role: roleId, status: 'active' })
          .orderBy('last_access', 'desc')
          .limit(limit + out.length)) as User[]
      )
    }
    return out
  }
}

export interface VerifyContext {
  room: string
  audience: RoomAudience
  /** The room's record as the asker read it (entity rooms), else null. */
  record: RoomRecord | null
  /** Ops tools ran in an admin-only room (every reader an administrator). */
  opsRoom: boolean
  /** People tied to the room (members, posters) — preferred role representatives. */
  roomPeople: string[]
  budget: { left: number }
}

async function sameForEveryone(
  call: BotCall,
  users: User[],
  ctx: VerifyContext,
  deps: VerifyDeps
): Promise<boolean> {
  for (const u of users) {
    if (ctx.budget.left <= 0) return false
    ctx.budget.left--
    try {
      if (hashToolResult(await deps.replay(u, call.tool, call.input)) !== call.hash) return false
    } catch {
      return false
    }
  }
  return true
}

/**
 * May the room read an answer built on this call? Pure over `deps`; spends
 * from `ctx.budget`. A people audience must be replayed in full; an open one
 * only ever passes a read of the room's own record.
 */
export async function verifyCall(
  call: BotCall,
  ctx: VerifyContext,
  deps: VerifyDeps = verifyDb
): Promise<Verdict> {
  if (NEUTRAL_TOOLS.has(call.tool)) return 'room'
  if (call.tool === 'ops_status' || call.tool === 'propose_ops_action')
    return ctx.opsRoom ? 'room' : 'private'
  // Tools that describe someone's own access or lists (explain_access,
  // my_tasks…) never replay — the shared-conversation rule (#1809).
  if (call.failed || !REPLAYABLE_TOOLS.has(call.tool)) return 'private'

  if (ctx.audience.kind === 'people') {
    if (ctx.audience.ids.length === 0) return 'room'
    if (ctx.audience.ids.length > ctx.budget.left) return 'private'
    const users = await deps.loadUsers(ctx.audience.ids)
    // A reader we cannot load is a reader we cannot vouch for.
    if (users.length < ctx.audience.ids.length) return 'private'
    return (await sameForEveryone(call, users, ctx, deps)) ? 'room' : 'private'
  }

  if (!ctx.record || !OPEN_ROOM_TOOLS.has(call.tool)) return 'private'
  if (!isRecordScopedCall(call, ctx.record)) return 'private'
  if (call.tool === 'query_items' && call.input.link_labels !== false) return 'private'
  const roles = await deps.rolesReading(ctx.record.collection)
  if (roles.length > ctx.budget.left) return 'private'
  for (const roleId of roles) {
    const candidates = await deps.roleMembers(roleId, ctx.roomPeople, REPS_PER_ROLE)
    let rep: User | null = null
    for (const c of candidates) {
      if (await deps.canSeeRoom(c, ctx.room)) {
        rep = c
        break
      }
    }
    if (!rep) {
      // Every member tried is outside the room; the role's next member may
      // not be, and we have not seen what they would read.
      if (candidates.length >= REPS_PER_ROLE) return 'private'
      continue
    }
    if (!(await sameForEveryone(call, [rep], ctx, deps))) return 'private'
  }
  return 'room'
}
