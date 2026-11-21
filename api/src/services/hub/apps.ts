import { db } from '../../db/index.js'
import { urlFieldError } from '../../routes/environments.js'
import { parseJson, toJsonStr } from '../pipeline-engine.js'
import { maskSecret } from './secrets.js'

/**
 * Nivaro Hub apps, environments and owners (phase 1): row shapes, validation and reads.
 * Writes live in routes/hub.ts. An environment's hub_token is sealed at rest (secrets.ts) and
 * leaves this module masked, never in plain text.
 */

export interface HubApp {
  id: number
  key: string
  name: string
  signin_mode: 'direct' | 'hub'
  adopted: boolean
  extensions: string[]
}

export interface HubEnvironment {
  id: number
  app_id: number
  key: string
  position: number
  status: string
  base_url: string
  hostnames: string[]
  placement_id: number | null
  version_pin: string | null
  /** Masked ('••••••') when one is stored, else null. */
  hub_token: string | null
  hub_managed: boolean
}

export interface HubOwner {
  user_id: string
  name: string
}

export const SIGNIN_MODES = ['direct', 'hub'] as const
const KEY_RE = /^[a-z][a-z0-9-]{1,62}$/

export function isHubKey(v: unknown): v is string {
  return typeof v === 'string' && KEY_RE.test(v)
}

export function isSigninMode(v: unknown): v is HubApp['signin_mode'] {
  return typeof v === 'string' && (SIGNIN_MODES as readonly string[]).includes(v)
}

/** A positive integer id from a route param, else null (junk ids answer 404). */
export function idParam(v: unknown): number | null {
  const s = String(v ?? '')
  if (!/^[1-9][0-9]{0,9}$/.test(s)) return null
  const n = Number(s)
  return n <= 2147483647 ? n : null
}

function stringList(raw: unknown): string[] {
  const v = typeof raw === 'string' ? parseJson(raw) : raw
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/** A JSON list of non-empty strings for a text column; null = not a list of strings. */
export function stringListColumn(v: unknown, max = 200): string | null {
  if (!Array.isArray(v)) return null
  const out: string[] = []
  for (const x of v) {
    if (typeof x !== 'string') return null
    const s = x.trim()
    if (!s || s.length > max) return null
    if (!out.includes(s)) out.push(s)
  }
  return toJsonStr(out)
}

export function appFromRow(r: Record<string, unknown>): HubApp {
  return {
    id: Number(r.id),
    key: String(r.key),
    name: String(r.name),
    signin_mode: r.signin_mode === 'hub' ? 'hub' : 'direct',
    adopted: r.adopted === true || r.adopted === 1 || r.adopted === '1',
    extensions: stringList(r.extensions)
  }
}

export function environmentFromRow(r: Record<string, unknown>): HubEnvironment {
  return {
    id: Number(r.id),
    app_id: Number(r.app_id),
    key: String(r.key),
    position: Number(r.position ?? 0),
    status: String(r.status ?? 'active'),
    base_url: String(r.base_url),
    hostnames: stringList(r.hostnames),
    placement_id: r.placement_id == null ? null : Number(r.placement_id),
    version_pin: r.version_pin == null ? null : String(r.version_pin),
    hub_token: maskSecret((r.hub_token as string | null) ?? null),
    hub_managed: r.hub_managed === true || r.hub_managed === 1 || r.hub_managed === '1'
  }
}

/**
 * The base URL an environment answers on: `http(s)://host[:port]` and nothing else (no path,
 * query, fragment or credentials). Returns the normalized origin, or an error message.
 */
export function baseUrlCheck(v: unknown): { url: string } | { error: string } {
  if (typeof v !== 'string' || !v.trim()) return { error: 'base_url is required' }
  const bad = urlFieldError({ base_url: v })
  if (bad) return { error: bad }
  const u = new URL(v.trim())
  if (u.username || u.password) return { error: 'base_url must not carry a user name or password' }
  if ((u.pathname && u.pathname !== '/') || u.search || u.hash || /[?#]/.test(v))
    return { error: 'base_url must be http(s)://host[:port] with no path' }
  return { url: u.origin }
}

export async function readApp(id: number): Promise<HubApp | null> {
  const row = await db('nivaro_hub_apps').where({ id }).first()
  return row ? appFromRow(row) : null
}

export async function isAppOwner(appId: number, userId: string): Promise<boolean> {
  const row = await db('nivaro_hub_app_owners')
    .where({ app_id: appId, user_id: userId })
    .first('id')
  return !!row
}

/** Admins see every app; anyone else only the apps they own. */
export async function listApps(userId: string, isAdmin: boolean): Promise<HubApp[]> {
  const q = db('nivaro_hub_apps').select('*').orderBy('key', 'asc')
  if (!isAdmin)
    q.whereIn('id', db('nivaro_hub_app_owners').where({ user_id: userId }).select('app_id'))
  return ((await q) as Array<Record<string, unknown>>).map(appFromRow)
}

export async function listEnvironments(appId: number): Promise<HubEnvironment[]> {
  const rows = (await db('nivaro_hub_environments')
    .where({ app_id: appId })
    .orderBy('position', 'asc')
    .orderBy('id', 'asc')) as Array<Record<string, unknown>>
  return rows.map(environmentFromRow)
}

function personName(u: Record<string, unknown> | undefined, id: string): string {
  if (!u) return id
  const full = [u.first_name, u.last_name]
    .filter((x) => typeof x === 'string' && x.trim())
    .join(' ')
    .trim()
  return full || (typeof u.email === 'string' && u.email) || id
}

export async function listOwners(appId: number): Promise<HubOwner[]> {
  const ids = (
    (await db('nivaro_hub_app_owners')
      .where({ app_id: appId })
      .orderBy('id', 'asc')
      .select('user_id')) as Array<{ user_id: string }>
  ).map((r) => String(r.user_id))
  if (!ids.length) return []
  const users = (await db('nivaro_users')
    .whereIn('id', ids)
    .select('id', 'first_name', 'last_name', 'email')) as Array<Record<string, unknown>>
  const byId = new Map(users.map((u) => [String(u.id).toLowerCase(), u]))
  return ids.map((id) => ({ user_id: id, name: personName(byId.get(id.toLowerCase()), id) }))
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A user id shape (nivaro_users.id is a uuid column: anything else fails to convert there). */
export function isUserIdShape(v: string): boolean {
  return UUID_RE.test(v)
}

/** Which of these user ids name no person (compared case-insensitively). Pass uuids only. */
export async function unknownUserIds(ids: string[]): Promise<string[]> {
  if (!ids.length) return []
  const found = new Set(
    ((await db('nivaro_users').whereIn('id', ids).select('id')) as Array<{ id: string }>).map((u) =>
      String(u.id).toLowerCase()
    )
  )
  return ids.filter((id) => !found.has(id.toLowerCase()))
}
