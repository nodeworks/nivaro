import { createHmac } from 'node:crypto'
import { db } from '../db/index.js'
import { instanceKey } from './instance-key.js'

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
const MAX_PARTICIPANTS_CAP = 16
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
  /** Soft cap on people in one huddle (mesh audio; 2–16). */
  max_participants: number
}

export const HUDDLE_DEFAULTS: HuddleSettings = {
  enabled: true,
  stun_urls: [],
  turn_urls: [],
  turn_username: null,
  turn_credential: null,
  turn_secret: null,
  turn_ttl_s: DEFAULT_TTL_S,
  max_participants: 8
}

const URL_RE = /^(stuns?|turns?):[^\s]+$/i

function urlList(raw: unknown, scheme: RegExp): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[\n,]/) : []
  const out: string[] = []
  for (const v of list) {
    const s = String(v ?? '').trim()
    if (!s || !URL_RE.test(s) || !scheme.test(s)) continue
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
      Number.isFinite(max) && max > 0
        ? Math.min(MAX_PARTICIPANTS_CAP, Math.max(2, Math.round(max)))
        : HUDDLE_DEFAULTS.max_participants
  }
}

/** What the Settings page sees: secrets replaced by the mask. */
export function maskHuddleSettings(s: HuddleSettings): HuddleSettings {
  return {
    ...s,
    turn_credential: s.turn_credential ? HUDDLE_MASK : null,
    turn_secret: s.turn_secret ? HUDDLE_MASK : null
  }
}

/**
 * Merge an admin's patch over what is stored. A secret field carrying the mask
 * keeps the stored value; null or '' clears it.
 */
export function mergeHuddlePatch(stored: HuddleSettings, patch: unknown): HuddleSettings {
  const p =
    patch && typeof patch === 'object' && !Array.isArray(patch)
      ? (patch as Record<string, unknown>)
      : {}
  const next: Record<string, unknown> = { ...stored }
  for (const k of Object.keys(HUDDLE_DEFAULTS) as Array<keyof HuddleSettings>) {
    if (!(k in p)) continue
    if ((k === 'turn_credential' || k === 'turn_secret') && p[k] === HUDDLE_MASK) continue
    next[k] = p[k]
  }
  return normalizeHuddleSettings(next)
}

// ── Storage (30 s cache; the PATCH route busts it) ───────────────────────────
let cache: { at: number; value: HuddleSettings } | null = null

export function bustHuddleSettingsCache(): void {
  cache = null
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
  if (cache && Date.now() - cache.at < 30_000) return cache.value
  let value = HUDDLE_DEFAULTS
  try {
    const row = await readRow()
    value = normalizeHuddleSettings(row?.data[HUDDLE_OVERRIDE_KEY])
  } catch {
    /* table absent / DB not ready — defaults */
  }
  cache = { at: Date.now(), value }
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
  return next
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
