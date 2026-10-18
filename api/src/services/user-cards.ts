import { createHash } from 'node:crypto'
import { db } from '../db/index.js'

/**
 * The contact card a person chip shows (name, title, role, manager, photo).
 * ONE reader for `GET /users/:id/card` and the batched `POST /users/cards`, so
 * the two can never answer differently for the same person: same columns,
 * same joins, same redaction.
 *
 * A redacted account's photo is never served (the avatar route already
 * refused it; the card used to carry it anyway).
 */

/** The most ids one `POST /users/cards` takes. */
export const USER_CARD_BATCH_MAX = 100

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** User ids are uniqueidentifiers: anything else can match nobody (and would make MSSQL throw). */
export function isUserId(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v)
}

export type UserCardRow = Record<string, unknown> & { id: string }

/** Cards for `ids` (unknown / malformed ids are simply absent). Order is not guaranteed. */
export async function readUserCards(ids: readonly string[]): Promise<UserCardRow[]> {
  const seen = new Set<string>()
  const wanted: string[] = []
  for (const id of ids) {
    if (!isUserId(id)) continue
    const k = id.toUpperCase()
    if (seen.has(k)) continue
    seen.add(k)
    wanted.push(id)
  }
  if (wanted.length === 0) return []
  const rows = (await db('nivaro_users as u')
    .leftJoin('nivaro_roles as r', 'u.role', 'r.id')
    .leftJoin('nivaro_users as m', 'u.manager_id', 'm.id')
    .whereIn('u.id', wanted)
    .select(
      'u.id',
      'u.first_name',
      'u.last_name',
      'u.email',
      'u.title',
      'u.phone',
      'u.department',
      'u.company',
      'u.avatar',
      'u.status',
      'u.last_access',
      'u.is_out_of_office',
      'r.name as role_name',
      db.raw(`CONCAT(m.first_name, ' ', m.last_name) as manager_name`),
      'u.manager_id',
      'u.is_redacted'
    )) as Array<Record<string, unknown>>
  return rows.map((row) => {
    const { is_redacted, ...card } = row
    if (is_redacted) card.avatar = null
    return card as UserCardRow
  })
}

/** Weak validator for an avatar body: changes whenever the stored data URI does. */
export function avatarEtag(avatar: string | null): string {
  if (!avatar) return 'W/"a0"'
  return `W/"a${createHash('sha1').update(avatar).digest('base64url').slice(0, 16)}"`
}
