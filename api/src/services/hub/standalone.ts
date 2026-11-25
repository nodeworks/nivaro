import { db } from '../../db/index.js'
import { hubModeEnabled } from './mode.js'

/**
 * A standalone Hub: HUB=on on an install that holds no app data of its own (no collection beyond
 * Nivaro's and Directus's system tables). GET /api/app-info then lists feature `hub_only` and the
 * admin sidebar keeps only the pages a Hub needs (admin/src/layouts/nav-config.ts HUB_ONLY_NAV).
 * An install that is a Hub AND an app (a dev API with HUB=on beside its own collections) keeps
 * the full sidebar. Any read failure answers false: the full sidebar, never a missing page.
 */

const SYSTEM_TABLE = /^(nivaro|directus)_/i
/**
 * Collections every install gets from core migrations without a system prefix — they are
 * Nivaro's own, not an app's. `ideas` = the idea board (migration 446): a fresh standalone Hub
 * holds it, so without this every new Hub showed the full sidebar (2026-11-25).
 */
const CORE_COLLECTIONS = new Set(['ideas'])

export async function hasAppCollections(): Promise<boolean> {
  const rows = (await db('nivaro_collections').select('collection')) as Array<{
    collection: unknown
  }>
  return rows.some(
    (r) =>
      typeof r.collection === 'string' &&
      !SYSTEM_TABLE.test(r.collection) &&
      !CORE_COLLECTIONS.has(r.collection.toLowerCase())
  )
}

export async function hubStandalone(
  deps: { env?: NodeJS.ProcessEnv; hasAppCollections?: () => Promise<boolean> } = {}
): Promise<boolean> {
  if (!hubModeEnabled(deps.env)) return false
  try {
    return !(await (deps.hasAppCollections ?? hasAppCollections)())
  } catch {
    return false
  }
}
