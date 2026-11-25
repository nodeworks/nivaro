import { getTenantId } from '../../db/tenant-context.js'
import { tenantSource } from '../deployment-mode.js'
import { openForApp } from './app-sealed.js'

/**
 * Each app's Hub link on a Hub shared deployment (sign-in through the Hub and the app switcher,
 * per app), by tenant id. A dedicated app reads these from its environment (HUB_TOKEN,
 * HUB_CLIENT_ID, HUB_CLIENT_SECRET, HUB_IDP_AUDIENCE); one process serving many apps cannot, so
 * the Hub hands each app its own in the tenant list (`hub_link`, services/hub/shared/tenants.ts),
 * sealed with that app's key (tenancy/app-sealed.ts) — binding the value to that app (it opens
 * only under that app's entry), not secrecy: the list carries the key beside it and is protected
 * as a whole (TLS, deployment token, no-store):
 *
 *   token          the environment's hub token (the app link bearer: sign-in reports, switcher)
 *   client_id      the environment's client at the Hub (hubc_…), only while the app signs in
 *   client_secret  through the Hub and the client is active
 *   idp_audience   the Hub's own Microsoft client id (the `aud` of the sign-in evidence)
 *
 * The Hub source (hub-source.ts) replaces the whole set every time it takes a list, like the app
 * keys (app-keys.ts). Values live in memory only, opened, never in a log, an error or an answer;
 * a value that does not open with the app's key, or is off shape, is dropped (that app signs in
 * directly). Only on the Hub source: Nivaro Cloud and self-hosted never read this.
 */

export interface AppHubLink {
  /** The environment's hub token, or null (no switcher, no sign-in reports). */
  token: string | null
  /** The environment's Hub client, or null (the app signs in directly). */
  clientId: string | null
  clientSecret: string | null
  /** The Hub's own Microsoft client id, or null (HUB_IDP_AUDIENCE of the deployment is used). */
  idpAudience: string | null
}

const CLIENT_ID_RE = /^hubc_[0-9a-f]{24}$/
const AUDIENCE_RE = /^[\x21-\x7e]{1,200}$/
const MIN_SECRET = 32
const MAX_SECRET = 512
const MAX_TOKEN = 1024

const links = new Map<string, AppHubLink>()

function textIn(v: unknown, min: number, max: number): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t.length >= min && t.length <= max ? t : null
}

/** The opened `hub_link` as an AppHubLink; null when nothing usable is in it. */
export function parseHubLink(plain: string | null): AppHubLink | null {
  if (!plain) return null
  let v: unknown
  try {
    v = JSON.parse(plain)
  } catch {
    return null
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  const token = textIn(o.token, MIN_SECRET, MAX_TOKEN)
  const id = typeof o.client_id === 'string' && CLIENT_ID_RE.test(o.client_id) ? o.client_id : null
  const secret = textIn(o.client_secret, MIN_SECRET, MAX_SECRET)
  // A client is usable only as a pair.
  const clientId = id && secret ? id : null
  const clientSecret = id && secret ? secret : null
  const aud = typeof o.idp_audience === 'string' ? o.idp_audience.trim() : ''
  const idpAudience = AUDIENCE_RE.test(aud) ? aud : null
  if (!token && !clientId) return null
  return { token, clientId, clientSecret, idpAudience }
}

/** Replace every link with the list's: an app the list no longer holds (or lists without a
 *  link, or without its key) has none afterwards. */
export function setAppHubLinks(
  tenants: readonly { id: string; encryptionKey?: string; hubLink?: string }[]
): void {
  links.clear()
  for (const t of tenants) {
    if (!t.hubLink || !t.encryptionKey) continue
    const link = parseHubLink(openForApp(t.hubLink, t.encryptionKey))
    if (link) links.set(t.id, link)
  }
}

/** The Hub link of an app by tenant id, or null. */
export function appHubLinkOf(tenantId: string): AppHubLink | null {
  return links.get(tenantId) ?? null
}

/** The Hub link of the app being served on a Hub shared deployment; null outside an app, on any
 *  other deployment, or for an app the Hub gave none. */
export function currentAppHubLink(env: NodeJS.ProcessEnv = process.env): AppHubLink | null {
  if (tenantSource(env) !== 'hub') return null
  const id = getTenantId()
  return id ? appHubLinkOf(id) : null
}

/** Test seam: forget every link. */
export function resetAppHubLinksForTests(): void {
  links.clear()
}

/** Test seam: one app's link as the Hub would hand it. */
export function _setAppHubLinkForTests(tenantId: string, link: AppHubLink | null): void {
  if (link) links.set(tenantId, link)
  else links.delete(tenantId)
}
