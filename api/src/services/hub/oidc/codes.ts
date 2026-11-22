import type { Redis } from 'ioredis'
import { hashToken, randomToken } from '../../../lib/oauth.js'
import { currentTenantKey } from '../../tenant-rooms.js'
import { openSecret, sealSecret } from '../secrets.js'
import type { HubEvidence } from './tokens.js'

/**
 * Nivaro Hub phase 7: authorization codes for the Hub's OpenID provider (plan Decision 8).
 *
 * Redis only, by hash (`nvr:hub-oidc:code:<hashToken(code)>`), 60 seconds, single use: the
 * record is read with GETDEL before any check, so a redemption that fails for any reason (wrong
 * client, wrong verifier, wrong redirect_uri) still burns the code. Each record carries the
 * tenant it was made in (the oauth-store pattern) and is refused anywhere else, and it carries
 * its own issue time so a code past 60 s is refused even if Redis kept it. The record holds the
 * person's Entra evidence and their Hub session id, so it is sealed (sealSecret, ENCRYPTION_KEY,
 * which the Hub needs for its signing keys anyway): the Redis key browser and a Redis dump show
 * ciphertext only.
 */

const P = 'nvr:hub-oidc:code:'
export const CODE_TTL_S = 60
/** Codes are 32 random bytes base64url (43 characters); anything far longer is not one. */
const MAX_CODE_CHARS = 128

export interface CodeRecord {
  client_id: string
  redirect_uri: string
  code_challenge: string
  nonce: string
  user_id: string
  /** The Hub session id (the token carries only its SHA-256, never this). */
  sid: string
  evidence: HubEvidence
  issued_at: number
}

type Stored = CodeRecord & { t: string }

export async function issueCode(redis: Redis, rec: CodeRecord): Promise<string> {
  const code = randomToken()
  const stored: Stored = { ...rec, t: currentTenantKey() }
  await redis.setex(`${P}${hashToken(code)}`, CODE_TTL_S, sealSecret(JSON.stringify(stored)))
  return code
}

/** The code's record, deleted as it is read; null when unknown, spent, expired or foreign. */
export async function takeCode(
  redis: Redis,
  code: unknown,
  now = Date.now()
): Promise<CodeRecord | null> {
  if (typeof code !== 'string' || !code || code.length > MAX_CODE_CHARS) return null
  const raw = await redis.getdel(`${P}${hashToken(code)}`)
  if (!raw) return null
  let rec: Stored
  try {
    rec = JSON.parse(openSecret(raw) ?? '') as Stored
  } catch {
    return null
  }
  if (!rec || rec.t !== currentTenantKey()) return null
  if (!Number.isFinite(rec.issued_at) || now - rec.issued_at > CODE_TTL_S * 1000) return null
  const { t: _t, ...out } = rec
  return out
}
