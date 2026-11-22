import { createHash, randomBytes, type webcrypto } from 'node:crypto'
import { exportJWK, generateKeyPair, importJWK, type JWK } from 'jose'
import type { Knex } from 'knex'
import { config } from '../../../config.js'
import { db } from '../../../db/index.js'
import { HubSecretError, openSecret, sealSecret } from '../secrets.js'

/** The API's tsconfig has no DOM lib: Node's WebCrypto key type. */
type CryptoKey = webcrypto.CryptoKey

/**
 * Nivaro Hub phase 7: the Hub's ID-token signing keys (ES256, plan Decision 10).
 *
 *  - Keys live in nivaro_hub_oidc_keys; the private JWK is sealed (sealSecret) and is opened only
 *    here, imported as a NON-extractable CryptoKey and never returned, logged or put in an error.
 *  - Publish before signing (P7-14): apps cache the JWKS 5 minutes, so a rotated key is published
 *    at once but signs only once it has been published 6 minutes (PUBLISH_BEFORE_SIGN_MS). No
 *    extra column: "published at" is created_at, and the key it replaces gets retired_at = that
 *    hand-over time (a time still to come). The signing key is derived from the rows alone
 *    (signerOf), so every replica agrees; each one reads them through its ≤ 60 s memo.
 *  - A first-ever key (none usable) is created on first use and signs at once (one per process at
 *    a time; two replicas racing each create one, the older hands over to the newer 6 min later).
 *  - The JWKS publishes every live key plus keys retired in the last 24 hours: a replaced key
 *    stays published 24 h after its successor STARTED signing.
 *  - removeSigningKey drops a (compromised) key from the JWKS and from signing at once.
 *
 * Hub-only (HUB=on, never cloud mode), so module state here is not shared between tenants.
 */

export const HUB_OIDC_ALG = 'ES256'
const MEMO_MS = 60_000
const RETIRED_GRACE_MS = 24 * 3_600_000
/** A new key is published this long before it signs: the apps' 5-minute JWKS cache + 1 min. */
export const PUBLISH_BEFORE_SIGN_MS = 6 * 60_000

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

let memo: { kid: string; key: CryptoKey; until: number } | null = null
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

type KeyRow = { id: number; kid: string; created_at: unknown; retired_at: unknown }

/** A stored timestamp as epoch ms (a Date, epoch ms, or text; text without a zone is UTC). */
function msOf(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.getTime()
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const t = String(v).trim()
  const zoned = /([zZ]|[+-]\d\d:?\d\d)$/.test(t) || !/\d\d:\d\d/.test(t)
  const ms = Date.parse(zoned ? t : `${t.replace(' ', 'T')}Z`)
  return Number.isNaN(ms) ? null : ms
}

/** Live = still in the signing line-up: not retired, or retiring at a time still to come. */
function isLive(r: KeyRow, now: number): boolean {
  const ret = msOf(r.retired_at)
  return ret === null || ret > now
}

/** When a key may start signing: once it has been published PUBLISH_BEFORE_SIGN_MS. */
function startOf(r: KeyRow): number {
  return (msOf(r.created_at) ?? 0) + PUBLISH_BEFORE_SIGN_MS
}

/**
 * The key that signs at `now`, from the rows alone (every replica reaches the same answer):
 * the newest live key published at least 6 minutes; when no live key is that old (a first-ever
 * key, or a removal left only young keys), the live key published longest.
 */
function signerOf(rows: KeyRow[], now: number): KeyRow | null {
  const live = rows.filter((r) => isLive(r, now)).sort((a, b) => Number(a.id) - Number(b.id))
  if (live.length === 0) return null
  const ready = live.filter((r) => startOf(r) <= now)
  return ready.length ? ready[ready.length - 1] : live[0]
}

async function keyRows(k: Knex = db): Promise<KeyRow[]> {
  return k('nivaro_hub_oidc_keys')
    .select('id', 'kid', 'created_at', 'retired_at')
    .orderBy('id', 'asc')
}

/**
 * Sets each live key's hand-over: a live key retires when the next live key may start signing
 * (its created_at + 6 min); the newest live key has none. Keys already retired keep their time,
 * so a key stays published 24 h after its successor STARTED signing. Idempotent: every replica
 * that runs it over the same rows writes the same values.
 */
async function scheduleHandovers(k: Knex, now: number): Promise<void> {
  const live = (await keyRows(k)).filter((r) => isLive(r, now))
  for (let i = 0; i < live.length; i++) {
    const want = i + 1 < live.length ? startOf(live[i + 1]) : null
    const have = msOf(live[i].retired_at)
    if (want === have) continue
    await k('nivaro_hub_oidc_keys')
      .where({ id: live[i].id })
      .update({ retired_at: want === null ? null : new Date(want) })
  }
}

async function loadActive(): Promise<{ kid: string; key: CryptoKey; until: number }> {
  const now = Date.now()
  let rows = await keyRows()
  let signer = signerOf(rows, now)
  if (!signer) {
    // No usable key at all (a first-ever key): one is made and signs at once.
    const fresh = await newKeyRow(null)
    try {
      await sealedWrite(() => db('nivaro_hub_oidc_keys').insert(fresh))
    } catch (e) {
      // A replica that created one at the same moment (or any refused insert): use what is there.
      const there = await keyRows().catch(() => [] as KeyRow[])
      if (!signerOf(there, now)) throw e
    }
    // Two replicas racing each made one: the older hands over to the newer once it is published.
    await scheduleHandovers(db, now).catch(() => undefined)
    rows = await keyRows()
    signer = signerOf(rows, now)
    if (!signer) throw new HubKeyError('HUB_KEY_CREATE_FAILED', CREATE_FAILED)
  }
  const sealed = (await db('nivaro_hub_oidc_keys').where({ id: signer.id }).first('private_jwk')) as
    | { private_jwk: string }
    | undefined
  if (!sealed) throw new HubKeyError('HUB_KEY_CREATE_FAILED', CREATE_FAILED)
  const key = await importPrivate(signer.kid, sealed.private_jwk)
  // The memo never outlives the hand-over to the next key.
  const handover = msOf(signer.retired_at)
  const until = Math.min(now + MEMO_MS, handover ?? Number.POSITIVE_INFINITY)
  return { kid: signer.kid, key, until }
}

/**
 * The key new tokens are signed with (see signerOf; created on first use). Memo ≤ 60 s, never
 * past a scheduled hand-over; rotation and removal clear it in this process.
 */
export async function activeSigningKey(): Promise<{ kid: string; key: CryptoKey }> {
  if (memo && Date.now() < memo.until) return { kid: memo.kid, key: memo.key }
  if (!pending) {
    const p = loadActive()
      .then((k) => {
        if (pending === p) memo = k
        return { kid: k.kid, key: k.key }
      })
      .finally(() => {
        if (pending === p) pending = null
      })
    pending = p
  }
  const k = await pending
  return { kid: k.kid, key: k.key }
}

/**
 * The public keys apps verify with: every live key (the signing key and any next key, published
 * from the moment it is created) plus keys retired in the last 24 h.
 */
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
 * A new key is published now and signs once it has been published 6 minutes (apps cache the
 * JWKS 5 minutes); the key it replaces signs until then and stays published 24 h after that.
 * Two rotations at once converge: the hand-overs follow the id order, the newest signs last.
 */
export async function rotateSigningKey(
  userId: string
): Promise<{ kid: string; signs_from: string }> {
  const row = await newKeyRow(userId || null)
  const kid = row.kid as string
  const now = Date.now()
  let signsFrom = now + PUBLISH_BEFORE_SIGN_MS
  await sealedWrite(() =>
    db.transaction(async (trx) => {
      await trx('nivaro_hub_oidc_keys').insert(row)
      const created = (await trx('nivaro_hub_oidc_keys')
        .where({ kid })
        .first('id', 'kid', 'created_at', 'retired_at')) as KeyRow | undefined
      if (!created || !Number.isFinite(Number(created.id))) throw new Error('new key row not found')
      signsFrom = startOf(created)
      await scheduleHandovers(trx as unknown as Knex, now)
    })
  )
  memo = null
  pending = null
  return { kid, signs_from: new Date(signsFrom).toISOString() }
}

const SOON_WARNING =
  'The next key now signs at once. Apps that fetched the key list before it was published may refuse sign-ins for up to 5 minutes.'

/**
 * Removes a key at once (a compromised key): gone from the JWKS and from signing. Refused for
 * the only usable key (ONLY_SIGNING_KEY); when the signing key goes and a next key exists, the
 * next key signs at once and the answer carries a warning. Clears this process's memo; other
 * replicas follow within their ≤ 60 s memo.
 */
export async function removeSigningKey(
  kid: string
): Promise<{ kid: string; signing_kid: string | null; warning: string | null }> {
  const now = Date.now()
  let result: { kid: string; signing_kid: string | null; warning: string | null } = {
    kid,
    signing_kid: null,
    warning: null
  }
  await db.transaction(async (trx) => {
    const k = trx as unknown as Knex
    const rows = await keyRows(k)
    const target = rows.find((r) => r.kid === kid)
    if (!target) throw new HubKeyError('NOT_FOUND', 'No signing key with that id.')
    const signer = signerOf(rows, now)
    const rest = rows.filter((r) => r.id !== target.id)
    if (signer?.id === target.id && !rest.some((r) => isLive(r, now))) {
      throw new HubKeyError(
        'ONLY_SIGNING_KEY',
        'This is the only key that can sign. Rotate first, then remove it.'
      )
    }
    await k('nivaro_hub_oidc_keys').where({ id: target.id }).del()
    await scheduleHandovers(k, now)
    // Two removals at once must not leave nothing to sign with.
    const after = await keyRows(k)
    const next = signerOf(after, now)
    if (!next) {
      throw new HubKeyError(
        'ONLY_SIGNING_KEY',
        'This is the only key that can sign. Rotate first, then remove it.'
      )
    }
    const young = startOf(next) > now && signer?.id === target.id
    result = { kid, signing_kid: next.kid, warning: young ? SOON_WARNING : null }
  })
  memo = null
  pending = null
  return result
}

function isoOf(v: unknown): string | null {
  const ms = msOf(v)
  if (ms !== null) return new Date(ms).toISOString()
  return v === null || v === undefined || v === '' ? null : String(v)
}

export type SigningKeyStatus = 'active' | 'next' | 'retired'

/**
 * Every key for the admin list, newest first; nothing private. `active` = signs now; `next` =
 * published, signs from `signs_from`; `retired` = published until `published_until`.
 */
export async function listSigningKeys(): Promise<
  Array<{
    kid: string
    alg: string
    created_at: string
    retired_at: string | null
    active: boolean
    status: SigningKeyStatus
    signs_from: string | null
    published_until: string | null
  }>
> {
  const now = Date.now()
  const rows: Array<KeyRow & { alg: string }> = await db('nivaro_hub_oidc_keys')
    .select('id', 'kid', 'alg', 'created_at', 'retired_at')
    .orderBy('id', 'desc')
  const signer = signerOf(rows, now)
  return rows.map((r) => {
    const status: SigningKeyStatus =
      signer && r.id === signer.id
        ? 'active'
        : isLive(r, now) && (!signer || Number(r.id) > Number(signer.id))
          ? 'next'
          : 'retired'
    const ret = msOf(r.retired_at)
    return {
      kid: r.kid,
      alg: r.alg,
      created_at: isoOf(r.created_at) ?? '',
      retired_at: isoOf(r.retired_at),
      active: status === 'active',
      status,
      signs_from: status === 'next' ? new Date(startOf(r)).toISOString() : null,
      published_until:
        status === 'retired' && ret !== null ? new Date(ret + RETIRED_GRACE_MS).toISOString() : null
    }
  })
}
