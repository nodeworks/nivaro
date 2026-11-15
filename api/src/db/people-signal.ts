/**
 * "The people directory changed" — a person was added, or a column pickers, mentions and
 * avatars show (name, title, photo, status, out of office…) was written. Raised in the process
 * that made the write, at the same driver seam as owner-signal / ops-signal, so a write from a
 * route, a cron (directory sync, scheduled out of office) or a script all count.
 *
 * It says only THAT the directory moved ('created' | 'changed'); services/people-live.ts turns
 * it into one coalesced `people:changed` notice. Never a value, never a credential. Leaf module.
 */

export type PeopleWriteKind = 'created' | 'changed'

/**
 * Columns a person's card, a picker row or an avatar shows. Credentials, preferences and
 * bookkeeping (last_access on every request, current_workspace, tokens, password hashes) are
 * deliberately absent: a write of only those is not a directory change.
 */
export const DIRECTORY_SIGNAL_COLUMNS = [
  'first_name',
  'last_name',
  'email',
  'title',
  'department',
  'company',
  'office_location',
  'status',
  'is_out_of_office',
  'ooo_start',
  'ooo_end',
  'delegate_id',
  'avatar',
  'is_redacted',
  'account_kind',
  'role',
  'manager_id'
] as const

const SET_COLUMNS_RE = new RegExp(`\\b(?:${DIRECTORY_SIGNAL_COLUMNS.join('|')})\\b`, 'i')

/** What a SQL statement does to the people directory (null: nothing). Exported for tests. */
export function peopleWriteKind(sql: string): PeopleWriteKind | null {
  if (!sql || sql.length < 18) return null
  const plain = sql.replace(/[[\]"]/g, '')
  if (!/\bnivaro_users\b/i.test(plain)) return null
  if (/^\s*insert\s+(?:into\s+)?nivaro_users\b/i.test(plain)) return 'created'
  if (/^\s*delete\s+(?:from\s+)?nivaro_users\b/i.test(plain)) return 'changed'
  if (/^\s*merge\s+(?:into\s+)?nivaro_users\b/i.test(plain)) return 'changed'
  if (/^\s*update\s+nivaro_users\b/i.test(plain)) {
    // Only the SET list matters: a WHERE on status is not a change to it.
    const set = /\bset\b([\s\S]*?)(?:\bwhere\b|\boutput\b|;|$)/i.exec(plain)?.[1] ?? ''
    return SET_COLUMNS_RE.test(set) ? 'changed' : null
  }
  return null
}

type Listener = (kind: PeopleWriteKind) => void
const listeners = new Set<Listener>()

export function onPeopleWrite(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function raisePeopleWrite(kind: PeopleWriteKind): void {
  for (const fn of listeners) {
    try {
      fn(kind)
    } catch {
      /* a live notice that fails must not affect the write */
    }
  }
}
