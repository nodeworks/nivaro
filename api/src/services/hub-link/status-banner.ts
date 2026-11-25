import { announceToTenant } from '../record-events.js'
import { currentTenantKey } from '../tenant-rooms.js'
import { hubLinkKeyTag } from './retire.js'

/**
 * Hub incident status banner, app side (Hub enhancement 32). While a Hub incident is open the Hub
 * sets one line of PLAIN TEXT here over its link (PUT /api/hub-link/status-banner, or the shared
 * deployment's /api/hub-deployment/apps/:id/status-banner); GET /api/announcements/active then
 * carries it as a synthetic, non-dismissable row (id -3) for EVERY signed-in viewer, so the
 * existing banner strip (packages/shared AnnouncementBanner, admin and efp-new) shows it. No new
 * client code, and the strip renders `message` as a text node, never as HTML.
 *
 * Stored in this app's Redis with a TTL (BANNER_TTL_S): the Hub refreshes it while the incident
 * is open, so a Hub that goes away never leaves a banner up for good. The key names the app
 * (currentTenantKey() on a shared deployment, the hub-link tag of HUB_TOKEN on a dedicated app),
 * so two apps on one Redis never see each other's banner. Not config: never promoted, never
 * copied by an environment refresh.
 */

export const BANNER_TTL_S = 2 * 60 * 60
export const BANNER_MAX = 280
export const BANNER_TONES = ['critical', 'warn', 'info'] as const
export type BannerTone = (typeof BANNER_TONES)[number]

export interface StatusBanner {
  text: string
  tone: BannerTone
  /** The Hub's incident id (a clear for another incident leaves this one up). */
  incident: number
  set_at: string
}

export interface BannerRedis {
  get(key: string): Promise<string | null>
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>
  del(key: string): Promise<unknown>
}

/**
 * Banner text as plain text: control characters and line breaks become spaces, `<` and `>` are
 * dropped (nothing that looks like markup ever reaches a viewer, whatever renders it), runs of
 * spaces fold, at most BANNER_MAX characters. Empty → null. The Hub and the app both apply it.
 */
export function plainBannerText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const out = raw
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are the point
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, BANNER_MAX)
    .trim()
  return out || null
}

export function isBannerTone(v: unknown): v is BannerTone {
  return typeof v === 'string' && (BANNER_TONES as readonly string[]).includes(v)
}

/** `<REDIS_CHANNEL_PREFIX>nvr:hub-banner:<app>` — the app, never one key for every app. */
export function bannerKey(env: NodeJS.ProcessEnv = process.env): string {
  return `${(env.REDIS_CHANNEL_PREFIX ?? '').trim()}nvr:hub-banner:${currentTenantKey() || hubLinkKeyTag(env)}`
}

function parse(raw: string | null): StatusBanner | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as Partial<StatusBanner>
    const text = plainBannerText(v.text)
    if (!text || !isBannerTone(v.tone) || !Number.isSafeInteger(v.incident)) return null
    return { text, tone: v.tone, incident: Number(v.incident), set_at: String(v.set_at ?? '') }
  } catch {
    return null
  }
}

/** The banner on now, or null (no Redis, nothing set, an unreadable value). Never throws. */
export async function readStatusBanner(
  redis: BannerRedis | null | undefined
): Promise<StatusBanner | null> {
  if (!redis) return null
  try {
    return parse(await redis.get(bannerKey()))
  } catch {
    return null
  }
}

export type BannerWrite =
  | { ok: true; banner: StatusBanner | null }
  | { ok: false; status: number; code: string; message: string }

/** PUT body → the stored banner (validated, plain text, TTL). Tells every open tab to re-read. */
export async function setStatusBanner(
  redis: BannerRedis | null | undefined,
  body: unknown,
  now = new Date()
): Promise<BannerWrite> {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const text = plainBannerText(b.text)
  if (!text)
    return {
      ok: false,
      status: 400,
      code: 'BAD_BANNER',
      message: `text is 1 to ${BANNER_MAX} characters of plain text`
    }
  const tone = b.tone == null ? 'critical' : b.tone
  if (!isBannerTone(tone))
    return { ok: false, status: 400, code: 'BAD_BANNER', message: 'tone is critical, warn or info' }
  const incident = Number(b.incident_id)
  if (!Number.isSafeInteger(incident) || incident <= 0)
    return {
      ok: false,
      status: 400,
      code: 'BAD_BANNER',
      message: 'incident_id is the Hub incident'
    }
  if (!redis)
    return {
      ok: false,
      status: 503,
      code: 'REDIS_UNAVAILABLE',
      message: 'The banner could not be stored (Redis)'
    }
  const banner: StatusBanner = { text, tone, incident, set_at: now.toISOString() }
  await redis.set(bannerKey(), JSON.stringify(banner), 'EX', BANNER_TTL_S)
  announceToTenant('announcements:changed')
  return { ok: true, banner }
}

/** DELETE: clears the banner — only the named incident's when `incident_id` is given. */
export async function clearStatusBanner(
  redis: BannerRedis | null | undefined,
  body: unknown
): Promise<BannerWrite> {
  if (!redis)
    return {
      ok: false,
      status: 503,
      code: 'REDIS_UNAVAILABLE',
      message: 'The banner could not be cleared (Redis)'
    }
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const want = b.incident_id == null ? null : Number(b.incident_id)
  const now = parse(await redis.get(bannerKey()))
  if (now && want != null && now.incident !== want) return { ok: true, banner: now }
  await redis.del(bannerKey())
  if (now) announceToTenant('announcements:changed')
  return { ok: true, banner: null }
}

/** The synthetic /announcements/active row for the banner (every viewer, never dismissable). */
export function bannerAnnouncement(b: StatusBanner) {
  return {
    id: -3,
    message: b.text,
    subject: 'Service status',
    severity: b.tone,
    ends_at: null,
    dismissable: false,
    require_ack: false,
    hub_status: true
  }
}
