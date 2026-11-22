/**
 * The apps' own ENCRYPTION_KEYs on a Hub shared deployment (Hub phase 6, Decision 6), by tenant
 * id. The Hub source (hub-source.ts) replaces the whole set every time it takes a list (from the
 * Hub or from its sealed Redis copy); services/encryption.ts reads it synchronously to seal and
 * open an app's values with that app's key.
 *
 * A leaf on purpose: encryption.ts is imported almost everywhere, and the Hub source pulls in the
 * fetch, roster and readiness modules. Keys live in memory only, never in a log or an error.
 */

const keys = new Map<string, Buffer>()

/** Replace every key with the list's: an app the list no longer holds (or lists without a key)
 *  has none afterwards. */
export function setAppKeys(tenants: readonly { id: string; encryptionKey?: string }[]): void {
  keys.clear()
  for (const t of tenants)
    if (t.encryptionKey && /^[0-9a-fA-F]{64}$/.test(t.encryptionKey))
      keys.set(t.id, Buffer.from(t.encryptionKey, 'hex'))
}

/** The app's key, or null when the Hub listed none for it (or does not list the app). */
export function appKeyOf(tenantId: string): Buffer | null {
  return keys.get(tenantId) ?? null
}

/** Test seam: forget every key. */
export function resetAppKeysForTests(): void {
  keys.clear()
}
