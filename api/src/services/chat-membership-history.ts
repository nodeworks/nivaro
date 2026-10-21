import { db } from '../db/index.js'

/**
 * Channel membership history (#2784): who joined, left, was added or removed,
 * and by whom. Read from the activity rows the channel routes already write
 * (`chat-channel-join` / `-leave` / `-member-add` / `-member-remove`); the
 * subject of an add or remove rides at the front of the comment as a user id,
 * the actor is the activity's user. Names only — never message text.
 */

export type MembershipEventKind =
  | 'joined'
  | 'left'
  | 'added'
  | 'removed'
  | 'auto_joined'
  | 'bulk_added'

export interface MembershipEvent {
  id: number
  at: string
  kind: MembershipEventKind
  channel: string
  user_id: string | null
  user_name: string | null
  by_id: string | null
  by_name: string | null
  /** bulk_added only: how many people a team / role brought in. */
  count?: number
  note?: string | null
}

const ACTIONS = [
  'chat-channel-join',
  'chat-channel-leave',
  'chat-channel-member-add',
  'chat-channel-member-remove'
]
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const SUBJECT_RE = new RegExp(`^(${UUID}) (added to|removed from|joined) #([^ ]+)(?: (.+))?$`, 'i')
const BULK_RE = /^(\d+) added from (.+?) to #/

/** Turn one activity row into an event (null for rows that are not membership changes). */
export function toMembershipEvent(r: {
  id: number
  action: string
  comment: string | null
  timestamp: Date | string
  user: string | null
  item: string
}): Omit<MembershipEvent, 'user_name' | 'by_name'> | null {
  const comment = String(r.comment ?? '')
  const base = {
    id: Number(r.id),
    at: new Date(r.timestamp).toISOString(),
    channel: String(r.item)
  }
  const actor = r.user ? String(r.user) : null
  if (r.action === 'chat-channel-join')
    return { ...base, kind: 'joined', user_id: actor, by_id: actor }
  if (r.action === 'chat-channel-leave')
    return { ...base, kind: 'left', user_id: actor, by_id: actor }
  const subject = SUBJECT_RE.exec(comment)
  if (r.action === 'chat-channel-member-add') {
    if (subject) {
      const note = subject[4] ?? null
      if (!actor && /default role/i.test(note ?? ''))
        return { ...base, kind: 'auto_joined', user_id: subject[1], by_id: null, note }
      return { ...base, kind: 'added', user_id: subject[1], by_id: actor, note }
    }
    const bulk = BULK_RE.exec(comment)
    if (bulk)
      return {
        ...base,
        kind: 'bulk_added',
        user_id: null,
        by_id: actor,
        count: Number(bulk[1]),
        note: bulk[2]
      }
    return null
  }
  if (r.action === 'chat-channel-member-remove' && subject)
    return { ...base, kind: 'removed', user_id: subject[1], by_id: actor }
  return null
}

/**
 * The activity `item` values a channel's membership rows are written under:
 * always the channel key (join/leave use the room key, add/remove the audit
 * item). Never the numeric id — a channel keyed "42" would otherwise leak into
 * the history of the channel whose id is 42.
 */
export function historyItemsFor(ch: { key: string }): string[] {
  return [ch.key]
}

export async function loadMembershipHistory(opts: {
  /** Channel keys (the activity `item`). Omit for every channel (admin analytics). */
  items?: string[]
  days?: number
  limit?: number
}): Promise<MembershipEvent[]> {
  const q = db('nivaro_activity')
    .where('collection', 'nivaro_chat_channels')
    .whereIn('action', ACTIONS)
    .orderBy('timestamp', 'desc')
    .limit(Math.min(opts.limit ?? 100, 500))
    .select('id', 'action', 'comment', 'timestamp', 'user', 'item')
  if (opts.items) q.whereIn('item', opts.items)
  if (opts.days) q.where('timestamp', '>=', new Date(Date.now() - opts.days * 86_400_000))
  const rows = (await q) as Array<{
    id: number
    action: string
    comment: string | null
    timestamp: Date | string
    user: string | null
    item: string
  }>
  const events = rows
    .map(toMembershipEvent)
    .filter((e): e is NonNullable<ReturnType<typeof toMembershipEvent>> => !!e)
  const ids = [
    ...new Set(events.flatMap((e) => [e.user_id, e.by_id]).filter((x): x is string => !!x))
  ]
  const names = new Map<string, string>()
  for (let i = 0; i < ids.length; i += 500) {
    const users = (await db('nivaro_users')
      .whereIn('id', ids.slice(i, i + 500))
      .select('id', 'first_name', 'last_name', 'email')) as Array<Record<string, string | null>>
    for (const u of users)
      names.set(
        String(u.id).toUpperCase(),
        [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email || 'Someone'
      )
  }
  const nameOf = (id: string | null) => (id ? (names.get(id.toUpperCase()) ?? null) : null)
  return events.map((e) => ({ ...e, user_name: nameOf(e.user_id), by_name: nameOf(e.by_id) }))
}
