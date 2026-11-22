import { createHash, randomBytes } from 'node:crypto'
import { exportJWK, generateKeyPair, importJWK, type JWK } from 'jose'
import { config } from '../../../config.js'
import { db } from '../../../db/index.js'
import { HubSecretError, openSecret, sealSecret } from '../secrets.js'

/**
 * Nivaro Hub phase 7: the Hub's ID-token signing keys (ES256, plan Decision 10).
 *
 *  - Keys live in nivaro_hub_oidc_keys; the private JWK is sealed (sealSecret) and is opened only
 *    here, imported as a NON-extractable CryptoKey and never returned, logged or put in an error.
 *  - The active key is the newest row with retired_at null; none = one is created on first use
 *    (one per process at a time: concurrent first callers share one creation). Two Hub replicas
 *    racing can still each create one; both are published and the newest wins, which is harmless.
 *  - The JWKS publishes every non-retired key plus keys retired in the last 24 hours, so a token
 *    signed just before a rotation still verifies for as long as it can live.
 *
 * Hub-only (HUB=on, never cloud mode), so module state here is not shared between tenants.
 */

export const HUB_OIDC_ALG = 'ES256'
const MEMO_MS = 60_000
const RETIRED_GRACE_MS = 24 * 3_600_000

export type HubPublicJwk = JWK & { kid: string; alg: 'ES256'; use: 'sig' }

/** A key problem, worded without any key material (the cause is never attached). */
export class HubKeyError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'HubKeyError'
    this.code = code
  }
}

/** `<origin of PUBLIC_URL>/api/hub/oidc` — from config only, never from a request. */
export function hubIssuer(): string {
  return `${new URL(config.PUBLIC_URL).origin}/api/hub/oidc`
}

/** SHA-256 hex of a Hub session id: what tokens carry as `sid`, never the id itself. */
export function sidHash(sessionId: string): string {
  return createHash('sha256').update(String(sessionId)).digest('hex')
}

let memo: { kid: string; key: CryptoKey; at: number } | null = null
let pending: Promise<{ kid: string; key: CryptoKey }> | null = null

export function _resetHubKeysForTests(): void {
  memo = null
  pending = null
}

/** Only the public EC members, whatever else a stored row may hold. */
function publicMembers(raw: unknown): { kty: 'EC'; crv: 'P-256'; x: string; y: string } | null {
  if (!raw || typeof raw !== 'object') return null
  const j = raw as Record<string, unknown>
  if (j.kty !== 'EC' || j.crv !== 'P-256') return null
  if (typeof j.x !== 'string' || typeof j.y !== 'string' || !j.x || !j.y) return null
  return { kty: 'EC', crv: 'P-256', x: j.x, y: j.y }
}

function parseJson(text: string | null | undefined): unknown {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

const CREATE_FAILED = 'A Hub signing key could not be created.'

/** No ENCRYPTION_KEY: the Hub can neither seal a new signing key nor open a stored one. */
function needsEncryptionKey(): HubKeyError {
  return new HubKeyError(
    'HUB_NEEDS_ENCRYPTION_KEY',
    'Set ENCRYPTION_KEY (64 hex characters) before the Hub can create or use its sign-in signing keys.'
  )
}

/**
 * Runs a write that carries a sealed private key. knex rewrites a driver error as the SQL with
 * every binding inlined, so the error itself would hold the sealed key: it is replaced by a plain
 * HubKeyError with no cause.
 */
async function sealedWrite<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write()
  } catch {
    throw new HubKeyError('HUB_KEY_CREATE_FAILED', CREATE_FAILED)
  }
}

/** Opens and imports a stored private key. Every failure is a HubKeyError naming only the kid. */
async function importPrivate(kid: string, sealed: string): Promise<CryptoKey> {
  if (!process.env.ENCRYPTION_KEY) throw needsEncryptionKey()
  let opened: string | null = null
  try {
    opened = openSecret(sealed)
  } catch {
    throw new HubKeyError(
      'HUB_KEY_UNREADABLE',
      `Hub signing key ${kid} could not be opened (check ENCRYPTION_KEY).`
    )
  }
  const parsed = parseJson(opened)
  const pub = publicMembers(parsed)
  const d = parsed && typeof parsed === 'object' ? (parsed as { d?: unknown }).d : undefined
  if (!pub || typeof d !== 'string' || !d) {
    throw new HubKeyError('HUB_KEY_DAMAGED', `Hub signing key ${kid} is damaged.`)
  }
  try {
    const key = await importJWK({ ...pub, d }, HUB_OIDC_ALG, { extractable: false })
    if (key instanceof Uint8Array || key.type !== 'private') throw new Error('not a private key')
    return key as CryptoKey
  } catch {
    throw new HubKeyError('HUB_KEY_DAMAGED', `Hub signing key ${kid} is damaged.`)
  }
}

/** A fresh key pair as stored values; the private half only ever leaves this function sealed. */
async function newKeyRow(createdBy: string | null): Promise<Record<string, unknown>> {
  const kid = randomBytes(16).toString('base64url')
  const { publicKey, privateKey } = await generateKeyPair(HUB_OIDC_ALG, { extractable: true })
  const pub = publicMembers(await exportJWK(publicKey))
  const priv = await exportJWK(privateKey)
  if (!pub || typeof priv.d !== 'string')
    throw new HubKeyError('HUB_KEY_CREATE_FAILED', CREATE_FAILED)
  let sealed: string
  try {
    sealed = sealSecret(JSON.stringify({ ...pub, d: priv.d }))
  } catch (e) {
    if (e instanceof HubSecretError && e.code === 'HUB_NEEDS_ENCRYPTION_KEY')
      throw needsEncryptionKey()
    throw new HubKeyError('HUB_KEY_CREATE_FAILED', CREATE_FAILED)
  }
  return {
    kid,
    alg: HUB_OIDC_ALG,
    public_jwk: JSON.stringify(pub),
    private_jwk: sealed,
    created_by: createdBy,
    created_at: new Date(),
    retired_at: null
  }
}

async function newestActiveRow(): Promise<{ kid: string; private_jwk: string } | undefined> {
  return db('nivaro_hub_oidc_keys')
    .select('kid', 'private_jwk')
    .whereNull('retired_at')
    .orderBy('id', 'desc')
    .first()
}

async function loadActive(): Promise<{ kid: string; key: CryptoKey }> {
  let row = await newestActiveRow()
  if (!row) {
    const fresh = await newKeyRow(null)
    try {
      await sealedWrite(() => db('nivaro_hub_oidc_keys').insert(fresh))
    } catch (e) {
      // A replica that created one at the same moment (or any refused insert): use what is there.
      if (!(await newestActiveRow().catch(() => undefined))) throw e
    }
    // Read back the newest: a replica that created one at the same moment converges on it.
    row = await newestActiveRow()
    if (!row) throw new HubKeyError('HUB_KEY_CREATE_FAILED', CREATE_FAILED)
  }
  const key = await importPrivate(row.kid, row.private_jwk)
  return { kid: row.kid, key }
}

/** The key new tokens are signed with (newest non-retired; created on first use). Memo 60 s. */
export async function activeSigningKey(): Promise<{ kid: string; key: CryptoKey }> {
  if (memo && Date.now() - memo.at < MEMO_MS) return { kid: memo.kid, key: memo.key }
  if (!pending) {
    const p = loadActive()
      .then((k) => {
        if (pending === p) memo = { ...k, at: Date.now() }
        return k
      })
      .finally(() => {
        if (pending === p) pending = null
      })
    pending = p
  }
  const k = await pending
  return { kid: k.kid, key: k.key }
}

/** The public keys apps verify with: non-retired ones plus those retired in the last 24 h. */
export async function publishedJwks(now: Date = new Date()): Promise<{ keys: HubPublicJwk[] }> {
  const cutoff = new Date(now.getTime() - RETIRED_GRACE_MS)
  const rows: Array<{ kid: string; public_jwk: string }> = await db('nivaro_hub_oidc_keys')
    .select('kid', 'public_jwk')
    .where((q) => q.whereNull('retired_at').orWhere('retired_at', '>', cutoff))
    .orderBy('id', 'desc')
  const keys: HubPublicJwk[] = []
  for (const r of rows) {
    const pub = publicMembers(parseJson(r.public_jwk))
    if (pub) keys.push({ ...pub, kid: r.kid, alg: 'ES256', use: 'sig' })
  }
  return { keys }
}

/**
 * A new key signs from now on; every OLDER non-retired key is retired (still published 24 h).
 * Older = lower id, so two rotations at once never retire each other's new key: the newest wins.
 */
export async function rotateSigningKey(userId: string): Promise<{ kid: string }> {
  const row = await newKeyRow(userId || null)
  const kid = row.kid as string
  await sealedWrite(() =>
    db.transaction(async (trx) => {
      await trx('nivaro_hub_oidc_keys').insert(row)
      const created = await trx('nivaro_hub_oidc_keys').where({ kid }).first('id')
      const id = Number(created?.id)
      if (!Number.isFinite(id)) throw new Error('new key row not found')
      await trx('nivaro_hub_oidc_keys')
        .whereNull('retired_at')
        .where('id', '<', id)
        .update({ retired_at: new Date() })
    })
  )
  memo = null
  pending = null
  return { kid }
}

function isoOf(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString()
}

/** Every key for the admin list, newest first; nothing private. */
export async function listSigningKeys(): Promise<
  Array<{
    kid: string
    alg: string
    created_at: string
    retired_at: string | null
    active: boolean
  }>
> {
  const rows: Array<{
    id: number
    kid: string
    alg: string
    created_at: unknown
    retired_at: unknown
  }> = await db('nivaro_hub_oidc_keys')
    .select('id', 'kid', 'alg', 'created_at', 'retired_at')
    .orderBy('id', 'desc')
  const activeKid = rows.find((r) => r.retired_at === null || r.retired_at === undefined)?.kid
  return rows.map((r) => ({
    kid: r.kid,
    alg: r.alg,
    created_at: isoOf(r.created_at) ?? '',
    retired_at: isoOf(r.retired_at),
    active: r.kid === activeKid
  }))
}
