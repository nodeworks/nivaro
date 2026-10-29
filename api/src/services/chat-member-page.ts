import type { Knex } from 'knex'
import { db as defaultDb } from '../db/index.js'

/**
 * #3082 — one page of a room's members for very large rooms. Online first
 * (the Online tab's rule: heartbeat within 70 s and not idle-off), then by
 * name; searchable by name, @handle (the email local part) or email local
 * part. Everything is bound, nothing scales with the room's size except the
 * count. The caller has already passed canSeeRoom.
 */

export const MEMBER_PAGE_DEFAULT = 50
export const MEMBER_PAGE_MAX = 200
const ONLINE_WINDOW_MS = 70_000

export interface MemberPageRow {
  user: string
  first_name: string | null
  last_name: string | null
  email: string | null
  title: string | null
  joined_at: unknown
  name: string
  online: boolean
}

export interface MemberPage {
  rows: MemberPageRow[]
  total: number
  has_more: boolean
  online_total: number
}

export function parseLimit(v: unknown): number {
  const n = Math.floor(Number(v))
  if (!Number.isFinite(n) || n < 1) return MEMBER_PAGE_DEFAULT
  return Math.min(n, MEMBER_PAGE_MAX)
}

export function parseOffset(v: unknown): number {
  const n = Math.floor(Number(v))
  return Number.isFinite(n) && n > 0 ? n : 0
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_[]/g, (c) => `\\${c}`)
}

/** True when the request asks for paging (otherwise the old full list is returned). */
export function wantsPaging(query: Record<string, unknown>): boolean {
  return query.limit !== undefined || query.offset !== undefined || query.q !== undefined
}

export async function pageRoomMembers(
  room: string,
  opts: { q?: string; limit?: number; offset?: number },
  knex: Knex = defaultDb as unknown as Knex
): Promise<MemberPage> {
  const limit = Math.min(Math.max(opts.limit ?? MEMBER_PAGE_DEFAULT, 1), MEMBER_PAGE_MAX)
  const offset = Math.max(opts.offset ?? 0, 0)
  const q = (opts.q ?? '').trim().replace(/^@/, '').slice(0, 100)
  const since = new Date(Date.now() - ONLINE_WINDOW_MS)

  const base = () => {
    const b = knex('nivaro_chat_memberships as m')
      .join('nivaro_users as u', 'u.id', 'm.user')
      .where('m.room', room)
      .andWhere((s) => s.whereNull('u.status').orWhereNot('u.status', 'suspended'))
    if (q) {
      const lq = escapeLike(q.toLowerCase())
      b.andWhere((s) => {
        s.whereRaw("LOWER(CONCAT(u.first_name, ' ', u.last_name)) LIKE ? ESCAPE '\\'", [`%${lq}%`])
          .orWhereRaw("LOWER(u.first_name) LIKE ? ESCAPE '\\'", [`${lq}%`])
          .orWhereRaw("LOWER(u.last_name) LIKE ? ESCAPE '\\'", [`${lq}%`])
          .orWhereRaw("LOWER(u.email) LIKE ? ESCAPE '\\'", [`${lq}%`])
      })
    }
    return b
  }
  const onlineSql =
    'CASE WHEN p.last_seen >= ? AND (p.is_online IS NULL OR p.is_online <> 0) THEN 1 ELSE 0 END'

  const totalRow = (await base().count({ n: 'u.id' }).first()) as
    | { n?: number | string }
    | undefined
  const total = Number(totalRow?.n ?? 0)

  let raw: Array<Record<string, unknown>>
  let onlineTotal = 0
  try {
    raw = (await base()
      .leftJoin('user_presence as p', 'p.user_id', 'u.id')
      .select(
        'm.user',
        'u.first_name',
        'u.last_name',
        'u.email',
        'u.title',
        'm.joined_at',
        knex.raw(`${onlineSql} as online`, [since])
      )
      .orderByRaw(`${onlineSql} DESC`, [since])
      .orderBy('u.first_name', 'asc')
      .orderBy('u.last_name', 'asc')
      .orderBy('m.user', 'asc')
      .limit(limit)
      .offset(offset)) as Array<Record<string, unknown>>
    const on = (await base()
      .join('user_presence as p', 'p.user_id', 'u.id')
      .where('p.last_seen', '>=', since)
      .andWhere((s) => s.whereNull('p.is_online').orWhere('p.is_online', true))
      .count({ n: 'u.id' })
      .first()) as { n?: number | string } | undefined
    onlineTotal = Number(on?.n ?? 0)
  } catch {
    // No presence table (fresh install): everyone offline, still by name.
    raw = (await base()
      .select('m.user', 'u.first_name', 'u.last_name', 'u.email', 'u.title', 'm.joined_at')
      .orderBy('u.first_name', 'asc')
      .orderBy('u.last_name', 'asc')
      .orderBy('m.user', 'asc')
      .limit(limit)
      .offset(offset)) as Array<Record<string, unknown>>
  }

  const rows: MemberPageRow[] = raw.map((r) => ({
    user: String(r.user),
    first_name: (r.first_name as string | null) ?? null,
    last_name: (r.last_name as string | null) ?? null,
    email: (r.email as string | null) ?? null,
    title: (r.title as string | null) ?? null,
    joined_at: r.joined_at ?? null,
    name: [r.first_name, r.last_name].filter(Boolean).join(' ') || String(r.email ?? r.user ?? ''),
    online: Number(r.online) === 1
  }))
  return { rows, total, has_more: offset + rows.length < total, online_total: onlineTotal }
}
