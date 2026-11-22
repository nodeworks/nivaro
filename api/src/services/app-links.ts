import type { LinkKind, LinkRegistration } from '@nivaro/extension-kit'
import { adminBaseUrl } from '../admin-base.js'
import { config } from '../config.js'
import { db } from '../db/index.js'
import { appKey, dropAppEntries } from './app-keyed.js'
import { overlaySettings } from './settings-overrides.js'
import { currentTenantKey } from './tenant-rooms.js'

export type { LinkKind, LinkRegistration } from '@nivaro/extension-kit'

/**
 * One place that turns "the record REQ-1234" into a URL a person can open.
 *
 * Two apps can own a destination: the admin (always present) and an optional
 * headless frontend — the "portal" — configured in Settings (portal_url +
 * portal_routes JSON) or registered by an extension (ctx.links.register).
 * Which one a RECIPIENT gets: their `preferences.link_app` ('portal' |
 * 'admin') wins; otherwise a role with admin_access → admin, everyone else →
 * portal when one is configured. A destination the portal has no route for
 * falls back to the admin. Shared sends (a flow mailing a list) resolve with
 * no recipient → portal when configured (2026-09-13: portal link only).
 */

export type LinkParams = Record<string, string | number | null | undefined>

const ADMIN_ROUTES: Record<LinkKind, string> = {
  record: '/collections/{collection}/{id}',
  queue: '/queues/{id}',
  report: '/report-studio/{id}',
  alerts: '/alerts',
  chat: '/chat?room={room}',
  tasks: '/tasks',
  approvals: '/approvals',
  access_requests: '/access-requests',
  notifications: '/notifications',
  my_work: '/my-work',
  home: '/',
  profile: '/profile',
  issues: '/issues',
  imports: '/imports',
  dashboard: '/dashboards/{id}',
  integrations: '/integration-health',
  support: '/support?ticket={id}',
  ask: '/ask?q={q}'
}

let registered: LinkRegistration | null = null
export function registerPortalLinks(reg: LinkRegistration): void {
  registered = { base: reg.base.replace(/\/$/, ''), routes: { ...reg.routes } }
}

// Per app: on a shared deployment each app has its own portal (keyed by currentTenantKey()).
const settingsCache = new Map<string, { at: number; value: LinkRegistration | null }>()
/** Drop the cached portal settings: the current app's, or every app's outside one. */
export function bustPortalLinkCache(): void {
  const app = currentTenantKey()
  if (app) settingsCache.delete(app)
  else settingsCache.clear()
}

async function fromSettings(): Promise<LinkRegistration | null> {
  const app = currentTenantKey()
  const hit = settingsCache.get(app)
  if (hit && Date.now() - hit.at < 30_000) return hit.value
  let value: LinkRegistration | null = null
  try {
    // Per-instance overlay: dev + staging share one settings row, so the
    // portal URL differs per NIVARO_INSTANCE (Settings → This Instance).
    const row = await overlaySettings(
      (await db('nivaro_settings').where({ id: 1 }).first('portal_url', 'portal_routes')) as
        | { portal_url: string | null; portal_routes: string | null }
        | undefined
    )
    if (row?.portal_url?.trim()) {
      let routes: Partial<Record<LinkKind, string>> = {}
      try {
        routes = row.portal_routes ? (JSON.parse(row.portal_routes) as typeof routes) : {}
      } catch {
        routes = {}
      }
      value = { base: row.portal_url.trim().replace(/\/$/, ''), routes }
    }
  } catch {
    value = null
  }
  settingsCache.set(app, { at: Date.now(), value })
  return value
}

/** The effective portal registration: Settings beats the extension. */
export async function portalRegistration(): Promise<LinkRegistration | null> {
  return (await fromSettings()) ?? registered
}

// The same resolver every other admin link uses — ADMIN_URL alone is the
// portal on deployments where the headless frontend proxies /api.
const adminBase = () => adminBaseUrl() ?? config.ADMIN_URL.replace(/\/$/, '')
/** The admin app's origin (no trailing slash) — for in-app admin paths that need to be absolute. */
export const adminPageBase = (): string => adminBase().replace(/\/$/, '')

function fill(template: string, params: LinkParams): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => {
    const v = params[k]
    return v == null ? '' : encodeURIComponent(String(v))
  })
}

// Per app (appKey): two apps on one shared deployment may hold the same user id or address.
const appCache = new Map<string, { at: number; app: 'portal' | 'admin' }>()

/** Entries kept per cache across every app (people x apps grows without end otherwise; Hub
 *  phase 6 Task 22). Each answer lives 60 s, so a cut entry is only read again sooner. */
export const LINK_CACHE_MAX = 5000

/** Store with a bound: an existing key moves to the back; past the cap the oldest go. */
function remember<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key)
  map.set(key, value)
  while (map.size > LINK_CACHE_MAX) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
}

/** Which app a recipient should be sent to. */
export async function appForUser(userId?: string | null): Promise<'portal' | 'admin'> {
  const portal = await portalRegistration()
  if (!portal) return 'admin'
  if (!userId) return 'portal'
  const key = appKey(String(userId).toUpperCase())
  const hit = appCache.get(key)
  if (hit && Date.now() - hit.at < 60_000) return hit.app
  let app: 'portal' | 'admin' = 'portal'
  try {
    const row = (await db('nivaro_users as u')
      .leftJoin('nivaro_roles as r', 'r.id', 'u.role')
      .where('u.id', userId)
      .first('u.preferences', 'r.admin_access')) as
      | { preferences: unknown; admin_access: boolean | number | null }
      | undefined
    let pref: string | null = null
    try {
      const p =
        typeof row?.preferences === 'string'
          ? JSON.parse(row.preferences)
          : (row?.preferences ?? null)
      pref = p && typeof p === 'object' ? ((p as { link_app?: string }).link_app ?? null) : null
    } catch {
      pref = null
    }
    if (pref === 'portal' || pref === 'admin') app = pref
    else app = row?.admin_access ? 'admin' : 'portal'
  } catch {
    app = 'portal'
  }
  remember(appCache, key, { at: Date.now(), app })
  return app
}
/** Drop cached link apps / addresses: the current app's, or every app's outside one. */
export function bustAppCache(userId?: string): void {
  dropAppEntries(appCache, userId ? String(userId).toUpperCase() : undefined)
  dropAppEntries(emailCache)
}

const emailCache = new Map<string, { at: number; id: string | null }>()
/** The user behind an address — a mail sent BY EMAIL (flow ops, raw sends)
 *  still resolves its links and footer for the person, when there is one.
 *  Only a single, exact, active address matches; anything else is null. */
export async function userIdForEmail(email: string | null | undefined): Promise<string | null> {
  const key = String(email ?? '')
    .trim()
    .toLowerCase()
  if (!key.includes('@')) return null
  const hit = emailCache.get(appKey(key))
  if (hit && Date.now() - hit.at < 60_000) return hit.id
  let id: string | null = null
  try {
    const row = (await db('nivaro_users')
      .whereRaw('LOWER(email) = ?', [key])
      .where((q) => q.whereNull('status').orWhereNot('status', 'suspended'))
      .first('id')) as { id: string } | undefined
    id = row?.id ?? null
  } catch {
    id = null
  }
  remember(emailCache, appKey(key), { at: Date.now(), id })
  return id
}

/** Build a link for a destination. `app` forces one side; otherwise the
 *  recipient decides (see appForUser). */
export async function linkTo(
  kind: LinkKind,
  params: LinkParams = {},
  opts: { recipientUserId?: string | null; app?: 'portal' | 'admin' } = {}
): Promise<string> {
  const app = opts.app ?? (await appForUser(opts.recipientUserId))
  if (app === 'portal') {
    const portal = await portalRegistration()
    // A collection-specific record route ('record:projects' → /project-360/{id})
    // beats the generic record template.
    const specific =
      kind === 'record' && params.collection
        ? (portal?.routes as Record<string, string> | undefined)?.[
            `record:${String(params.collection)}`
          ]
        : undefined
    const route = specific ?? portal?.routes[kind]
    if (portal && route) return portal.base + fill(route, params)
  }
  return adminBase() + fill(ADMIN_ROUTES[kind], params)
}

/** Every record-page URL shape this instance hands out (admin + portal), for the mail
 *  send-time `since` stamp (services/mail-since-links.ts). */
export async function recordLinkMatchers(): Promise<Array<{ base: string; template: string }>> {
  const out = [{ base: adminBase(), template: ADMIN_ROUTES.record }]
  const portal = await portalRegistration()
  if (portal) {
    for (const [kind, template] of Object.entries(portal.routes ?? {})) {
      if ((kind === 'record' || kind.startsWith('record:')) && typeof template === 'string')
        out.push({ base: portal.base, template })
    }
  }
  return out
}

/** Record link with an optional query suffix (addendum view etc.). */
export async function recordLink(
  collection: string,
  id: string | number,
  opts: { recipientUserId?: string | null; app?: 'portal' | 'admin'; query?: string } = {}
): Promise<string> {
  const url = await linkTo('record', { collection, id }, opts)
  return opts.query ? `${url}${url.includes('?') ? '&' : '?'}${opts.query}` : url
}

/**
 * Per-recipient link resolution for a built mail: builders leave a `_links`
 * spec ({dataKey: {kind, ...params}}) beside the default-resolved URLs; the
 * sender re-resolves every spec for the actual recipient (and the record
 * card's own url) right before rendering.
 */
export type LinkSpec = { kind: LinkKind } & LinkParams
export async function resolveLinksFor(
  data: Record<string, unknown>,
  recipientUserId?: string | null
): Promise<Record<string, unknown>> {
  const specs = data._links as Record<string, LinkSpec> | undefined
  const out: Record<string, unknown> = { ...data }
  if (specs) {
    for (const [key, spec] of Object.entries(specs)) {
      const { kind, ...params } = spec
      out[key] = await linkTo(kind, params, { recipientUserId })
    }
  }
  const card = out.record_card as
    | { collection?: string; item?: string; url?: string }
    | null
    | undefined
  if (card?.collection && card.item) {
    out.record_card = {
      ...card,
      url: await recordLink(card.collection, card.item, { recipientUserId })
    }
  }
  return out
}
