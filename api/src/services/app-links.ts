import { config } from '../config.js'
import { db } from '../db/index.js'
import { overlaySettings } from './settings-overrides.js'

/**
 * One place that turns "the record CR26-80329" into a URL a person can open.
 *
 * Two apps can own a destination: the admin (always present) and an optional
 * headless frontend — the "portal" — configured in Settings (portal_url +
 * portal_routes JSON) or registered by an extension (ctx.links.register).
 * Which one a RECIPIENT gets: their `preferences.link_app` ('portal' |
 * 'admin') wins; otherwise a role with admin_access → admin, everyone else →
 * portal when one is configured. A destination the portal has no route for
 * falls back to the admin. Shared sends (a flow mailing a list) resolve with
 * no recipient → portal when configured (Rob, 2026-09-13: portal link only).
 */

export type LinkKind =
  | 'record'
  | 'queue'
  | 'report'
  | 'alerts'
  | 'chat'
  | 'tasks'
  | 'approvals'
  | 'access_requests'
  | 'notifications'
  | 'my_work'
  | 'home'
  | 'profile'
  | 'issues'
  | 'imports'
  | 'dashboard'

export type LinkParams = Record<string, string | number | null | undefined>

export interface LinkRegistration {
  /** Portal origin, no trailing slash. */
  base: string
  /** Route templates per kind: '/records/{collection}/{id}'. Missing kinds
   *  fall back to the admin route. */
  routes: Partial<Record<LinkKind, string>>
}

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
  dashboard: '/dashboards/{id}'
}

let registered: LinkRegistration | null = null
export function registerPortalLinks(reg: LinkRegistration): void {
  registered = { base: reg.base.replace(/\/$/, ''), routes: { ...reg.routes } }
}

let settingsCache: { at: number; value: LinkRegistration | null } | null = null
export function bustPortalLinkCache(): void {
  settingsCache = null
}

async function fromSettings(): Promise<LinkRegistration | null> {
  if (settingsCache && Date.now() - settingsCache.at < 30_000) return settingsCache.value
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
  settingsCache = { at: Date.now(), value }
  return value
}

/** The effective portal registration: Settings beats the extension. */
export async function portalRegistration(): Promise<LinkRegistration | null> {
  return (await fromSettings()) ?? registered
}

const adminBase = () => config.ADMIN_URL.replace(/\/$/, '')

function fill(template: string, params: LinkParams): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => {
    const v = params[k]
    return v == null ? '' : encodeURIComponent(String(v))
  })
}

const appCache = new Map<string, { at: number; app: 'portal' | 'admin' }>()

/** Which app a recipient should be sent to. */
export async function appForUser(userId?: string | null): Promise<'portal' | 'admin'> {
  const portal = await portalRegistration()
  if (!portal) return 'admin'
  if (!userId) return 'portal'
  const key = String(userId).toUpperCase()
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
  appCache.set(key, { at: Date.now(), app })
  return app
}
export function bustAppCache(userId?: string): void {
  if (userId) appCache.delete(String(userId).toUpperCase())
  else appCache.clear()
  emailCache.clear()
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
  const hit = emailCache.get(key)
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
  emailCache.set(key, { at: Date.now(), id })
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
