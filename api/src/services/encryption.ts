import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { db } from '../db/index.js'
import { getTenantDb, getTenantId } from '../db/tenant-context.js'
import { tenantSource } from './deployment-mode.js'
import { appKeyOf } from './tenancy/app-keys.js'

/**
 * Field-level encryption helpers (AES-256-GCM).
 *
 * Stored format: `enc:v1:<iv_b64>:<tag_b64>:<ciphertext_b64>`
 * Key comes from the ENCRYPTION_KEY env var (32-byte hex = 64 hex chars).
 *
 * Hub shared deployment (one process, many apps; Hub phase 6): inside an app, encryptValue /
 * decryptValue use THAT app's ENCRYPTION_KEY from the Hub's tenant list (tenancy/app-keys.ts),
 * because its sealed values were written with it. An app the list gives no key is refused
 * (AppKeyMissingError, code APP_KEY_MISSING): never the deployment key, never another app's.
 * Outside any app they use the deployment's own key, as today. Values the deployment owns (the
 * sealed tenant-list copy) use encryptForDeployment / decryptForDeployment, which always take the
 * deployment key. Self-hosted and Nivaro Cloud: the env key everywhere, format unchanged.
 *
 * These are pure helpers — integration into the items pipeline is done elsewhere.
 */

const ENC_PREFIX = 'enc:v1:'

function getKey(): Buffer {
  const hex = process.env.ENCRYPTION_KEY
  if (!hex) {
    throw new Error(
      'ENCRYPTION_KEY is not set but encrypted fields are configured. ' +
        'Set ENCRYPTION_KEY to a 32-byte hex string (64 hex characters).'
    )
  }
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('ENCRYPTION_KEY must be a 32-byte hex string (64 hex characters).')
  }
  return Buffer.from(hex, 'hex')
}

/** An app on a Hub shared deployment has no ENCRYPTION_KEY in the Hub's list: nothing of it is
 *  sealed or opened (no fallback to another key). The message never names a key. */
export class AppKeyMissingError extends Error {
  readonly code = 'APP_KEY_MISSING' as const
  readonly statusCode = 503
  constructor() {
    super(
      'This app’s encryption key is not known on this shared deployment. Enter it on the Nivaro Hub, then try again.'
    )
    this.name = 'AppKeyMissingError'
  }
}

/**
 * The key for the current context: the app's own key inside an app on a Hub shared deployment
 * (AppKeyMissingError without one), else the env key. Inside an app = a tenant context is open
 * (request, app job, deployment link call).
 */
function currentKey(): Buffer {
  if (tenantSource() !== 'hub' || getTenantDb() === undefined) return getKey()
  const id = getTenantId()
  const key = id ? appKeyOf(id) : null
  if (!key) throw new AppKeyMissingError()
  return key
}

export function isEncrypted(val: unknown): boolean {
  return typeof val === 'string' && val.startsWith(ENC_PREFIX)
}

function seal(plain: string, key: Buffer): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${ENC_PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`
}

function open(stored: string, key: Buffer): string {
  const parts = stored.slice(ENC_PREFIX.length).split(':')
  if (parts.length !== 3) {
    throw new Error('Malformed encrypted value: expected enc:v1:<iv>:<tag>:<ciphertext>')
  }
  const [ivB64, tagB64, ctB64] = parts
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'))
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString(
    'utf8'
  )
}

/** Seals an app value: the current app's key on a Hub shared deployment, else ENCRYPTION_KEY. */
export function encryptValue(plain: string): string {
  return seal(plain, currentKey())
}

/** Opens an app value (plaintext passes through): the same key encryptValue would use. */
export function decryptValue(stored: string): string {
  if (!isEncrypted(stored)) return stored // passthrough for plaintext values
  return open(stored, currentKey())
}

/** Seals a value the deployment itself owns (never an app's): always ENCRYPTION_KEY. */
export function encryptForDeployment(plain: string): string {
  return seal(plain, getKey())
}

/** Opens a value the deployment itself owns (plaintext passes through): always ENCRYPTION_KEY. */
export function decryptForDeployment(stored: string): string {
  if (!isEncrypted(stored)) return stored
  return open(stored, getKey())
}

// ─── Encrypted-field lookup (30s cache) ──────────────────────────────────────

// The cache holds the PROMISE, not the result: a page read decrypts its rows
// with Promise.all, so 25 rows meant 25 simultaneous misses — each one issued
// the same nivaro_fields query before the first had answered (1.6s of a 2.1s
// list read, caught by the trace's N+1 counter). Sharing the in-flight
// promise makes the 25 one. A failed lookup is evicted so the next call retries.
const fieldCache = new Map<string, { fields: Promise<string[]>; at: number }>()
const CACHE_TTL_MS = 30_000

export async function getEncryptedFields(collection: string): Promise<string[]> {
  const hit = fieldCache.get(collection)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.fields

  const fields = (async () => {
    const rows = (await db('nivaro_fields')
      .where({ collection })
      .where('is_encrypted', true)
      .select('field')) as Array<{ field: string }>
    return rows.map((r) => r.field)
  })()
  fieldCache.set(collection, { fields, at: Date.now() })
  fields.catch(() => fieldCache.delete(collection))
  return fields
}

/** Test helper / manual invalidation after schema changes. */
export function clearEncryptedFieldCache(collection?: string) {
  if (collection) fieldCache.delete(collection)
  else fieldCache.clear()
}

// ─── Item-level helpers ───────────────────────────────────────────────────────

/** Encrypts any configured encrypted fields present in `data`. Returns a new object. */
export async function encryptItemFields(
  collection: string,
  data: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const fields = await getEncryptedFields(collection)
  if (fields.length === 0) return data

  const out = { ...data }
  for (const field of fields) {
    const val = out[field]
    if (val === undefined || val === null) continue
    if (isEncrypted(val)) continue // already encrypted — don't double-encrypt
    out[field] = encryptValue(typeof val === 'string' ? val : JSON.stringify(val))
  }
  return out
}

/** Decrypts any configured encrypted fields present in `data`. Returns a new object. */
export async function decryptItemFields(
  collection: string,
  data: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const fields = await getEncryptedFields(collection)
  if (fields.length === 0) return data

  const out = { ...data }
  for (const field of fields) {
    const val = out[field]
    if (typeof val !== 'string' || !isEncrypted(val)) continue
    out[field] = decryptValue(val)
  }
  return out
}
