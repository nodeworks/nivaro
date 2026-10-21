import { createHmac } from 'node:crypto'
import { db } from '../db/index.js'
import { validIceUrl, validLiveKitUrl, withPlatformDestinations } from './huddle-destinations.js'
import { instanceKey } from './instance-key.js'
import { currentTenantKey } from './tenant-rooms.js'

/**
 * Huddle (#2457) ICE configuration — the STUN/TURN servers browsers use to
 * find each other. TURN is infrastructure that differs per environment (a
 * laptop needs none, staging and production each run their own coturn), so it
 * lives under the `huddle` key of THIS instance's `nivaro_settings_overrides`
 * row, next to the Traffic Map detectors (#2223) — never in the shared
 * nivaro_settings row and never a migration.
 *
 * Secrets never reach a browser. With a coturn shared secret
 * (`use-auth-secret` / `static-auth-secret`) every signed-in person gets their
 * own time-limited credential (username `<expiry>:<user id>`, password
 * HMAC-SHA1 of that username), minted per request by `iceServersFor`. A plain
 * static TURN username/password is handed out as is — it is already the thing
 * the browser must send.
 */

export const HUDDLE_OVERRIDE_KEY = 'huddle'
export const HUDDLE_MASK = '••••••'
/** Mesh audio: every extra person costs every browser a stream, so the cap is low. */
const MAX_PARTICIPANTS_CAP = 16
/** With an SFU (#2859) each browser uploads once, so the cap can be a real room. */
const SFU_MAX_PARTICIPANTS_CAP = 100
const SFU_DEFAULT_MAX = 25
const DEFAULT_SWITCH_AT = 5
const DEFAULT_TTL_S = 3600

export interface HuddleSettings {
  /** Huddles may be started on this instance (default on). */
  enabled: boolean
  /** STUN urls; empty = none (host candidates only — one network). Never a third party by default:
   *  browsers on an internal network must not contact anyone nobody opted in to. */
  stun_urls: string[]
  /** TURN(S) urls; empty = no relay (same network / direct only). */
  turn_urls: string[]
  /** Static TURN credential (long-term credential mode). */
  turn_username: string | null
  turn_credential: string | null
  /** coturn shared secret (`use-auth-secret`) — wins over the static pair. */
  turn_secret: string | null
  /** Lifetime of a minted credential, seconds. */
  turn_ttl_s: number
  /** Soft cap on people in one huddle (mesh 2–16, default 8; with an SFU 2–100, default 25). */
  max_participants: number
  /** Large huddles (#2859): a LiveKit SFU browsers move to above `switch_at` people.
   *  `wss://` url; null = mesh only. */
  livekit_url: string | null
  livekit_api_key: string | null
  /** Signs the per-person LiveKit access tokens; never leaves the server. */
  livekit_api_secret: string | null
  /** A huddle whose participant count would EXCEED this moves to the SFU. */
  switch_at: number
}

export const HUDDLE_DEFAULTS: HuddleSettings = {
  enabled: true,
  stun_urls: [],
  turn_urls: [],
  turn_username: null,
  turn_credential: null,
  turn_secret: null,
  turn_ttl_s: DEFAULT_TTL_S,
  max_participants: 8,
  livekit_url: null,
  livekit_api_key: null,
  livekit_api_secret: null,
  switch_at: DEFAULT_SWITCH_AT
}

const SECRET_KEYS: ReadonlySet<keyof HuddleSettings> = new Set([
  'turn_credential',
  'turn_secret',
  'livekit_api_secret'
])

/** The SFU path exists only with a url, a key and a secret. */
export function sfuConfigured(
  s: Pick<HuddleSettings, 'livekit_url' | 'livekit_api_key' | 'livekit_api_secret'>
): boolean {
  return !!(s.livekit_url && s.livekit_api_key && s.livekit_api_secret)
}

function urlList(raw: unknown, scheme: RegExp): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[\n,]/) : []
  const out: string[] = []
  for (const v of list) {
    const s = String(v ?? '').trim()
    // No user info, transport query only (finding 3): the probe dials these addresses.
    if (!s || !validIceUrl(s, scheme)) continue
    if (!out.includes(s)) out.push(s)
    if (out.length >= 8) break
  }
  return out
}

function text(raw: unknown, max = 500): string | null {
  if (raw == null) return null
  const s = String(raw).trim()
  return s ? s.slice(0, max) : null
}

/** Stored JSON → settings (pure; anything unreadable falls back to the default). */
export function normalizeHuddleSettings(raw: unknown): HuddleSettings {
  const src =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const ttl = Number(src.turn_ttl_s)
  const max = Number(src.max_participants)
  const switchAt = Number(src.switch_at)
  const livekitUrl = text(src.livekit_url, 300)
  const sfu = {
    livekit_url: validLiveKitUrl(livekitUrl),
    livekit_api_key: text(src.livekit_api_key, 200),
    livekit_api_secret: text(src.livekit_api_secret)
  }
  // The participant cap depends on how media travels: mesh or SFU.
  const cap = sfuConfigured(sfu) ? SFU_MAX_PARTICIPANTS_CAP : MAX_PARTICIPANTS_CAP
  const defaultMax = sfuConfigured(sfu) ? SFU_DEFAULT_MAX : HUDDLE_DEFAULTS.max_participants
  return {
    enabled: src.enabled !== false,
    stun_urls: urlList(src.stun_urls, /^stuns?:/i),
    turn_urls: urlList(src.turn_urls, /^turns?:/i),
    turn_username: text(src.turn_username, 200),
    turn_credential: text(src.turn_credential),
    turn_secret: text(src.turn_secret),
    turn_ttl_s:
      Number.isFinite(ttl) && ttl > 0
        ? Math.min(86_400, Math.max(60, Math.round(ttl)))
        : DEFAULT_TTL_S,
    max_participants:
      Number.isFinite(max) && max > 0 ? Math.min(cap, Math.max(2, Math.round(max))) : defaultMax,
    ...sfu,
    switch_at:
      Number.isFinite(switchAt) && switchAt > 0
        ? Math.min(SFU_MAX_PARTICIPANTS_CAP, Math.max(2, Math.round(switchAt)))
        : DEFAULT_SWITCH_AT
  }
}

/** What the Settings page sees: secrets replaced by the mask. */
export function maskHuddleSettings(s: HuddleSettings): HuddleSettings {
  return {
    ...s,
    turn_credential: s.turn_credential ? HUDDLE_MASK : null,
    turn_secret: s.turn_secret ? HUDDLE_MASK : null,
    livekit_api_secret: s.livekit_api_secret ? HUDDLE_MASK : null
  }
}

/**
 * Merge an admin's patch over what is stored. A secret field carrying the mask
 * keeps the stored value; null or '' clears it. A patch that configures the SFU
 * for the first time without naming a cap lets the cap re-default (8 → 25):
 * the mesh default was never a choice about an SFU.
 */
export function mergeHuddlePatch(stored: HuddleSettings, patch: unknown): HuddleSettings {
  const p =
    patch && typeof patch === 'object' && !Array.isArray(patch)
      ? (patch as Record<string, unknown>)
      : {}
  const next: Record<string, unknown> = { ...stored }
  for (const k of Object.keys(HUDDLE_DEFAULTS) as Array<keyof HuddleSettings>) {
    if (!(k in p)) continue
    if (SECRET_KEYS.has(k) && p[k] === HUDDLE_MASK) continue
    next[k] = p[k]
  }
  if (
    !sfuConfigured(stored) &&
    sfuConfigured(next as unknown as HuddleSettings) &&
    !('max_participants' in p) &&
    stored.max_participants === HUDDLE_DEFAULTS.max_participants
  ) {
    next.max_participants = undefined
  }
  return normalizeHuddleSettings(next)
}

// ── Storage (30 s cache per tenant; the PATCH route busts it) ─────────────────
// Keyed by tenant: in cloud mode one process serves many tenants, each with its own row.
const cache = new Map<string, { at: number; value: HuddleSettings }>()

export function bustHuddleSettingsCache(): void {
  cache.clear()
}

async function readRow(): Promise<{ id: number; data: Record<string, unknown> } | null> {
  const row = (await db('nivaro_settings_overrides')
    .where({ instance_key: instanceKey() })
    .first('id', 'data')) as { id: number; data?: string | null } | undefined
  if (!row) return null
  try {
    const obj = row.data ? JSON.parse(row.data) : {}
    return { id: row.id, data: obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {} }
  } catch {
    return { id: row.id, data: {} }
  }
}

/** This instance's huddle settings (defaults when the table is missing or unreadable). */
export async function getHuddleSettings(): Promise<HuddleSettings> {
  const tenant = currentTenantKey()
  const hit = cache.get(tenant)
  if (hit && Date.now() - hit.at < 30_000) return hit.value
  let value = HUDDLE_DEFAULTS
  try {
    const row = await readRow()
    // Cloud mode: the platform's media servers, never a tenant's (huddle-destinations.ts).
    value = withPlatformDestinations(normalizeHuddleSettings(row?.data[HUDDLE_OVERRIDE_KEY]))
  } catch {
    /* table absent / DB not ready — defaults */
    value = withPlatformDestinations(HUDDLE_DEFAULTS)
  }
  cache.set(tenant, { at: Date.now(), value })
  return value
}

export async function saveHuddleSettings(patch: unknown): Promise<HuddleSettings> {
  const row = await readRow()
  const stored = normalizeHuddleSettings(row?.data[HUDDLE_OVERRIDE_KEY])
  const next = mergeHuddlePatch(stored, patch)
  const data = { ...(row?.data ?? {}), [HUDDLE_OVERRIDE_KEY]: next }
  if (row) {
    await db('nivaro_settings_overrides')
      .where({ id: row.id })
      .update({ data: JSON.stringify(data), updated_at: new Date() })
  } else {
    await db('nivaro_settings_overrides').insert({
      instance_key: instanceKey(),
      data: JSON.stringify(data),
      updated_at: new Date()
    })
  }
  bustHuddleSettingsCache()
  return withPlatformDestinations(next)
}

export interface IceServer {
  urls: string[]
  username?: string
  credential?: string
}

/** coturn `use-auth-secret` credential: username `<expiry>:<id>`, password = HMAC-SHA1(secret, username) base64. */
export function turnRestCredential(
  secret: string,
  userId: string,
  ttlS: number,
  now = Date.now()
): { username: string; credential: string } {
  const username = `${Math.floor(now / 1000) + ttlS}:${userId}`
  const credential = createHmac('sha1', secret).update(username).digest('base64')
  return { username, credential }
}

/**
 * The ICE servers a signed-in person's browser gets (pure given the settings). Nothing
 * configured = an empty list: host candidates reach people on the same network. TURN
 * entries (a relay anyone holding the credential can push traffic through) go out only
 * with `turn: true` — the caller has proven the person is about to talk in a room they
 * can see; a plain lookup gets STUN at most.
 */
export function iceServersFrom(
  s: HuddleSettings,
  userId: string,
  now = Date.now(),
  turn = true
): IceServer[] {
  const out: IceServer[] = []
  if (s.stun_urls.length) out.push({ urls: s.stun_urls })
  if (turn && s.turn_urls.length) {
    if (s.turn_secret) {
      out.push({
        urls: s.turn_urls,
        ...turnRestCredential(s.turn_secret, userId, s.turn_ttl_s, now)
      })
    } else if (s.turn_username && s.turn_credential) {
      out.push({ urls: s.turn_urls, username: s.turn_username, credential: s.turn_credential })
    } else {
      out.push({ urls: s.turn_urls })
    }
  }
  return out
}

export interface IceResponse {
  enabled: boolean
  iceServers: IceServer[]
  ttl_s: number
  max_participants: number
}

/**
 * The /ice answer (pure given the settings): nothing at all while huddles are off, STUN only
 * for a lookup without a room, TURN credentials only for a room the person can see (checked
 * by the caller-supplied `canSee`).
 */
export async function iceResponseFor(
  s: HuddleSettings,
  userId: string,
  room: string | null,
  canSee: (room: string) => Promise<boolean>,
  now = Date.now()
): Promise<IceResponse> {
  const base = {
    ttl_s: s.turn_secret ? s.turn_ttl_s : 86_400,
    max_participants: s.max_participants
  }
  if (!s.enabled) return { enabled: false, iceServers: [], ...base }
  const turn = !!room && (await canSee(room))
  return { enabled: true, iceServers: iceServersFrom(s, userId, now, turn), ...base }
}

export async function iceServersFor(
  userId: string,
  room: string | null,
  canSee: (room: string) => Promise<boolean>
): Promise<IceResponse> {
  return iceResponseFor(await getHuddleSettings(), userId, room, canSee)
}
