import { db } from '../db/index.js'
import type { User } from '../types.js'
import { currentTenantKey } from './tenant-rooms.js'
import { applyDirectoryListingRules } from './user-directory-cols.js'

/**
 * "Seen by Beth, Mark" under a record's comments (realtime round 7, item 15).
 *
 * A comment counts as seen by someone once they opened the record after it was written
 * (nivaro_record_views.last_viewed_at — the watermark behind mention read receipts #2117,
 * the unseen dots and "opened by the owner"), or, for the people it mentions, read the
 * mention's notification (mention-receipts.ts). No new table and no new tracking.
 *
 * Rules:
 * - Only people who may open THIS record are named (role read, row filter, User Scopes —
 *   judged as each of them), and on a field comment only people who may also read that
 *   field: a reader never learns that someone outside the record's audience looked at it.
 * - A View-as open never counts: /touch leaves the person's watermark alone under View-as,
 *   and a notification marked read in a View-as tab gets no read_at.
 * - People the directory does not list (machine, placeholder, suspended or redacted
 *   accounts) are never named.
 * - The comment's author and the reader themselves are left out.
 *
 * Cost per comments read: one record_views read (the most recent viewers only), one users
 * read inside it, and an access verdict per viewer cached for a minute.
 */

/** At most this many recent viewers are considered per record. */
export const SEEN_BY_MAX_VIEWERS = 40
/** How long an access verdict (may this person open the record / which fields) is reused. */
const VERDICT_TTL_MS = 60_000
const VERDICT_MAX = 5000

export interface SeenPerson {
  id: string
  name: string
  seen_at: string
}

export interface RecordViewer {
  id: string
  name: string
  /** Their latest open of the record (the watermark). */
  viewedAt: Date
}

export interface SeenComment {
  id: string
  user: string | null
  created_at: Date | string
  field?: string | null
}

/** Who may read the record, and per field which of them may read it. */
export interface ReaderVerdicts {
  record: Set<string>
  /** Upper-cased user id → allowed read fields (null = every field). */
  fields: Map<string, string[] | null>
}

const up = (v: unknown) => String(v ?? '').toUpperCase()

/** May this verdict's person read `field`? (pure) */
export function mayReadField(allowed: string[] | null | undefined, field: string): boolean {
  if (allowed === undefined) return false
  if (allowed === null) return true
  return allowed.includes('*') || allowed.includes(field)
}

/**
 * The people who have seen one comment (pure): viewers whose latest open is at or after the
 * comment, plus mentioned people whose receipt says so, minus the author, the reader and anyone
 * the verdicts do not let read the record (or the field). Newest seen first.
 */
export function seenByForComment(
  comment: SeenComment,
  viewers: RecordViewer[],
  verdicts: ReaderVerdicts,
  readerId: string,
  mentionSeen?: Map<string, { name: string; at: string }>
): SeenPerson[] {
  const at = new Date(comment.created_at).getTime()
  const author = up(comment.user)
  const reader = up(readerId)
  const out = new Map<string, SeenPerson>()
  const allowed = (id: string) => {
    if (!verdicts.record.has(id)) return false
    if (!comment.field) return true
    return mayReadField(verdicts.fields.get(id), comment.field)
  }
  for (const v of viewers) {
    const id = up(v.id)
    if (id === author || id === reader) continue
    if (v.viewedAt.getTime() < at) continue
    if (!allowed(id)) continue
    out.set(id, { id: v.id, name: v.name, seen_at: v.viewedAt.toISOString() })
  }
  for (const [uid, m] of mentionSeen ?? []) {
    const id = up(uid)
    if (id === author || id === reader || out.has(id)) continue
    if (!allowed(id)) continue
    out.set(id, { id: uid, name: m.name, seen_at: m.at })
  }
  return [...out.values()].sort((a, b) => b.seen_at.localeCompare(a.seen_at))
}

/** The record's most recent viewers since `since` that the directory lists, newest first. */
export async function recordViewersSince(
  collection: string,
  item: string,
  since: Date
): Promise<Array<RecordViewer & { user: User }>> {
  const rows = (await db('nivaro_record_views as v')
    .join(
      applyDirectoryListingRules(
        db('nivaro_users').select(
          'id',
          'first_name',
          'last_name',
          'email',
          'role',
          'status',
          'account_kind',
          'is_redacted'
        )
      ).as('u'),
      'u.id',
      'v.user'
    )
    .where({ 'v.collection': collection, 'v.item_id': String(item) })
    .where('v.last_viewed_at', '>=', since)
    .orderBy('v.last_viewed_at', 'desc')
    .limit(SEEN_BY_MAX_VIEWERS)
    .select(
      'v.user',
      'v.last_viewed_at',
      'u.first_name',
      'u.last_name',
      'u.email',
      'u.role',
      'u.status'
    )) as Array<{
    user: string
    last_viewed_at: Date
    first_name: string | null
    last_name: string | null
    email: string | null
    role: string | null
    status: string | null
  }>
  return rows.map((r) => ({
    id: String(r.user),
    name: [r.first_name, r.last_name].filter(Boolean).join(' ').trim() || r.email || 'Someone',
    viewedAt: new Date(r.last_viewed_at),
    user: {
      id: String(r.user),
      email: r.email ?? '',
      first_name: r.first_name,
      last_name: r.last_name,
      role: r.role,
      status: r.status
    } as unknown as User
  }))
}

interface Verdict {
  at: number
  record: boolean
  /** Allowed read fields for a non-admin (null = all); only meaningful when `fieldsJudged`. */
  allowed: string[] | null
  fieldsJudged: boolean
}
const verdicts = new Map<string, Verdict>()

/** Test seam: forget cached verdicts. */
export function clearSeenVerdicts(): void {
  verdicts.clear()
}

/**
 * Judge each person AS THEMSELVES: may they open this record, and which fields may they read?
 * Cached a minute per tenant + record + person. A person whose access cannot be judged is
 * left out.
 */
export async function readerVerdicts(
  users: User[],
  collection: string,
  item: string,
  needFields: boolean
): Promise<ReaderVerdicts> {
  const out: ReaderVerdicts = { record: new Set(), fields: new Map() }
  if (users.length === 0) return out
  const [{ canSeeRecordRoom }, { getAllowedFields, isAdminRole }] = await Promise.all([
    import('./socket-access.js'),
    import('./permissions.js')
  ])
  const tenant = currentTenantKey()
  const now = Date.now()
  for (const u of users) {
    const id = up(u.id)
    const key = `${tenant}|${collection}|${item}|${id}`
    let v = verdicts.get(key)
    if (!v || now - v.at > VERDICT_TTL_MS || (needFields && v.record && !v.fieldsJudged)) {
      try {
        const admin = await isAdminRole(u)
        const record = await canSeeRecordRoom(u, collection, item, admin)
        let allowed: string[] | null = null
        if (record && needFields && !admin) allowed = await getAllowedFields(u, 'read', collection)
        v = { at: now, record, allowed, fieldsJudged: needFields || admin }
      } catch {
        v = { at: now, record: false, allowed: [], fieldsJudged: true }
      }
      if (verdicts.size >= VERDICT_MAX) verdicts.clear()
      verdicts.set(key, v)
    }
    if (v.record) {
      out.record.add(id)
      // A verdict judged without fields names no field (a field comment then names nobody).
      out.fields.set(id, v.fieldsJudged ? v.allowed : [])
    }
  }
  return out
}

/**
 * `comment id` → the people who have seen it, for one record's comments as `readerId` reads
 * them. `mentionReceipts` (comment|USER → ISO) and the mention names come from the caller's
 * existing mention read; an error leaves every comment without a line (decoration only).
 */
export async function commentSeenBy(
  collection: string,
  item: string,
  comments: SeenComment[],
  readerId: string,
  mentions: Array<{ comment: string; user: string; name: string; seen_at: string | null }> = []
): Promise<Map<string, SeenPerson[]>> {
  const out = new Map<string, SeenPerson[]>()
  const live = comments.filter((c) => c.created_at)
  if (live.length === 0) return out
  try {
    const earliest = new Date(
      Math.min(...live.map((c) => new Date(c.created_at).getTime()).filter(Number.isFinite))
    )
    const viewers = await recordViewersSince(collection, String(item), earliest)
    const mentionUsers = new Map<string, User>()
    const mentionSeenBy = new Map<string, Map<string, { name: string; at: string }>>()
    for (const m of mentions) {
      if (!m.seen_at) continue
      const list = mentionSeenBy.get(m.comment) ?? new Map()
      list.set(m.user, { name: m.name, at: m.seen_at })
      mentionSeenBy.set(m.comment, list)
      mentionUsers.set(up(m.user), { id: m.user } as unknown as User)
    }
    // Mentioned people who did not open the record lately still need a verdict: read their
    // rows (directory rules apply) so they are judged like the viewers.
    const missing = [...mentionUsers.keys()].filter((id) => !viewers.some((v) => up(v.id) === id))
    const extra = missing.length
      ? ((await applyDirectoryListingRules(db('nivaro_users'))
          .whereIn('id', missing.slice(0, SEEN_BY_MAX_VIEWERS))
          .select('id', 'email', 'first_name', 'last_name', 'role', 'status')) as User[])
      : []
    const needFields = live.some((c) => !!c.field)
    const judged = await readerVerdicts(
      [...viewers.map((v) => v.user), ...extra],
      collection,
      String(item),
      needFields
    )
    for (const c of live) {
      const people = seenByForComment(c, viewers, judged, readerId, mentionSeenBy.get(c.id))
      if (people.length) out.set(c.id, people)
    }
  } catch {
    /* "seen by" is decoration — the thread still loads without it */
  }
  return out
}

/**
 * Did this open make a comment someone else wrote newly seen? (pure) True when any comment
 * not by the opener was written after their previous open (or they never opened it before).
 */
export function openRevealsComments(
  comments: Array<{ user: string | null; created_at: Date | string }>,
  openerId: string,
  previouslyViewedAt: Date | string | null
): boolean {
  const prev = previouslyViewedAt ? new Date(previouslyViewedAt).getTime() : null
  const me = up(openerId)
  return comments.some(
    (c) =>
      up(c.user) !== me && (prev == null || new Date(c.created_at).getTime() > (prev as number))
  )
}
