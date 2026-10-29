/**
 * File expiry & cleanup job.
 *
 * Wiring (server startup, after the cron plugin is registered):
 *   import { registerFileCleanup } from './hooks/file-cleanup.js';
 *   registerFileCleanup(app.cron);
 *
 * Runs hourly:
 *  1. Deletes files whose expires_at is in the past (storage object,
 *     cached transforms and the DB row) — except files a legal hold keeps
 *     (held directly, or linked to a held record).
 *  2. Removes orphaned transform-cache entries whose source file no longer
 *     exists (providers that support list()).
 */
import { db } from '../db/index.js'
import type { CronManager } from '../plugins/cron.js'
import { deleteFile, type StoredFile } from '../services/files.js'
import { getStorage } from '../services/storage/index.js'

export function registerFileCleanup(cron: CronManager): void {
  cron.schedule('file-cleanup', '0 * * * *', async () => {
    await runFileCleanup()
  })
}

export async function runFileCleanup(): Promise<{ expired: number; orphans: number }> {
  const expired = await cleanupExpiredFiles()
  const orphans = await cleanupOrphanedTransforms()
  if (expired || orphans) {
    console.info(
      `[file-cleanup] removed ${expired} expired file(s), ${orphans} orphan transform(s)`
    )
  }
  return { expired, orphans }
}

async function cleanupExpiredFiles(): Promise<number> {
  const rows = await db<StoredFile>('nivaro_files')
    .whereNotNull('expires_at')
    .where('expires_at', '<', new Date())
    .select('id')

  const held = await heldFileIds(rows.map((r) => String(r.id)))
  let count = 0
  for (const row of rows) {
    if (held === 'all' || held.has(String(row.id).toLowerCase())) continue
    try {
      await deleteFile(String(row.id)) // removes storage object + transforms + DB row
      count++
    } catch (err) {
      console.error({ err, file: row.id }, '[file-cleanup] failed to delete expired file')
    }
  }
  return count
}

/**
 * Expired files a legal hold keeps (#17): a file held by itself (collection nivaro_files) or
 * linked to a held record. 'all' = holds exist but the links could not be read — keep every
 * file this round rather than delete held evidence.
 */
export async function heldFileIds(ids: string[]): Promise<Set<string> | 'all'> {
  const out = new Set<string>()
  if (ids.length === 0) return out
  const { heldRecordKeys, holdKey } = await import('../services/legal-holds.js')
  const held = await heldRecordKeys().catch(() => null)
  if (held == null) return 'all'
  if (held.size === 0) return out
  for (const id of ids) if (held.has(holdKey('nivaro_files', id))) out.add(id.toLowerCase())
  const { fileRecordRefs } = await import('../services/file-access.js')
  const refs = await fileRecordRefs(ids).catch(() => null)
  if (!refs || refs.failed) return 'all'
  for (const [fileId, list] of refs)
    if (list.some((r) => held.has(holdKey(r.collection, r.id)))) out.add(fileId.toLowerCase())
  return out
}

async function cleanupOrphanedTransforms(): Promise<number> {
  const storage = getStorage()
  if (!storage.list) return 0

  const keys = await storage.list('transforms/').catch(() => [] as string[])
  if (keys.length === 0) return 0

  // transforms/<fileId>/<hash>.<ext>
  const byFile = new Map<string, string[]>()
  for (const key of keys) {
    const fileId = key.split('/')[1]?.toLowerCase()
    if (!fileId) continue
    const list = byFile.get(fileId) ?? []
    list.push(key)
    byFile.set(fileId, list)
  }

  const ids = Array.from(byFile.keys())
  const existing = await db('nivaro_files').whereIn('id', ids).select('id')
  const alive = new Set(existing.map((r: { id: unknown }) => String(r.id).toLowerCase()))

  let removed = 0
  for (const [fileId, fileKeys] of byFile) {
    if (alive.has(fileId)) continue
    for (const key of fileKeys) {
      await storage.delete(key).catch(() => null)
      removed++
    }
  }
  return removed
}
