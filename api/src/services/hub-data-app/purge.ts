import { db } from '../../db/index.js'
import { getTenantId } from '../../db/tenant-context.js'
import { getStorage } from '../storage/index.js'
import { getActiveStorageDriver } from '../storage-drivers.js'

/**
 * Hub data care, APP side: the teardown of a move rehearsal's temporary app (`rh-<run>` on a
 * shared deployment). Everything the rehearsal's file copy wrote lives under that app's own
 * storage scope (apps/rh-<run>/), keyed by the rows of its database (the scratch copy): each
 * row's object is deleted there, env-local and saved-settings S3 / Azure alike, then anything
 * else the env provider still lists in the scope. Runs inside the rehearsal app only (the route
 * refuses any other id, and so does this), so a real app's objects are never reached.
 */
export async function purgeAppFiles(): Promise<{ deleted: number; failed: number }> {
  const tenant = getTenantId() ?? ''
  if (!/^rh-[1-9][0-9]{0,9}$/.test(tenant)) throw new Error('not a rehearsal app')
  let deleted = 0
  let failed = 0
  const env = getStorage()
  let objects: Awaited<ReturnType<typeof getActiveStorageDriver>> | null = null
  let after: string | null = null
  for (;;) {
    let q = db('nivaro_files')
      .select('id', 'filename_disk', 'storage')
      .whereNotNull('filename_disk')
      .orderBy('id', 'asc')
      .limit(500)
    if (after !== null) q = q.where('id', '>', after)
    const rows = (await q) as Array<{ id: string; filename_disk: string; storage: string | null }>
    if (!rows.length) break
    after = String(rows[rows.length - 1].id)
    for (const r of rows) {
      try {
        if (!r.storage || r.storage === 'local') await env.delete(r.filename_disk)
        else {
          objects ??= await getActiveStorageDriver()
          await objects.delete(r.filename_disk)
        }
        deleted++
      } catch {
        failed++
      }
    }
  }
  if (env.list) {
    for (const key of await env.list('').catch(() => [] as string[])) {
      try {
        await env.delete(key)
        deleted++
      } catch {
        failed++
      }
    }
  }
  return { deleted, failed }
}
