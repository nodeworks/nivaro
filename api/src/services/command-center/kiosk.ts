import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { roleAllowsSignIn } from '../../auth/role-sign-in.js'
import { db } from '../../db/index.js'
import type { Role, User } from '../../types.js'

/**
 * Command Center wallboard (kiosk) links (CC-23): a signed, expiring, revocable URL that shows
 * the board read-only on a wall screen with nobody signed in.
 *
 * No migration: a link is a `nivaro_share_links` row whose item is CC_KIOSK_ITEM (the record
 * share routes refuse that marker exactly as they refuse form previews), and its label + the
 * board it opens on (region, map collection) are one `nivaro_extension_settings` row
 * ('nivaro-core', 'cc_kiosk:<link id>').
 *
 * The token is a credential: only its SHA-256 is stored (the share-link `token` column), so the
 * URL is shown once, when the link is made. Every request through a link reads AS ITS CREATOR —
 * who must still be an active, unredacted administrator whose role may sign in: a suspended,
 * removed or demoted creator's links stop at once. An expiry is required (at most 90 days).
 */

export const CC_KIOSK_ITEM = '__cc_kiosk__'
export const CC_KIOSK_COLLECTION = 'nivaro_command_center'
export const MAX_KIOSK_DAYS = 90
const CORE_EXT = 'nivaro-core'
const META_PREFIX = 'cc_kiosk:'
const TOKEN_RE = /^[0-9a-f]{48}$/
const REGION_RE = /^[A-Za-z0-9_-]{1,64}$/
const NAME_RE = /^[A-Za-z0-9_]{1,64}$/

/** The way SQL Server compares `item` (case-insensitive, trailing spaces ignored). */
export const isKioskItem = (item: unknown) =>
  String(item ?? '')
    .trim()
    .toLowerCase() === CC_KIOSK_ITEM

export const hashKioskToken = (token: string) => createHash('sha256').update(token).digest('hex')

/** A query-string token that could be a kiosk link (shape only — resolveKiosk decides). */
export const kioskTokenShape = (v: unknown): v is string =>
  typeof v === 'string' && TOKEN_RE.test(v)

export interface KioskMeta {
  label: string
  region: string | null
  map_collection: string | null
}

export interface KioskLinkRow {
  id: string
  label: string
  region: string | null
  map_collection: string | null
  created_at: string | null
  expires_at: string | null
  expired: boolean
  created_by: string | null
  created_by_name: string | null
  view_count: number
  last_viewed_at: string | null
}

export interface KioskInput {
  label: string
  days: number
  region: string | null
  map_collection: string | null
}

const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString())

/** Validated create body, or the reason it is refused. */
export function cleanKioskInput(body: unknown): KioskInput | { error: string } {
  const b = (body ?? {}) as Record<string, unknown>
  const label = typeof b.label === 'string' ? b.label.trim() : ''
  if (!label) return { error: 'Name the screen this link is for' }
  if (label.length > 80) return { error: 'Names are limited to 80 characters' }
  const days = Number(b.expires_in_days)
  if (!Number.isInteger(days) || days < 1 || days > MAX_KIOSK_DAYS)
    return { error: `Choose how long the link works: 1 to ${MAX_KIOSK_DAYS} days` }
  const region = b.region == null || b.region === '' ? null : String(b.region)
  if (region !== null && !REGION_RE.test(region)) return { error: 'That region is not valid' }
  const map = b.map_collection == null || b.map_collection === '' ? null : String(b.map_collection)
  if (map !== null && !NAME_RE.test(map)) return { error: 'That map collection is not valid' }
  return { label, days, region, map_collection: map }
}

function parseMeta(value: unknown): KioskMeta {
  try {
    const v = JSON.parse(String(value ?? '{}')) as Record<string, unknown>
    return {
      label: typeof v.label === 'string' ? v.label : 'Wallboard',
      region: typeof v.region === 'string' && REGION_RE.test(v.region) ? v.region : null,
      map_collection:
        typeof v.map_collection === 'string' && NAME_RE.test(v.map_collection)
          ? v.map_collection
          : null
    }
  } catch {
    return { label: 'Wallboard', region: null, map_collection: null }
  }
}

async function metaFor(ids: string[]): Promise<Map<string, KioskMeta>> {
  if (ids.length === 0) return new Map()
  const rows = (await db('nivaro_extension_settings')
    .where({ extension_id: CORE_EXT })
    .whereIn(
      'key',
      ids.map((id) => `${META_PREFIX}${id}`)
    )
    .select('key', 'value')
    .catch(() => [])) as Array<{ key: string; value: string | null }>
  return new Map(
    rows.map((r) => [r.key.slice(META_PREFIX.length).toLowerCase(), parseMeta(r.value)])
  )
}

/** Make a link; returns the row and the raw token (never stored, shown once). */
export async function createKioskLink(
  input: KioskInput,
  userId: string
): Promise<{ link: KioskLinkRow; token: string }> {
  const id = randomUUID()
  const token = randomBytes(24).toString('hex')
  const now = new Date()
  const expires = new Date(now.getTime() + input.days * 86_400_000)
  await db('nivaro_share_links').insert({
    id,
    collection: CC_KIOSK_COLLECTION,
    item: CC_KIOSK_ITEM,
    token: hashKioskToken(token),
    layout_id: null,
    expires_at: expires,
    is_active: 1,
    view_count: 0,
    created_by: userId,
    created_at: now
  })
  const meta: KioskMeta = {
    label: input.label,
    region: input.region,
    map_collection: input.map_collection
  }
  await db('nivaro_extension_settings').insert({
    extension_id: CORE_EXT,
    key: `${META_PREFIX}${id}`,
    value: JSON.stringify(meta),
    updated_at: now
  })
  return {
    token,
    link: {
      id,
      ...meta,
      created_at: now.toISOString(),
      expires_at: expires.toISOString(),
      expired: false,
      created_by: userId,
      created_by_name: null,
      view_count: 0,
      last_viewed_at: null
    }
  }
}

/** Every kiosk link (administrators manage them all), newest first, revoked ones gone. */
export async function listKioskLinks(): Promise<KioskLinkRow[]> {
  const rows = (await db('nivaro_share_links as s')
    .leftJoin('nivaro_users as u', 'u.id', 's.created_by')
    .where('s.item', CC_KIOSK_ITEM)
    .where('s.is_active', 1)
    .orderBy('s.created_at', 'desc')
    .select(
      's.id',
      's.expires_at',
      's.created_at',
      's.created_by',
      's.view_count',
      's.last_viewed_at',
      'u.first_name',
      'u.last_name',
      'u.email'
    )) as Array<Record<string, unknown>>
  const meta = await metaFor(rows.map((r) => String(r.id)))
  const now = Date.now()
  return rows.map((r) => {
    const m = meta.get(String(r.id).toLowerCase()) ?? {
      label: 'Wallboard',
      region: null,
      map_collection: null
    }
    const name = [r.first_name, r.last_name].filter(Boolean).join(' ').trim()
    const expires = iso(r.expires_at)
    return {
      id: String(r.id),
      ...m,
      created_at: iso(r.created_at),
      expires_at: expires,
      expired: !expires || new Date(expires).getTime() < now,
      created_by: r.created_by == null ? null : String(r.created_by),
      created_by_name: name || (r.email ? String(r.email) : null),
      view_count: Number(r.view_count ?? 0),
      last_viewed_at: iso(r.last_viewed_at)
    }
  })
}

export async function revokeKioskLink(id: string): Promise<boolean> {
  if (!/^[0-9A-Fa-f-]{36}$/.test(id)) return false
  const n = await db('nivaro_share_links').where({ id, item: CC_KIOSK_ITEM }).delete()
  await db('nivaro_extension_settings')
    .where({ extension_id: CORE_EXT, key: `${META_PREFIX}${id}` })
    .delete()
    .catch(() => 0)
  return Number(n) > 0
}

export interface KioskPrincipal {
  linkId: string
  user: User
  role: Role | null
  isAdmin: boolean
  meta: KioskMeta
  expires_at: string
}

/**
 * The creator a raw kiosk token reads as, or null: unknown / revoked / expired link, or a
 * creator who could not use the board themselves now (inactive, redacted, sign-in off for their
 * role, no longer an administrator). Checked on every request — nothing is cached.
 */
export async function resolveKiosk(raw: unknown): Promise<KioskPrincipal | null> {
  if (!kioskTokenShape(raw)) return null
  const row = (await db('nivaro_share_links')
    .where({ token: hashKioskToken(raw), item: CC_KIOSK_ITEM })
    .first()
    .catch(() => null)) as Record<string, unknown> | null | undefined
  if (!row?.is_active || row.created_by == null || row.expires_at == null) return null
  const expires = new Date(row.expires_at as string).getTime()
  if (!Number.isFinite(expires) || expires <= Date.now()) return null
  const user = (await db('nivaro_users')
    .where({ id: row.created_by, status: 'active' })
    .first()
    .catch(() => null)) as (User & { is_redacted?: unknown }) | null | undefined
  if (!user || user.is_redacted) return null
  const role = user.role
    ? ((await db('nivaro_roles')
        .where({ id: user.role })
        .first()
        .catch(() => null)) as Role | null | undefined)
    : null
  if (!roleAllowsSignIn(role ?? null, user as { account_kind?: string | null })) return null
  const isAdmin = !!role?.admin_access
  if (!isAdmin) return null
  const meta = (await metaFor([String(row.id)])).get(String(row.id).toLowerCase()) ?? {
    label: 'Wallboard',
    region: null,
    map_collection: null
  }
  return {
    linkId: String(row.id),
    user,
    role: role ?? null,
    isAdmin,
    meta,
    expires_at: new Date(expires).toISOString()
  }
}

/** Note a screen checking in (the info route: on load and every few minutes, never per poll). */
export function countKioskView(linkId: string): void {
  void db('nivaro_share_links')
    .where({ id: linkId, item: CC_KIOSK_ITEM })
    .update({ view_count: db.raw('view_count + 1'), last_viewed_at: new Date() })
    .catch(() => undefined)
}
