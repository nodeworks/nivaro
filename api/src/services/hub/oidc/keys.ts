import { createHash, randomBytes, type webcrypto } from 'node:crypto'
import { exportJWK, generateKeyPair, importJWK, type JWK } from 'jose'
import type { Knex } from 'knex'
import { config } from '../../../config.js'
import { utcNow } from '../../../db/dialect.js'
import { db } from '../../../db/index.js'
import { sqlDialect } from '../../../db/sql-dialect.js'
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
 *    (signerOf) on EVERY mint (one small SELECT; sign-ins are rare), so every replica agrees and a
 *    removed or retired key stops signing everywhere at once. Only the imported CryptoKey is
 *    cached per kid (60 s), never which key signs.
 *  - Times are the DATABASE's clock (utcNow, read in the same SELECT as the rows; created_at is
 *    the column default), never a replica's own clock, so skewed replicas agree.
 *  - A first-ever key (none usable) is created on first use and signs at once (one per process at
 *    a time; two replicas racing each create one, the older hands over to the newer 6 min later).
 *  - The JWKS publishes every live key plus keys retired in the last 24 hours: a replaced key
 *    stays published 24 h after its successor STARTED signing.
 *  - removeSigningKey drops a (compromised) key from the JWKS and from signing at once.
 *
 * Hub-only (HUB=on, never cloud mode), so module state here is not shared between tenants.
 */

export const HUB_OIDC_ALG = 'ES256'
const KEY_CACHE_MS = 60_000
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

/** Imported private keys by kid (the unseal + import is the costly part). Never decides WHICH key signs. */
const keyCache = new Map<string, { key: CryptoKey; at: number }>()
/** One first-key creation per process at a time. */
let creating: Promise<void> | null = null
/** Tests only: stands in for the database clock. */
let testClock: (() => number) | null = null

export function _resetHubKeysForTests(): void {
  keyCache.clear()
  creating = null
}

/** Tests only: `fn` replaces the database clock (null = the database again). */
export function _setHubKeyClockForTests(fn: (() => number) | null): void {
  testClock = fn
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
    // created_at: the column default (utcNow), the database clock, like every comparison here
    retired_at: null
  }
}

type KeyRow = {
  id: number
  kid: string
  created_at: unknown
  retired_at: unknown
  db_now?: unknown
}

const KEYS = 'nivaro_hub_oidc_keys'

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

/** The database's UTC clock as a select column (portable: utcNow covers the five engines). */
function dbNowColumn(k: Knex): Knex.Raw {
  return k.raw(`${utcNow(k).toString()} as db_now`)
}

/** "Now" for these rows: the database clock read with them (one more tiny SELECT when empty). */
async function clockOf(k: Knex, rows: Array<{ db_now?: unknown }>): Promise<number> {
  if (testClock) return testClock()
  const fromRows = msOf(rows[0]?.db_now)
  if (fromRows !== null) return fromRows
  const [r] = (await k.select(dbNowColumn(k))) as Array<{ db_now?: unknown }>
  return msOf(r?.db_now) ?? Date.now()
}

/**
 * Every key row (no key material) and the database's "now", in one SELECT.
 *
 * `lock`: the first read of a rotation or removal takes an update lock on EVERY key row (in id
 * order) until the transaction ends — FOR UPDATE on Postgres/MySQL/MariaDB, UPDLOCK on SQL Server,
 * which also reads the latest committed rows under read-committed snapshot (RCSI). Without it two
 * removals (or a removal and a rotation) running at once each decide from the same old rows:
 * both removals pass the "another key can sign" check and leave nothing to sign with, or a
 * hand-over is scheduled against a key the other transaction deletes and a young key signs
 * before it has been published 6 minutes. With it, the second waits and decides on what the
 * first committed. SQLite has one writer at a time anyway (knex would only warn).
 */
function keyRowsQuery(k: Knex, lock: boolean) {
  const q = k(KEYS)
    .select('id', 'kid', 'created_at', 'retired_at', dbNowColumn(k))
    .orderBy('id', 'asc')
  return lock && sqlDialect(k) !== 'sqlite' ? q.forUpdate() : q
}

/** Tests only: the key-row read as it is sent to an engine. */
export const _keyRowsQueryForTests = keyRowsQuery

async function keyRows(
  k: Knex = db,
  opts: { lock?: boolean } = {}
): Promise<{ rows: KeyRow[]; now: number }> {
  const rows = (await keyRowsQuery(k, !!opts.lock)) as KeyRow[]
  return { rows, now: await clockOf(k, rows) }
}

/**
 * Sets each live key's hand-over: a live key retires when the next live key may start signing
 * (its created_at + 6 min); the newest live key has none. Keys already retired keep their time,
 * so a key stays published 24 h after its successor STARTED signing. Idempotent: every replica
 * that runs it over the same rows writes the same values.
 */
async function scheduleHandovers(k: Knex, now: number): Promise<void> {
  const { rows } = await keyRows(k)
  const live = rows.filter((r) => isLive(r, now))
  for (let i = 0; i < live.length; i++) {
    const want = i + 1 < live.length ? startOf(live[i + 1]) : null
    const have = msOf(live[i].retired_at)
    if (want === have) continue
    await k(KEYS)
      .where({ id: live[i].id })
      .update({ retired_at: want === null ? null : new Date(want) })
  }
}

/** Makes a first key when none can sign (one creation per process at a time). */
async function createFirstKey(): Promise<void> {
  if (!creating) {
    const p = (async () => {
      // Another caller (or replica) may have made one since this caller looked.
      const before = await keyRows()
      if (signerOf(before.rows, before.now)) return
      const fresh = await newKeyRow(null)
      try {
        await sealedWrite(() => db(KEYS).insert(fresh))
      } catch (e) {
        // A replica that created one at the same moment (or any refused insert): use what is there.
        const there = await keyRows().catch(() => null)
        if (!there || !signerOf(there.rows, there.now)) throw e
      }
      // Two replicas racing each made one: the older hands over to the newer once it is published.
      const after = await keyRows()
      await scheduleHandovers(db, after.now).catch(() => undefined)
    })().finally(() => {
      if (creating === p) creating = null
    })
    creating = p
  }
  await creating
}

/** The signer's private key, imported; the import is cached per kid for up to 60 s. */
async function importedKey(r: KeyRow): Promise<CryptoKey> {
  const t = Date.now()
  const hit = keyCache.get(r.kid)
  if (hit && t - hit.at < KEY_CACHE_MS) return hit.key
  const row = (await db(KEYS).where({ id: r.id }).first('private_jwk')) as
    | { private_jwk: string }
    | undefined
  if (!row) throw new HubKeyError('HUB_KEY_GONE', 'The Hub signing key changed. Try again.')
  const key = await importPrivate(r.kid, row.private_jwk)
  for (const [kid, v] of keyCache) if (t - v.at >= KEY_CACHE_MS) keyCache.delete(kid)
  keyCache.set(r.kid, { key, at: t })
  return key
}

/**
 * The key new tokens are signed with (see signerOf; a first key is created on first use).
 * WHICH key signs is read fresh from the key table on every call, so a key removed or retired
 * on any replica is never used again; only the import of a kid is cached.
 */
export async function activeSigningKey(): Promise<{ kid: string; key: CryptoKey }> {
  let { rows, now } = await keyRows()
  let signer = signerOf(rows, now)
  if (!signer) {
    await createFirstKey()
    ;({ rows, now } = await keyRows())
    signer = signerOf(rows, now)
    if (!signer) throw new HubKeyError('HUB_KEY_CREATE_FAILED', CREATE_FAILED)
  }
  return { kid: signer.kid, key: await importedKey(signer) }
}

/**
 * The public keys apps verify with: every live key (the signing key and any next key, published
 * from the moment it is created) plus keys retired in the last 24 h. `now` defaults to the
 * database clock.
 */
export async function publishedJwks(now?: Date): Promise<{ keys: HubPublicJwk[] }> {
  const rows: Array<{ kid: string; public_jwk: string; retired_at: unknown; db_now?: unknown }> =
    await db(KEYS).select('kid', 'public_jwk', 'retired_at', dbNowColumn(db)).orderBy('id', 'desc')
  const t = now ? now.getTime() : await clockOf(db, rows)
  const keys: HubPublicJwk[] = []
  for (const r of rows) {
    const ret = msOf(r.retired_at)
    if (ret !== null && ret + RETIRED_GRACE_MS <= t) continue
    const pub = publicMembers(parseJson(r.public_jwk))
    if (pub) keys.push({ ...pub, kid: r.kid, alg: 'ES256', use: 'sig' })
  }
  return { keys }
}

/**
 * A new key is published now and signs once it has been published 6 minutes (apps cache the
 * JWKS 5 minutes); the key it replaces signs until then and stays published 24 h after that.
 * Rotations and removals at once are serialised by the row lock (keyRows `lock`).
 */
export async function rotateSigningKey(
  userId: string
): Promise<{ kid: string; signs_from: string }> {
  const row = await newKeyRow(userId || null)
  const kid = row.kid as string
  let signsFrom = 0
  await sealedWrite(() =>
    db.transaction(async (trx) => {
      const k = trx as unknown as Knex
      const { now } = await keyRows(k, { lock: true })
      await k(KEYS).insert(row)
      const created = (await k(KEYS)
        .where({ kid })
        .first('id', 'kid', 'created_at', 'retired_at')) as KeyRow | undefined
      if (!created || !Number.isFinite(Number(created.id))) throw new Error('new key row not found')
      signsFrom = startOf(created)
      await scheduleHandovers(k, now)
    })
  )
  keyCache.clear()
  return { kid, signs_from: new Date(signsFrom).toISOString() }
}

const SOON_WARNING =
  'The next key now signs at once. An app that fetched the key list before that key was published may refuse a sign-in briefly: apps look up an unknown key again at most every 30 seconds, and trying again then works.'

/** Why removing `target` is refused, or null (the server's one rule; the admin list shows it). */
function removalRefusal(rows: KeyRow[], now: number, target: KeyRow): HubKeyError | null {
  const signer = signerOf(rows, now)
  if (signer?.id !== target.id) return null
  const others = rows.filter((r) => r.id !== target.id)
  if (others.some((r) => isLive(r, now))) return null
  return new HubKeyError(
    'ONLY_SIGNING_KEY',
    others.length
      ? 'This is the only key that can sign: retired keys never sign again. Rotate first (the new key is published at once), then remove this one.'
      : 'This is the only key that can sign. Rotate first (the new key is published at once), then remove this one.'
  )
}

type Removed = { kid: string; signing_kid: string | null; warning: string | null }

/** The database part of a removal (what any replica does); removeSigningKey adds the cache. */
async function removeKeyRows(kid: string): Promise<Removed> {
  let result: Removed = { kid, signing_kid: null, warning: null }
  await db.transaction(async (trx) => {
    const k = trx as unknown as Knex
    const { rows, now } = await keyRows(k, { lock: true })
    const target = rows.find((r) => r.kid === kid)
    if (!target) throw new HubKeyError('NOT_FOUND', 'No signing key with that id.')
    const refusal = removalRefusal(rows, now, target)
    if (refusal) throw refusal
    const signer = signerOf(rows, now)
    await k(KEYS).where({ id: target.id }).del()
    await scheduleHandovers(k, now)
    // Kept although the lock serialises removals: a rotation's insert is a new row the lock
    // cannot hold off (a phantom on read committed), and this re-read is one cheap SELECT.
    const after = await keyRows(k)
    const next = signerOf(after.rows, now)
    if (!next) {
      throw new HubKeyError(
        'ONLY_SIGNING_KEY',
        'This is the only key that can sign. Rotate first (the new key is published at once), then remove this one.'
      )
    }
    const young = startOf(next) > now && signer?.id === target.id
    result = { kid, signing_kid: next.kid, warning: young ? SOON_WARNING : null }
  })
  return result
}

/** Tests only: replica A's removal, without touching this process's key cache (replica B). */
export const _removeKeyRowsAsAnotherReplicaForTests = removeKeyRows

/**
 * Removes a key at once (a compromised key): gone from the JWKS and from signing on every
 * replica (each reads which key signs on every mint). Refused for the only usable key
 * (ONLY_SIGNING_KEY); when the signing key goes and a next key exists, the next key signs at
 * once and the answer carries a warning.
 */
export async function removeSigningKey(kid: string): Promise<Removed> {
  const result = await removeKeyRows(kid)
  keyCache.delete(kid)
  return result
}

function isoOf(v: unknown): string | null {
  const ms = msOf(v)
  if (ms !== null) return new Date(ms).toISOString()
  return v === null || v === undefined || v === '' ? null : String(v)
}

/**
 * signing = signs now; next = published, signs from `signs_from`; live = published, older than
 * the signing key and not signing; retiring = retired, still published until `published_until`;
 * retired = no longer published.
 */
export type SigningKeyStatus = 'signing' | 'next' | 'live' | 'retiring' | 'retired'

/** Every key for the admin list, newest first; nothing private. Same derivation as signerOf. */
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
    removable: boolean
  }>
> {
  const rows: Array<KeyRow & { alg: string }> = await db(KEYS)
    .select('id', 'kid', 'alg', 'created_at', 'retired_at', dbNowColumn(db))
    .orderBy('id', 'desc')
  const now = await clockOf(db, rows)
  const signer = signerOf(rows, now)
  return rows.map((r) => {
    const ret = msOf(r.retired_at)
    let status: SigningKeyStatus
    if (signer && r.id === signer.id) status = 'signing'
    else if (isLive(r, now)) status = !signer || Number(r.id) > Number(signer.id) ? 'next' : 'live'
    else status = ret !== null && ret + RETIRED_GRACE_MS > now ? 'retiring' : 'retired'
    return {
      kid: r.kid,
      alg: r.alg,
      created_at: isoOf(r.created_at) ?? '',
      retired_at: isoOf(r.retired_at),
      active: status === 'signing',
      status,
      signs_from: status === 'next' ? new Date(startOf(r)).toISOString() : null,
      published_until:
        (status === 'retiring' || status === 'retired') && ret !== null
          ? new Date(ret + RETIRED_GRACE_MS).toISOString()
          : null,
      removable: removalRefusal(rows, now, r) === null
    }
  })
}
