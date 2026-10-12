import { db } from '../../db/index.js'
import { CLEANUP_DEFAULTS, type CleanupThresholds, normalizeCleanup } from './pure.js'

/**
 * Saved cleanup thresholds (#2020) — JSON in nivaro_extension_settings
 * (extension 'nivaro-core', key 'config_review_cleanup'), the same core
 * key/value home issue-groups uses, so no migration. The monthly cron and
 * the page start from these; anything missing, unreadable or out of bounds
 * falls back to CLEANUP_DEFAULTS.
 */

const EXT = 'nivaro-core'
const KEY = 'config_review_cleanup'

export async function loadCleanupDefaults(): Promise<CleanupThresholds> {
  try {
    const row = (await db('nivaro_extension_settings')
      .where({ extension_id: EXT, key: KEY })
      .first('value')) as { value: string | null } | undefined
    return normalizeCleanup(row?.value ? JSON.parse(row.value) : null, CLEANUP_DEFAULTS)
  } catch {
    return { ...CLEANUP_DEFAULTS }
  }
}

/** Store already-validated thresholds (validateCleanup). */
export async function saveCleanupDefaults(next: CleanupThresholds): Promise<void> {
  const value = JSON.stringify(next)
  const existing = (await db('nivaro_extension_settings')
    .where({ extension_id: EXT, key: KEY })
    .first('id')) as { id: number } | undefined
  if (existing) {
    await db('nivaro_extension_settings')
      .where({ id: existing.id })
      .update({ value, updated_at: new Date() })
  } else {
    await db('nivaro_extension_settings').insert({
      extension_id: EXT,
      key: KEY,
      value,
      updated_at: new Date()
    })
  }
}
