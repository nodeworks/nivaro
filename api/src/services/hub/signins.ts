import { db } from '../../db/index.js'
import { isUniqueViolation } from '../../lib/unique-violation.js'

/**
 * Nivaro Hub phase 7 (plan Decision 12): who signed in where, for the app switcher only.
 *
 * One `nivaro_hub_signins` row per identity key per environment. Written when the Hub redeems a
 * code (`via = 'hub'`, routes/hub-oidc.ts) and when an app reports a sign-in over the app link
 * (`via = 'direct'`, routes/hub-app-link.ts). Identity keys:
 *
 *   entra:<tid>:<oid>   lowercased, when both are known (the Entra object id is the identity)
 *   email:<lowercased>  when an email is known
 *
 * The switcher answers an app only about a person who has a row for THAT environment, and lists
 * only environments with the same key (production lists production), status `active`, where the
 * person has a row. Links are the target app's own sign-in, never a code, token or email.
 *
 * Rows older than 180 days are pruned daily (cron hub-signins-prune, Hub only).
 * Hub-only (HUB=on, never cloud mode).
 */

const SIGNINS = 'nivaro_hub_signins'
const ENVS = 'nivaro_hub_environments'
const APPS = 'nivaro_hub_apps'
export const SIGNIN_KEEP_DAYS = 180
/** Entra object / tenant ids are GUIDs; anything else that is short and plain is kept as text. */
const ID_RE = /^[A-Za-z0-9-]{1,64}$/
/** `email:` + the address must fit identity_key (200). */
const EMAIL_MAX = 194
const EMAIL_RE = /^[^\s@]+@[^\s@]+$/

export interface SigninWho {
  oid?: string | null
  tid?: string | null
  email?: string | null
}

function cleanId(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim().toLowerCase()
  return ID_RE.test(s) ? s : null
}

function cleanEmail(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim().toLowerCase()
  if (s.length < 3 || s.length > EMAIL_MAX || !EMAIL_RE.test(s)) return null
  return s
}

/** The person's identity keys: Entra first (when oid AND tid), then email; [] when none. */
export function identityKeys(who: SigninWho): string[] {
  const keys: string[] = []
  const oid = cleanId(who?.oid)
  const tid = cleanId(who?.tid)
  if (oid && tid) keys.push(`entra:${tid}:${oid}`)
  const email = cleanEmail(who?.email)
  if (email) keys.push(`email:${email}`)
  return keys
}

/** An engine error code or name worth logging: short word characters only, never the message. */
function errorTag(e: unknown): string {
  const err = e as { code?: unknown; number?: unknown; name?: unknown }
  for (const v of [err?.code, err?.number, err?.name]) {
    const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v : ''
    if (/^[A-Za-z0-9_]{1,40}$/.test(s)) return s
  }
  return 'unknown'
}

/** knex inlines bindings (emails) into its errors: a fixed line and a generic error instead. */
function writeFailed(e: unknown): Error {
  // biome-ignore lint/suspicious/noConsole: the failure must reach the server log (fixed text)
  console.error(`hub: recording a sign-in failed (${errorTag(e)})`)
  return new Error('Recording the sign-in failed')
}

/**
 * The Hub account for this person: by Entra object id (stored lowercased, services/users.ts),
 * the tenant must agree when the row has one; else by email when exactly one account has it.
 * Best effort: null on no match, ambiguity or any read failure.
 */
async function resolveHubUser(who: SigninWho): Promise<string | null> {
  try {
    const oid = cleanId(who.oid)
    const tid = cleanId(who.tid)
    if (oid && tid) {
      const row = (await db('nivaro_users').where({ entra_oid: oid }).first('id', 'entra_tid')) as
        | { id: string; entra_tid?: string | null }
        | undefined
      if (row && (!row.entra_tid || String(row.entra_tid).toLowerCase() === tid))
        return String(row.id)
    }
    const email = cleanEmail(who.email)
    if (email) {
      const rows = (await db('nivaro_users')
        .whereRaw('LOWER(email) = ?', [email])
        .limit(2)
        .select('id')) as Array<{ id: string }>
      if (rows.length === 1) return String(rows[0].id)
    }
  } catch {
    // The switcher works without it.
  }
  return null
}

export interface RecordSigninInput extends SigninWho {
  environment_id: number
  app_id: number
  via: 'hub' | 'direct'
  hub_user_id?: string | null
  at?: Date
}

/**
 * One row per identity key for this environment: inserted, or (unique key already there) its
 * last_seen, via and app moved on, and hub_user_id / email set when known. Idempotent: the same
 * report twice leaves the same rows. No usable identity = nothing written.
 */
export async function recordSignin(input: RecordSigninInput): Promise<void> {
  const keys = identityKeys(input)
  if (!keys.length) return
  const environmentId = Number(input.environment_id)
  const appId = Number(input.app_id)
  if (!Number.isInteger(environmentId) || !Number.isInteger(appId)) return
  const via = input.via === 'hub' ? 'hub' : 'direct'
  const at = input.at ?? new Date()
  const hubUserId = input.hub_user_id ? String(input.hub_user_id) : await resolveHubUser(input)
  const email = cleanEmail(input.email)

  for (const identity_key of keys) {
    const update: Record<string, unknown> = { last_seen: at, via, app_id: appId }
    if (hubUserId) update.hub_user_id = hubUserId
    if (email) update.email = email
    try {
      try {
        await db(SIGNINS).insert({
          identity_key,
          environment_id: environmentId,
          app_id: appId,
          via,
          hub_user_id: hubUserId,
          email,
          first_seen: at,
          last_seen: at
        })
        continue
      } catch (e) {
        if (!isUniqueViolation(e)) throw e
      }
      await db(SIGNINS).where({ identity_key, environment_id: environmentId }).update(update)
    } catch (e) {
      throw writeFailed(e)
    }
  }
}

export interface SwitcherApp {
  app_key: string
  app_name: string
  environment_key: string
  url: string
  signin_url: string
  current: boolean
}

/** `<origin>/` of an http(s) base URL; null for anything else. Userinfo, path, query dropped. */
function originOf(baseUrl: unknown): string | null {
  if (typeof baseUrl !== 'string') return null
  try {
    const u = new URL(baseUrl)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
    return u.origin
  } catch {
    return null
  }
}

/**
 * The apps to offer a person in the switcher of environment `askingEnvId` (whose key is
 * `envKey`). Empty unless the person has a sign-in row for the asking environment (an app learns
 * nothing about people who never signed in to it). Otherwise every active environment with the
 * same key where the person has a row, the asking one marked `current`, sorted by app name.
 */
export async function switcherFor(
  envKey: string,
  askingEnvId: number,
  who: SigninWho
): Promise<SwitcherApp[]> {
  const keys = identityKeys(who)
  if (!keys.length || typeof envKey !== 'string' || !envKey) return []
  const own = await db(SIGNINS)
    .where({ environment_id: askingEnvId })
    .whereIn('identity_key', keys)
    .first('id')
  if (!own) return []

  const rows = (await db(`${SIGNINS} as s`)
    .join(`${ENVS} as e`, 'e.id', 's.environment_id')
    .join(`${APPS} as a`, 'a.id', 'e.app_id')
    .whereIn('s.identity_key', keys)
    .where('e.key', envKey)
    .where('e.status', 'active')
    .select(
      'e.id as env_id',
      'e.key as env_key',
      'e.base_url as base_url',
      'a.key as app_key',
      'a.name as app_name'
    )) as Array<{
    env_id: number
    env_key: string
    base_url: string
    app_key: string
    app_name: string
  }>

  const seen = new Set<number>()
  const out: Array<SwitcherApp & { env_id: number }> = []
  for (const r of rows) {
    const envId = Number(r.env_id)
    if (seen.has(envId)) continue
    seen.add(envId)
    const origin = originOf(r.base_url)
    if (!origin) continue
    out.push({
      env_id: envId,
      app_key: String(r.app_key),
      app_name: String(r.app_name),
      environment_key: String(r.env_key),
      url: `${origin}/`,
      signin_url: `${origin}/api/auth/login?returnTo=%2F`,
      current: envId === Number(askingEnvId)
    })
  }
  out.sort((x, y) => x.app_name.localeCompare(y.app_name) || x.env_id - y.env_id)
  return out.map(({ env_id: _e, ...rest }) => rest)
}

/** Deletes rows not seen for SIGNIN_KEEP_DAYS; answers how many went. */
export async function pruneSignins(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - SIGNIN_KEEP_DAYS * 86_400_000)
  const n = await db(SIGNINS).where('last_seen', '<', cutoff).del()
  return Number(n) || 0
}
