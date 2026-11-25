import { createHash, timingSafeEqual } from 'node:crypto'
import type { Knex } from 'knex'
import { db } from '../../../db/index.js'
import { openSecret } from '../secrets.js'

/**
 * Hub ops (secret rotation helper): the previous hub token of an environment, kept SEALED for
 * PREV_HUB_TOKEN_GRACE_MS after the Hub rotates it (nivaro_hub_environments.hub_token_prev,
 * _prev_lookup = its SHA-256, _prev_until), the same pattern as a shared deployment's token.
 *
 * Until the app's stack runs the new token, or until a replica is replaced:
 *  - the Hub's own calls to the app (status, ops reads) try the current token first and, on a
 *    refusal, the previous one (status.ts / link-read.ts);
 *  - the app's calls to the Hub with the previous token are still accepted
 *    (link-token.ts environmentForLinkToken).
 * The grace ends at `_prev_until`, or earlier once the readiness check proves the new token
 * (clearPrevHubToken). Never returns or logs a token; reads answer the sealed value or null.
 *
 * Leaf module: imports no other hub token module (link-token.ts imports this one).
 */

export const PREV_HUB_TOKEN_GRACE_MS = 24 * 60 * 60_000
const ENVS = 'nivaro_hub_environments'

const sha256hex = (v: string) => createHash('sha256').update(String(v), 'utf8').digest('hex')
const sha256 = (v: string) => createHash('sha256').update(v, 'utf8').digest()

/** The columns that keep `sealed` (with its lookup) as the previous token until now + grace. */
export function prevHubTokenColumns(
  sealed: string | null,
  lookup: string | null,
  now = new Date()
): {
  hub_token_prev: string | null
  hub_token_prev_lookup: string | null
  hub_token_prev_until: Date | null
} {
  if (!sealed)
    return { hub_token_prev: null, hub_token_prev_lookup: null, hub_token_prev_until: null }
  return {
    hub_token_prev: sealed,
    hub_token_prev_lookup: lookup,
    hub_token_prev_until: new Date(now.getTime() + PREV_HUB_TOKEN_GRACE_MS)
  }
}

const untilOf = (v: unknown): number | null => {
  if (v == null) return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d.getTime()
}

async function hasGraceColumns(k: Knex): Promise<boolean> {
  try {
    return await k.schema.hasColumn(ENVS, 'hub_token_prev')
  } catch {
    return false
  }
}

/** The SEALED previous token while its grace lasts, else null (a DB before 568 has none). */
export async function prevSealedHubToken(envId: number, k: Knex = db): Promise<string | null> {
  if (!(await hasGraceColumns(k))) return null
  const row = (await k(ENVS)
    .where({ id: envId })
    .first('hub_token_prev', 'hub_token_prev_until')) as Record<string, unknown> | undefined
  const until = untilOf(row?.hub_token_prev_until)
  if (!row || until === null || until <= Date.now()) return null
  const sealed = row.hub_token_prev
  return typeof sealed === 'string' && sealed ? sealed : null
}

/** Ends the grace (the new token is proven, or the grace ran out). */
export async function clearPrevHubToken(envId: number, k: Knex = db): Promise<void> {
  if (!(await hasGraceColumns(k))) return
  await k(ENVS).where({ id: envId }).update(prevHubTokenColumns(null, null))
}

export type PrevFound = { environment_id: number; app_id: number; env_key: string; status: string }

/** The one environment whose PREVIOUS token (inside its grace) is `bearer`, else null. */
export async function environmentForPrevToken(
  bearer: string,
  k: Knex = db
): Promise<PrevFound | null> {
  if (typeof bearer !== 'string' || !bearer || bearer.length > 1024) return null
  if (!(await hasGraceColumns(k))) return null
  const rows = (await k(ENVS)
    .where({ hub_token_prev_lookup: sha256hex(bearer) })
    .select('id', 'app_id', 'key', 'status', 'hub_token_prev', 'hub_token_prev_until')) as Array<
    Record<string, unknown>
  >
  const now = Date.now()
  const matches = rows.filter((r) => {
    const until = untilOf(r.hub_token_prev_until)
    if (until === null || until <= now) return false
    let plain: string | null = null
    try {
      plain = openSecret((r.hub_token_prev as string | null) ?? null)
    } catch {
      plain = null
    }
    return !!plain && timingSafeEqual(sha256(plain), sha256(bearer))
  })
  if (matches.length !== 1) return null
  const r = matches[0]
  return {
    environment_id: Number(r.id),
    app_id: Number(r.app_id),
    env_key: String(r.key),
    status: String(r.status ?? 'active')
  }
}
