import {
  type MetadataQueryClient,
  restoreMetadata,
  startMetadataPersistence,
  wipeMetadataCache
} from '@nivaro/shared'
import type { User } from './api'

const BUILD = typeof __NIVARO_ADMIN_BUILD__ === 'string' ? __NIVARO_ADMIN_BUILD__ : 'dev'

let active: { key: string; stop: () => void } | null = null

/**
 * Metadata between reloads (#2449). Called with the signed-in person from
 * GET /auth/me; restores last session's collections/fields/layouts/settings
 * into the query cache (stale, so screens still refetch) and keeps the copy
 * fresh. Await it before the app renders so the first screens find the cache
 * filled. View-as tabs neither restore nor save: a viewed-as person's data
 * never reaches disk.
 */
export async function bootMetadataCache(qc: MetadataQueryClient, me: User): Promise<void> {
  if (me.masquerade) {
    stopMetadataCache()
    return
  }
  const identity = { userId: me.id, epoch: me.config_epoch, version: BUILD }
  const key = `${me.id}:${me.config_epoch ?? ''}`
  if (active?.key === key) return
  stopMetadataCache()
  if (me.config_epoch === null || me.config_epoch === undefined) return
  await restoreMetadata(qc, identity)
  active = { key, stop: startMetadataPersistence(qc, identity) }
}

export function stopMetadataCache(): void {
  active?.stop()
  active = null
}

/** Sign-out: nothing of the person stays on the machine. */
export async function wipeMetadataOnSignOut(): Promise<void> {
  stopMetadataCache()
  await wipeMetadataCache()
}
