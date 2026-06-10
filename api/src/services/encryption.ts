import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { db } from '../db/index.js'

/**
 * Field-level encryption helpers (AES-256-GCM).
 *
 * Stored format: `enc:v1:<iv_b64>:<tag_b64>:<ciphertext_b64>`
 * Key comes from the ENCRYPTION_KEY env var (32-byte hex = 64 hex chars).
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

export function isEncrypted(val: unknown): boolean {
  return typeof val === 'string' && val.startsWith(ENC_PREFIX)
}

export function encryptValue(plain: string): string {
  const key = getKey()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${ENC_PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`
}

export function decryptValue(stored: string): string {
  if (!isEncrypted(stored)) return stored // passthrough for plaintext values
  const key = getKey()
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

// ─── Encrypted-field lookup (30s cache) ──────────────────────────────────────

const fieldCache = new Map<string, { fields: string[]; at: number }>()
const CACHE_TTL_MS = 30_000

export async function getEncryptedFields(collection: string): Promise<string[]> {
  const hit = fieldCache.get(collection)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.fields

  const rows = (await db('nivaro_fields')
    .where({ collection })
    .where('is_encrypted', true)
    .select('field')) as Array<{ field: string }>
  const fields = rows.map((r) => r.field)
  fieldCache.set(collection, { fields, at: Date.now() })
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
