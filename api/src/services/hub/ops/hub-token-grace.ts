import { createHash, timingSafeEqual } from 'node:crypto'
import type { Knex } from 'knex'
import { db } from '../../../db/index.js'
import { openSecret } from '../secrets.js'

/**
 * Hub ops (secret rotation helper): the previous hub token of an environment, kept SEALED for
 * PREV_HUB_TOKEN_GRACE_MS after the Hub rotates it (nivaro_hub_environments.hub_token_prev,
 * _prev_lookup = its SHA-256, _prev_until), the same pattern as a shared deployment's token.
 *
 * Until the app's stack runs the new token:
 *  - the Hub's own calls to the app (status, ops reads) try the current token first and, on a
 *    refusal, the previous one (status.ts / link-read.ts);
 *  - the app's calls to the Hub with the previous token are still accepted
 *    (link-token.ts environmentForLinkToken).
 *
 * The grace is BOUND to what the rotation left behind (security review): `_prev_for` = the
 * lookup of the token the rotation wrote, `_prev_origin` = the environment's origin then. It is
 * honoured only while the environment still holds exactly that token (any other write — an
 * admin typing a token, clearing it, a later rotation — ends it at once, whatever path wrote it)
 * and still has that origin (the previous token is never sent to a changed address). A grace
 * found broken is cleared. It also ends at `_prev_until`, or once the readiness check proves the
 * new token (clearPrevHubToken). Never returns or logs a token; reads answer the sealed value.
 *
 * Leaf module: imports no other hub token module (link-token.ts imports this one).
 */

export const PREV_HUB_TOKEN_GRACE_MS = 24 * 60 * 60_000
const ENVS = 'nivaro_hub_environments'

const sha256hex = (v: string) => createHash('sha256').update(String(v), 'utf8').digest('hex')
const sha256 = (v: string) => createHash('sha256').update(v, 'utf8').digest()

/** The origin of a base URL (scheme + host + port), or null. */
export function originOf(raw: unknown): string | null {
  try {
    const u = new URL(String(raw ?? '').trim())
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.origin
  } catch {
    return null
  }
}

export interface PrevTokenColumns {
  hub_token_prev: string | null
  hub_token_prev_lookup: string | null
  hub_token_prev_until: Date | null
  hub_token_prev_for: string | null
  hub_token_prev_origin: string | null
}

/**
 * The columns that keep `prev` (the old sealed token and its lookup) for the grace, bound to the
 * token now written (`forLookup`) and the environment's origin; `null` clears them all.
 */
export function prevHubTokenColumns(
  prev: { sealed: string | null; lookup: string | null } | null,
  bind: { forLookup: string | null; baseUrl: string } | null = null,
  now = new Date()
): PrevTokenColumns {
  const origin = bind ? originOf(bind.baseUrl) : null
  if (!prev?.sealed || !prev.lookup || !bind?.forLookup || !origin)
    return {
      hub_token_prev: null,
      hub_token_prev_lookup: null,
      hub_token_prev_until: null,
      hub_token_prev_for: null,
      hub_token_prev_origin: null
    }
  return {
    hub_token_prev: prev.sealed,
    hub_token_prev_lookup: prev.lookup,
    hub_token_prev_until: new Date(now.getTime() + PREV_HUB_TOKEN_GRACE_MS),
    hub_token_prev_for: bind.forLookup,
    hub_token_prev_origin: origin
  }
}

const untilOf = (v: unknown): number | null => {
  if (v == null) return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d.getTime()
}

async function hasGraceColumns(k: Knex): Promise<boolean> {
  try {
    return await k.schema.hasColumn(ENVS, 'hub_token_prev_for')
  } catch {
    return false
  }
}

const GRACE_COLS = [
  'id',
  'app_id',
  'key',
  'status',
  'base_url',
  'hub_token',
  'hub_token_lookup',
  'hub_token_prev',
  'hub_token_prev_until',
  'hub_token_prev_for',
  'hub_token_prev_origin'
]

/** Whether a row's grace is still honoured (see the header). */
export function graceHolds(r: Record<string, unknown>, now = Date.now()): boolean {
  const until = untilOf(r.hub_token_prev_until)
  if (until === null || until <= now) return false
  if (typeof r.hub_token_prev !== 'string' || !r.hub_token_prev) return false
  // The environment must still hold exactly the token the rotation wrote…
  if (typeof r.hub_token !== 'string' || !r.hub_token) return false
  if (!r.hub_token_lookup || r.hub_token_lookup !== r.hub_token_prev_for) return false
  // …at the address it had then.
  const origin = originOf(r.base_url)
  return !!origin && origin === r.hub_token_prev_origin
}

/** A grace with something in it that no longer holds is cleared (best-effort). */
async function clearIfBroken(r: Record<string, unknown>, k: Knex): Promise<void> {
  if (r.hub_token_prev == null || graceHolds(r)) return
  await k(ENVS)
    .where({ id: r.id })
    .update(prevHubTokenColumns(null))
    .catch(() => undefined)
}

/**
 * The SEALED previous token while its grace holds, else null (a DB before 568 has none).
 * `origin`: the address the caller is about to send it to — it must be the grace's own.
 */
export async function prevSealedHubToken(
  envId: number,
  opts: { origin?: string | null } = {},
  k: Knex = db
): Promise<string | null> {
  if (!(await hasGraceColumns(k))) return null
  const row = (await k(ENVS).where({ id: envId }).first(GRACE_COLS)) as
    | Record<string, unknown>
    | undefined
  if (!row) return null
  if (!graceHolds(row)) {
    await clearIfBroken(row, k)
    return null
  }
  if (opts.origin !== undefined && originOf(opts.origin) !== row.hub_token_prev_origin) return null
  return row.hub_token_prev as string
}

/** Ends the grace (the new token is proven, or the grace ran out). */
export async function clearPrevHubToken(envId: number, k: Knex = db): Promise<void> {
  if (!(await hasGraceColumns(k))) return
  await k(ENVS).where({ id: envId }).update(prevHubTokenColumns(null))
}

export type PrevFound = { environment_id: number; app_id: number; env_key: string; status: string }

/** The one environment whose PREVIOUS token (inside a grace that holds) is `bearer`, else null. */
export async function environmentForPrevToken(
  bearer: string,
  k: Knex = db
): Promise<PrevFound | null> {
  if (typeof bearer !== 'string' || !bearer || bearer.length > 1024) return null
  if (!(await hasGraceColumns(k))) return null
  const rows = (await k(ENVS)
    .where({ hub_token_prev_lookup: sha256hex(bearer) })
    .select(GRACE_COLS)) as Array<Record<string, unknown>>
  const matches: Array<Record<string, unknown>> = []
  for (const r of rows) {
    if (!graceHolds(r)) {
      await clearIfBroken(r, k)
      continue
    }
    let plain: string | null = null
    try {
      plain = openSecret(r.hub_token_prev as string)
    } catch {
      plain = null
    }
    if (plain && timingSafeEqual(sha256(plain), sha256(bearer))) matches.push(r)
  }
  if (matches.length !== 1) return null
  const r = matches[0]
  return {
    environment_id: Number(r.id),
    app_id: Number(r.app_id),
    env_key: String(r.key),
    status: String(r.status ?? 'active')
  }
}
