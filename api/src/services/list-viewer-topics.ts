/**
 * "Beth and 2 others are viewing this list" — for ADMINISTRATORS ONLY (Rob's rule).
 *
 * A list (`list-view:<collection>`) or queue worklist (`queue-view:<id>`) page sends the
 * ordinary `ops:join {topic}` while it is open. The topic's gate is 'viewers' (ops-live.ts):
 *
 *   announce   anyone who may read that list is added to the topic's viewer list
 *              (presence-topics.ts — per process, other processes via the realtime board).
 *   listen     only administrators JOIN the socket room, so the `ops:changed {topic, viewers}`
 *              broadcast reaches administrators and nobody else. A non-administrator's socket
 *              is never in the room: their payloads carry nothing.
 *
 * A View-as socket (signed in with an nvm_ token) never announces: the admin behind it is
 * not shown, and the person they are viewing as is not really there either. It may still
 * listen when the person viewed as is an administrator — that is exactly their view.
 *
 * Names only (id + display name) — never which rows, filters or values anyone is looking at.
 */

export type ListViewKind = 'list' | 'queue'

const TOPIC = /^(list-view|queue-view):([A-Za-z0-9_-]{1,64})$/
const COLLECTION = /^[A-Za-z][A-Za-z0-9_]{0,63}$/

/** The list a viewer topic names, or null when the string is not one. */
export function parseListViewTopic(raw: unknown): { kind: ListViewKind; id: string } | null {
  if (typeof raw !== 'string') return null
  const m = TOPIC.exec(raw)
  if (!m) return null
  if (m[1] === 'list-view') {
    // System tables have their own pages (and no list viewers).
    if (!COLLECTION.test(m[2]) || /^(nivaro|directus)_/i.test(m[2])) return null
    return { kind: 'list', id: m[2] }
  }
  return { kind: 'queue', id: m[2] }
}

export function isListViewTopic(raw: unknown): boolean {
  return parseListViewTopic(raw) != null
}

/** What one socket does on `ops:join` of a viewer topic. */
export function listViewerJoinPlan(input: {
  isAdmin: boolean
  /** Signed in with a View-as (nvm_) token. */
  viewAs: boolean
  /** May this person read the list at all (read access / queue visibility)? */
  mayRead: boolean
}): { listen: boolean; announce: boolean } {
  return {
    listen: input.isAdmin,
    announce: !input.viewAs && input.mayRead
  }
}
