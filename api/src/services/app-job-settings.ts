/**
 * Hub phase 5 — an app's own job settings on a shared deployment (`perAppJobs()`).
 *
 * Phase 5 has one per-app job setting: pause. An app admin's pause or resume writes that app's
 * `nivaro_settings.paused_crons` (the same JSON string[] of job ids self-hosted writes) and
 * stops the job in that app only; the process-wide paused set (plugins/cron.ts `pausedIds`) is
 * never touched there. Schedules, time zones and chains stay deployment-wide (routes/cron.ts
 * answers 409 SCHEDULE_IS_DEPLOYMENT_WIDE).
 *
 * Reads go through a 60 s cache keyed by tenant id (one process serves many apps, so a module
 * variable would let one app's pauses answer for another). A pause or resume forgets that app's
 * entry at once. Self-hosted and Nivaro Cloud never read this module.
 */
import { getTenantId } from '../db/tenant-context.js'
import { registerAppKeyed } from './app-forget.js'

const TTL_MS = 60_000
const MAX_ENTRIES = 5000

const cache = registerAppKeyed(new Map<string, { at: number; ids: Set<string> }>())

/** The cache key for the current request or job: the tenant id ('' outside a tenant). */
function tenantKey(): string {
  return getTenantId() ?? ''
}

/** A stored paused_crons value as job ids; anything unreadable is nothing paused. */
function parsePaused(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw) return []
  try {
    const ids = JSON.parse(raw)
    return Array.isArray(ids) ? ids.map(String) : []
  } catch {
    return []
  }
}

/** The current app's database: inside a tenant context, that app's own (db/index.ts). */
async function appDb() {
  const { resolveDb } = await import('../db/index.js')
  return resolveDb()
}

/** The current app's paused job ids, straight from its settings row (no cache). */
async function readPaused(): Promise<string[]> {
  const db = await appDb()
  const row = (await db('nivaro_settings').orderBy('id', 'asc').first('paused_crons')) as
    | { paused_crons?: string | null }
    | undefined
  return parsePaused(row?.paused_crons)
}

/** The current app's paused job ids (its nivaro_settings.paused_crons), cached 60 s per app. */
export async function appPausedCrons(): Promise<Set<string>> {
  const key = tenantKey()
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < TTL_MS) return new Set(hit.ids)
  let ids: string[] = []
  try {
    ids = await readPaused()
  } catch {
    /* column mid-migration or the app's database unreachable: nothing paused */
  }
  if (cache.size >= MAX_ENTRIES) cache.clear()
  cache.set(key, { at: Date.now(), ids: new Set(ids) })
  return new Set(ids)
}

/** Forget one app's cached job settings (its pause or resume was just written). */
export function forgetAppJobSettings(tenantId: string): void {
  cache.delete(tenantId)
}

/**
 * Pause or resume `id` for the current app only: rewrites that app's paused_crons (same JSON as
 * the self-hosted route) and forgets its cache. A failed read or write throws (the route answers
 * 500): nothing else would hold the pause, and a guessed list would drop the app's other pauses.
 */
export async function setAppJobPaused(id: string, paused: boolean): Promise<string[]> {
  const key = tenantKey()
  const db = await appDb()
  const firstRow = async () =>
    (await db('nivaro_settings').orderBy('id', 'asc').first('id', 'paused_crons')) as
      | { id: number; paused_crons?: string | null }
      | undefined
  let row = await firstRow()
  // An app database installed from empty has no settings row yet: the first pause creates it
  // (as the first settings save does), or the pause would answer "paused" and keep nothing. It
  // then re-reads the FIRST row: two first pauses at once may both insert, and every reader uses
  // the first row, so a second row has no effect.
  if (!row && paused) {
    await db('nivaro_settings').insert({ updated_at: new Date() })
    row = await firstRow()
  }
  const current = parsePaused(row?.paused_crons)
  const next = paused
    ? current.includes(id)
      ? current
      : [...current, id]
    : current.filter((x) => x !== id)
  if (row) {
    await db('nivaro_settings')
      .where({ id: row.id })
      .update({ paused_crons: JSON.stringify(next) })
  }
  forgetAppJobSettings(key)
  return next
}
