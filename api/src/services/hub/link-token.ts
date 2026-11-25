import { createHash, timingSafeEqual } from 'node:crypto'
import { db } from '../../db/index.js'
import { errorTag } from '../../lib/error-tag.js'
import { environmentForPrevToken } from './ops/hub-token-grace.js'
import { HUB_MASK, openSecret, sealSecret } from './secrets.js'

/**
 * Nivaro Hub phase 7 (plan Decision 13): which environment an app-link bearer belongs to.
 *
 * An app authenticates to the Hub with its environment's hub token (HUB_TOKEN on the app). The
 * Hub stores that token sealed, so it cannot be searched for; `hub_token_lookup` holds its
 * SHA-256 hex, a one-way key (never the token, never reversible). A hit is then confirmed by
 * opening the sealed token and comparing timing-safe, so a stale lookup (the token changed by an
 * older replica) or an unreadable seal never lets a request through.
 *
 * One token, one environment: hub.ts refuses a token another environment already uses (409
 * TOKEN_IN_USE), and a bearer that still confirms on more than one row (rows saved before that
 * check) names no environment at all.
 *
 * Every writer of a hub token (environment create/patch, app creation, the first stack-settings
 * save) stores it through hubTokenColumns(), which writes the sealed token and its lookup
 * together (ruling X-4), so an app's first call finds it at once.
 *
 * As a backstop, on the first miss in a process the lookups are repaired once: every row whose lookup is
 * missing (saved before migration 551) or differs from the hash of its sealed token (written by
 * an older replica) gets the right one, a cleared token loses its lookup; then the lookup is
 * retried.
 *
 * Hub-only (HUB=on, never cloud mode), so module state here is not shared between tenants.
 */

const ENVS = 'nivaro_hub_environments'
/** Longer than any token anyone would type; refuses junk before any hashing or query. */
const MAX_TOKEN_LENGTH = 1024

/** SHA-256 hex of a hub token: what `hub_token_lookup` holds. */
export function tokenLookupHash(token: string): string {
  return createHash('sha256').update(String(token), 'utf8').digest('hex')
}

/**
 * The ONE way to write an environment's hub token (ruling X-4): the sealed token and its lookup,
 * always together. A plain token → sealed + SHA-256 lookup; null or '' → both cleared. Spread the
 * answer into the row's insert or update.
 */
export function hubTokenColumns(plain: string | null): {
  hub_token: string | null
  hub_token_lookup: string | null
} {
  if (typeof plain !== 'string' || plain === '') return { hub_token: null, hub_token_lookup: null }
  return { hub_token: sealSecret(plain), hub_token_lookup: tokenLookupHash(plain) }
}

function sha256(v: string): Buffer {
  return createHash('sha256').update(v, 'utf8').digest()
}

/** The sealed token in plain, or null when there is none or it cannot be opened. */
function opened(sealed: string | null): string | null {
  try {
    return openSecret(sealed)
  } catch {
    return null
  }
}

/** True when the sealed token opens and equals `presented` (timing-safe over both hashes). */
function sealedTokenMatches(sealed: string | null, presented: string): boolean {
  const plain = opened(sealed)
  if (!plain) return false
  return timingSafeEqual(sha256(plain), sha256(presented))
}

let backfill: Promise<void> | null = null
let backfilled = false

export function _resetLinkTokenForTests(): void {
  backfill = null
  backfilled = false
}

/**
 * Makes every lookup match its sealed token: missing or stale ones are rewritten, a cleared
 * token's lookup is removed. An unreadable seal is left alone (it never matches anyway). Each
 * write is conditioned on the lookup it read (never on the sealed token: knex inlines bindings
 * into its error messages, so a failed write would carry the sealed token into the logs), so a
 * concurrent token write, which writes its own lookup, wins. A stale lookup left by a racing
 * older replica only ever fails closed (byLookup confirms against the sealed token).
 */
async function repairLookups(): Promise<void> {
  try {
    await rewriteLookups()
  } catch (e) {
    throw repairFailed(e)
  }
}

/** A failed repair: a fixed log line with the engine's code, and a generic error (no cause). */
function repairFailed(e: unknown): Error {
  // biome-ignore lint/suspicious/noConsole: the failure must reach the server log (fixed text)
  console.error(`hub: repairing hub token lookups failed (${errorTag(e)})`)
  return new Error('Repairing hub token lookups failed')
}

async function rewriteLookups(): Promise<void> {
  await db(ENVS)
    .whereNull('hub_token')
    .whereNotNull('hub_token_lookup')
    .update({ hub_token_lookup: null })
  const rows = (await db(ENVS)
    .whereNotNull('hub_token')
    .select('id', 'hub_token', 'hub_token_lookup')) as Array<{
    id: number
    hub_token: string
    hub_token_lookup: string | null
  }>
  for (const r of rows) {
    const plain = opened(r.hub_token)
    if (!plain) continue
    const want = tokenLookupHash(plain)
    if (r.hub_token_lookup === want) continue
    const q = db(ENVS).where({ id: r.id })
    if (r.hub_token_lookup == null) q.whereNull('hub_token_lookup')
    else q.where({ hub_token_lookup: r.hub_token_lookup })
    await q.update({ hub_token_lookup: want })
  }
}

/** The repair, at most once per process; callers during a run share it (a failed run may be
 *  tried again). */
function repairOnce(): Promise<void> {
  if (!backfill)
    backfill = repairLookups().then(
      () => {
        backfilled = true
      },
      (e) => {
        backfill = null
        throw e
      }
    )
  return backfill
}

type Found = { environment_id: number; app_id: number; env_key: string; status: string }

/** The one environment whose sealed token is `bearer`; null for none or for more than one. */
async function byLookup(bearer: string): Promise<Found | null> {
  const rows = (await db(ENVS)
    .where({ hub_token_lookup: tokenLookupHash(bearer) })
    .select('id', 'app_id', 'key', 'status', 'hub_token')) as Array<{
    id: number
    app_id: number
    key: string
    status: string | null
    hub_token: string | null
  }>
  const matches = rows.filter((r) => sealedTokenMatches(r.hub_token, bearer))
  if (matches.length !== 1) return null
  const r = matches[0]
  return {
    environment_id: Number(r.id),
    app_id: Number(r.app_id),
    env_key: String(r.key),
    status: String(r.status ?? 'active')
  }
}

/**
 * The environment whose hub token is `bearer`, or null. Never logs or returns the token.
 * Callers rate-limit failures (failedAuthLimiter) like routes/hub-link.ts.
 */
export async function environmentForLinkToken(bearer: string): Promise<Found | null> {
  if (typeof bearer !== 'string' || !bearer || bearer.length > MAX_TOKEN_LENGTH) return null
  const found = await byLookup(bearer)
  if (found) return found
  // Hub ops: the previous token, for 24 h after the Hub rotated it (ops/hub-token-grace.ts).
  const prev = await environmentForPrevToken(bearer).catch(() => null)
  if (prev) return prev
  if (backfilled) return null
  await repairOnce()
  return byLookup(bearer)
}

/**
 * True when `token` (as sent to an environment write) is a new token another environment
 * already holds. Absent, empty, non-text and the mask are never "in use" (they write no token).
 */
export async function linkTokenInUse(token: unknown, exceptEnvId: number | null): Promise<boolean> {
  if (typeof token !== 'string' || !token || token === HUB_MASK) return false
  const q = db(ENVS).where({ hub_token_lookup: tokenLookupHash(token) })
  if (exceptEnvId !== null) q.whereNot({ id: exceptEnvId })
  return !!(await q.first('id'))
}
