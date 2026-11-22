import { createHmac } from 'node:crypto'

/** An app's ENCRYPTION_KEY: 64 hex characters (32 bytes). */
export const APP_KEY_RE = /^[0-9a-f]{64}$/i

/**
 * A short, one-way check value for an app's ENCRYPTION_KEY, so the Hub and an app can tell whether
 * they hold the same key without the key ever crossing the hub link (Nivaro Hub phase 6).
 * HMAC-SHA256 keyed by the key bytes over a fixed label; first 32 hex characters.
 */
export function keyFingerprint(hexKey: string): string {
  return createHmac('sha256', Buffer.from(hexKey, 'hex'))
    .update('nivaro-app-key-check')
    .digest('hex')
    .slice(0, 32)
}
