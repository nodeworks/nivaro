import { createCipheriv, createDecipheriv, createHmac } from 'node:crypto'

/**
 * A value the Hub hands one app of a shared deployment, sealed with THAT app's ENCRYPTION_KEY
 * (AES-256-GCM, the `enc:v1:<iv>:<tag>:<ciphertext>` format of services/encryption.ts, so the
 * app's own decryptValue opens it too).
 *
 * The IV is synthetic: HMAC-SHA256(key, label + plain), first 12 bytes. The same value under the
 * same key always seals to the same text, so the tenant list's ETag (a hash of the body) stays
 * put while nothing changed; it shows only that two seals hold the same value. The label keeps
 * these IVs apart from anything else derived from the key.
 *
 * A leaf (node:crypto only): the Hub side (services/hub/shared/tenants.ts) seals, the deployment
 * side (tenancy/app-hub-links.ts) opens. Neither logs a value or a key.
 */

const PREFIX = 'enc:v1:'
const IV_LABEL = 'nivaro-app-sealed-iv\u0000'
const KEY_RE = /^[0-9a-fA-F]{64}$/

function keyOf(hex: string): Buffer {
  if (!KEY_RE.test(hex)) throw new Error('An app key is 64 hex characters.')
  return Buffer.from(hex, 'hex')
}

/** Seals `plain` with the app key `keyHex` (64 hex): the same input gives the same text. */
export function sealForApp(plain: string, keyHex: string): string {
  const key = keyOf(keyHex)
  const iv = createHmac('sha256', key)
    .update(IV_LABEL)
    .update(plain, 'utf8')
    .digest()
    .subarray(0, 12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return `${PREFIX}${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${ct.toString('base64')}`
}

/** Opens a value sealed with the app key `keyHex`; null when it is not one (wrong key, damaged,
 *  not the format). Never throws, never says why (the reason could hint at the key). */
export function openForApp(stored: unknown, keyHex: string): string | null {
  if (typeof stored !== 'string' || !stored.startsWith(PREFIX) || !KEY_RE.test(keyHex)) return null
  const parts = stored.slice(PREFIX.length).split(':')
  if (parts.length !== 3) return null
  try {
    const [iv, tag, ct] = parts.map((p) => Buffer.from(p, 'base64'))
    if (iv.length !== 12 || tag.length !== 16) return null
    const d = createDecipheriv('aes-256-gcm', keyOf(keyHex), iv)
    d.setAuthTag(tag)
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8')
  } catch {
    return null
  }
}
