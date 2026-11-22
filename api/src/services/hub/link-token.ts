import { createHash, timingSafeEqual } from 'node:crypto'
import { db } from '../../db/index.js'
import { openSecret } from './secrets.js'

/**
 * Nivaro Hub phase 7 (plan Decision 13): which environment an app-link bearer belongs to.
 *
 * An app authenticates to the Hub with its environment's hub token (HUB_TOKEN on the app). The
 * Hub stores that token sealed, so it cannot be searched for; `hub_token_lookup` holds its
 * SHA-256 hex, a one-way key (never the token, never reversible). A hit is then confirmed by
 * opening the sealed token and comparing timing-safe, so a stale lookup (the token changed by an
 * older replica) or an unreadable seal never lets a request through.
 *
 * Rows saved before migration 551 have no lookup: on the first miss in a process they are
 * backfilled once (open each sealed token, store its hash), then the lookup is retried.
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

function sha256(v: string): Buffer {
  return createHash('sha256').update(v, 'utf8').digest()
}

/** True when the sealed token opens and equals `presented` (timing-safe over both hashes). */
function sealedTokenMatches(sealed: string | null, presented: string): boolean {
  let plain: string | null
  try {
    plain = openSecret(sealed)
  } catch {
    return false
  }
  if (!plain) return false
  return timingSafeEqual(sha256(plain), sha256(presented))
}

let backfill: Promise<void> | null = null
let backfilled = false

export function _resetLinkTokenForTests(): void {
  backfill = null
  backfilled = false
}

/** Stores the lookup of every sealed token that has none. An unreadable seal is skipped. */
async function backfillLookups(): Promise<void> {
  const rows = (await db(ENVS)
    .whereNotNull('hub_token')
    .whereNull('hub_token_lookup')
    .select('id', 'hub_token')) as Array<{ id: number; hub_token: string | null }>
  for (const r of rows) {
    let plain: string | null
    try {
      plain = openSecret(r.hub_token)
    } catch {
      continue
    }
    if (!plain) continue
    // Only fills a lookup that is still empty: a concurrent token write is never overwritten.
    await db(ENVS)
      .where({ id: r.id })
      .whereNull('hub_token_lookup')
      .update({ hub_token_lookup: tokenLookupHash(plain) })
  }
}

/** The backfill, at most once per process; callers during a run share it (a failed run may be
 *  tried again). */
function backfillOnce(): Promise<void> {
  if (!backfill)
    backfill = backfillLookups().then(
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

type Found = { environment_id: number; app_id: number; env_key: string }

async function byLookup(bearer: string): Promise<Found | null> {
  const rows = (await db(ENVS)
    .where({ hub_token_lookup: tokenLookupHash(bearer) })
    .select('id', 'app_id', 'key', 'hub_token')) as Array<{
    id: number
    app_id: number
    key: string
    hub_token: string | null
  }>
  for (const r of rows)
    if (sealedTokenMatches(r.hub_token, bearer))
      return { environment_id: Number(r.id), app_id: Number(r.app_id), env_key: String(r.key) }
  return null
}

/**
 * The environment whose hub token is `bearer`, or null. Never logs or returns the token.
 * Callers rate-limit failures (failedAuthLimiter) like routes/hub-link.ts.
 */
export async function environmentForLinkToken(bearer: string): Promise<Found | null> {
  if (typeof bearer !== 'string' || !bearer || bearer.length > MAX_TOKEN_LENGTH) return null
  const found = await byLookup(bearer)
  if (found) return found
  if (backfilled) return null
  await backfillOnce()
  return byLookup(bearer)
}
