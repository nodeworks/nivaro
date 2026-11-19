import { db } from '../db/index.js'
import { existingFallback } from './storage/fallback.js'
import { fallbackUrlHas } from './storage/fallback-url.js'
import { getStorage } from './storage/index.js'

/** Does the source environment hold `key` (folder first, then over HTTP)? null = unknown. */
async function sourceHas(key: string): Promise<boolean | null> {
  if (await existingFallback(key).catch(() => null)) return true
  return fallbackUrlHas(key).catch(() => null)
}

/**
 * Dead-file-link detection.
 *
 * A nivaro_files row is metadata; the bytes live in the storage provider and
 * can vanish independently (host swaps, container rebuilds, cross-environment
 * uploads — the shared-queue ENOENT class of problem). `verifyFiles` stats a
 * batch of files against the provider and persists the verdict on the row
 * (`missing_at` set/cleared, `last_verified_at` stamped), so every consumer —
 * the Files page, file chips on forms — can render an honest dead-link state
 * from the row alone. The nightly sweep keeps the stored verdicts fresh;
 * the on-demand route re-checks whatever the user is actually looking at.
 */
export interface FileVerdict {
  id: string
  missing: boolean
}

/** The nivaro_files verdict columns are SHARED across environments while the
 *  physical storage is per-host (the staged-import queue lesson). Only the
 *  environment that actually holds the file corpus may persist verdicts —
 *  everyone else checks live and stamps nothing. Default is persist; local
 *  dev sets FILE_VERIFY_PERSIST=false in .env. */
function mayPersist(): boolean {
  return process.env.FILE_VERIFY_PERSIST !== 'false'
}

export async function verifyFiles(ids: string[]): Promise<FileVerdict[]> {
  if (ids.length === 0) return []
  const rows = (await db('nivaro_files')
    .whereIn('id', ids.slice(0, 200))
    .select('id', 'filename_disk', 'missing_at')) as Array<{
    id: string
    filename_disk: string | null
    missing_at: Date | null
  }>
  const storage = getStorage()
  const now = new Date()
  const verdicts: FileVerdict[] = []
  for (const row of rows) {
    let missing: boolean
    // The source could not be asked (unreachable / in trouble): no verdict to keep.
    let unknown = false
    if (!row.filename_disk) {
      missing = true
    } else if (typeof storage.exists === 'function') {
      missing = !(await storage.exists(row.filename_disk).catch(() => false))
      if (missing) {
        // After an environment refresh a file this instance has no copy of is still served
        // from the source environment (FILES_FALLBACK_DIR, then FILES_FALLBACK_URL) — the
        // download works, so the file is not missing. Ask the same places a read would.
        const there = await sourceHas(row.filename_disk)
        if (there === true) missing = false
        else if (there === null) unknown = true
      }
    } else {
      // Provider without a cheap check — fall back to "presumed present";
      // claiming missing without evidence would be worse.
      missing = false
    }
    if (unknown) {
      // Never call a file missing because the source environment did not answer.
      verdicts.push({ id: row.id, missing: false })
      continue
    }
    verdicts.push({ id: row.id, missing })
    if (!mayPersist()) continue
    const patch: Record<string, unknown> = { last_verified_at: now }
    if (missing && !row.missing_at) patch.missing_at = now
    if (!missing && row.missing_at) patch.missing_at = null
    // Persist best-effort — a verdict is still returned even if the stamp
    // write fails.
    await db('nivaro_files')
      .where('id', row.id)
      .update(patch)
      .catch(() => {})
  }
  return verdicts
}

/**
 * Nightly full sweep: verify every file row that has stored bytes, oldest
 * verification first, within a budget. Returns counts for the cron log.
 */
export async function fileIntegritySweep(budget = 5000): Promise<{
  checked: number
  missing: number
  newly_missing: number
}> {
  // A sweep that cannot persist is pure cost — skip entirely.
  if (!mayPersist()) return { checked: 0, missing: 0, newly_missing: 0 }
  const rows = (await db('nivaro_files')
    .whereNotNull('filename_disk')
    .orderBy([
      { column: 'last_verified_at', order: 'asc' },
      { column: 'id', order: 'asc' }
    ])
    .limit(budget)
    .select('id', 'missing_at')) as Array<{ id: string; missing_at: Date | null }>
  let missing = 0
  let newlyMissing = 0
  // verifyFiles persists as it goes; chunked so one bad batch can't stall all.
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100)
    const verdicts = await verifyFiles(chunk.map((r) => r.id))
    for (const v of verdicts) {
      if (!v.missing) continue
      missing++
      const was = chunk.find((r) => r.id === v.id)
      if (was && !was.missing_at) newlyMissing++
    }
  }
  return { checked: rows.length, missing, newly_missing: newlyMissing }
}
