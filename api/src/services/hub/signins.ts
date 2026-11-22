import { db } from '../../db/index.js'
import { errorTag } from '../../lib/error-tag.js'
import { isUniqueViolation } from '../../lib/unique-violation.js'
import { whereInList } from '../db-batch.js'

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
 * The switcher answers an app only about a person the Hub itself recorded on THAT environment
 * (a `via = 'hub'` row; app reports never prove anyone, ruling P7-8), and lists only that
 * person's environments with the same key (production lists production), status `active`.
 * Links are the target app's own sign-in, never a code, token or email.
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
        .whereRaw('LOWER(TRIM(email)) = ?', [email])
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

/** A direct report moves a row on at most once per this long (Decision 12). */
export const DIRECT_REFRESH_MS = 6 * 3_600_000

/**
 * One row per identity key for this environment. A new key is inserted; an existing one:
 *
 *   via 'hub'     (the Hub redeemed a code: proven)  last_seen, via = 'hub', app_id, and
 *                 hub_user_id / email when known — a direct row is promoted
 *   via 'direct'  (an app's report: asserted)       never touches a Hub row's via, email or
 *                 hub_user_id (only its last_seen); a direct row's fields move on. Either way
 *                 only when last_seen is DIRECT_REFRESH_MS old or more.
 *
 * `via` only ever moves up to 'hub'. Idempotent; no usable identity = nothing written.
 * Answers how many NEW rows were inserted (the app link's daily cap counts them).
 */
export async function recordSignin(input: RecordSigninInput): Promise<{ inserted: number }> {
  const keys = identityKeys(input)
  if (!keys.length) return { inserted: 0 }
  const environmentId = Number(input.environment_id)
  const appId = Number(input.app_id)
  if (!Number.isInteger(environmentId) || !Number.isInteger(appId)) return { inserted: 0 }
  const via = input.via === 'hub' ? 'hub' : 'direct'
  const at = input.at ?? new Date()
  const hubUserId = input.hub_user_id ? String(input.hub_user_id) : await resolveHubUser(input)
  const email = cleanEmail(input.email)
  const staleBefore = new Date(at.getTime() - DIRECT_REFRESH_MS)
  let inserted = 0

  for (const identity_key of keys) {
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
        inserted++
        continue
      } catch (e) {
        if (!isUniqueViolation(e)) throw e
      }
      const row = () => db(SIGNINS).where({ identity_key, environment_id: environmentId })
      const fields: Record<string, unknown> = { last_seen: at, app_id: appId }
      if (hubUserId) fields.hub_user_id = hubUserId
      if (email) fields.email = email
      if (via === 'hub') {
        await row().update({ ...fields, via: 'hub' })
        continue
      }
      const stale = (q: ReturnType<typeof row>) =>
        q.where((w) => w.whereNull('last_seen').orWhere('last_seen', '<', staleBefore))
      // A Hub row: an app's report only says "seen again".
      await stale(row().where({ via: 'hub' })).update({ last_seen: at })
      // A direct row follows what the report resolves to NOW: an email that has since become
      // shared (a twin account) resolves to nobody, and the old owner is cleared.
      await stale(row().whereNot({ via: 'hub' })).update({
        ...fields,
        hub_user_id: hubUserId,
        via: 'direct'
      })
    } catch (e) {
      throw writeFailed(e)
    }
  }
  return { inserted }
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
 * `envKey`). Ruling P7-8: the person must be PROVEN on the asking environment — a row the Hub
 * itself wrote there (`via = 'hub'`, a redeemed code) matching one of the asked keys. App
 * reports never count. All matching Hub rows must name the same Hub account (asked keys that
 * point at two people answer nothing).
 *
 * The listing is then built from THAT person only — rows carrying their hub_user_id, plus rows
 * under the identity keys of their own Hub-recorded rows — never from the raw asked keys. Every
 * active environment with the same key where they have a row, the asking one `current`, sorted
 * by app name.
 */
export async function switcherFor(
  envKey: string,
  askingEnvId: number,
  who: SigninWho
): Promise<SwitcherApp[]> {
  const keys = identityKeys(who)
  if (!keys.length || typeof envKey !== 'string' || !envKey) return []
  const hubRows = (await db(SIGNINS)
    .where({ environment_id: askingEnvId, via: 'hub' })
    .whereIn('identity_key', keys)
    .select('identity_key', 'hub_user_id')) as Array<{
    identity_key: string
    hub_user_id: string | null
  }>
  // An Entra key proves its row's account. An email key proves it only when the email is that
  // account's alone (emails are not unique; the last account to redeem owns a shared email row).
  const proven: string[] = []
  for (const r of hubRows) {
    const owner = r.hub_user_id ? String(r.hub_user_id) : ''
    if (!owner) return []
    const key = String(r.identity_key)
    if (key.startsWith('email:') && !(await emailTheirsAlone(key, owner))) continue
    proven.push(owner)
  }
  const people = new Set(proven)
  if (people.size !== 1) return []
  const personId = [...people][0]

  const personKeys = await ownKeys(personId)

  const rows = (await db(`${SIGNINS} as s`)
    .join(`${ENVS} as e`, 'e.id', 's.environment_id')
    .join(`${APPS} as a`, 'a.id', 'e.app_id')
    .where((w) => {
      // Their account's rows: Hub rows and Entra-keyed rows; a direct row under an email only
      // while that email is still theirs alone (a twin account appearing since takes it away).
      w.where((own) =>
        own.where('s.hub_user_id', personId).where((k) => {
          k.where('s.via', 'hub').orWhereNot('s.identity_key', 'like', 'email:%')
          const emails = personKeys.filter((x) => x.startsWith('email:'))
          if (emails.length) k.orWhereIn('s.identity_key', emails)
        })
      )
      // A row under one of their keys counts only when it belongs to nobody else: a Hub update
      // names its account, and emails are not unique.
      if (personKeys.length)
        w.orWhere((k) =>
          k
            .whereIn('s.identity_key', personKeys)
            .where((o) => o.whereNull('s.hub_user_id').orWhere('s.hub_user_id', personId))
        )
    })
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

/**
 * The identity keys of a person's own Hub-recorded rows, less any `email:` key that is not
 * theirs alone (emailTheirsAlone). A failed check drops the email key (fails closed).
 */
async function ownKeys(personId: string): Promise<string[]> {
  const keys = (
    (await db(SIGNINS)
      .where({ hub_user_id: personId, via: 'hub' })
      .distinct('identity_key')) as Array<{ identity_key: string }>
  ).map((r) => String(r.identity_key))
  const out: string[] = []
  for (const key of keys) {
    if (key.startsWith('email:') && !(await emailTheirsAlone(key, personId))) continue
    out.push(key)
  }
  return out
}

const sameId = (a: unknown, b: unknown) => String(a).toUpperCase() === String(b).toUpperCase()

/**
 * True when the `email:` key belongs to `personId` alone: exactly one Hub account holds the email
 * (case-insensitive, surrounding spaces ignored) and it is `personId`, and the Hub recorded the
 * key for no other account. Any read failure answers false (fails closed).
 */
async function emailTheirsAlone(key: string, personId: string): Promise<boolean> {
  try {
    const email = key.slice('email:'.length).trim().toLowerCase()
    if (!email) return false
    const accounts = (await db('nivaro_users')
      .whereRaw('LOWER(TRIM(email)) = ?', [email])
      .limit(2)
      .select('id')) as Array<{ id: string }>
    if (accounts.length !== 1 || !sameId(accounts[0].id, personId)) return false
    const others = (await db(SIGNINS)
      .where({ identity_key: key })
      .whereNotNull('hub_user_id')
      .distinct('hub_user_id')) as Array<{ hub_user_id: string }>
    return others.every((r) => sameId(r.hub_user_id, personId))
  } catch {
    return false
  }
}

/** Rows per prune statement: under every engine's bound-parameter cap (SQL Server ~2100). */
const PRUNE_BATCH = 1000

/**
 * Deletes rows not seen for SIGNIN_KEEP_DAYS, in batches of at most `batch` ids per statement
 * (read ids, delete them, repeat), so a large backlog never becomes one long locking statement.
 * Answers how many went.
 */
export async function pruneSignins(
  now: Date = new Date(),
  opts: { batch?: number } = {}
): Promise<number> {
  const batch = Math.max(1, Math.min(opts.batch ?? PRUNE_BATCH, PRUNE_BATCH))
  const cutoff = new Date(now.getTime() - SIGNIN_KEEP_DAYS * 86_400_000)
  let total = 0
  for (;;) {
    const ids = (
      (await db(SIGNINS)
        .where('last_seen', '<', cutoff)
        .orderBy('id')
        .limit(batch)
        .select('id')) as Array<{ id: number }>
    ).map((r) => Number(r.id))
    if (!ids.length) break
    total += Number(await whereInList(db(SIGNINS), 'id', ids).del()) || 0
    if (ids.length < batch) break
  }
  return total
}
