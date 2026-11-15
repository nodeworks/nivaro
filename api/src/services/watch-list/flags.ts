import { db } from '../../db/index.js'
import { tenantState } from '../ai-tenant-state.js'
import { normalizeWatchList, parsePreferences, type WatchListPrefs } from './store.js'
import { onWatchListSaved, WATCH_KEY } from './user-store.js'

/**
 * Who turned a watch-list feature on — alert rules, auto-add / auto-remove, the daily email —
 * read with one LIKE on the flag a save writes (store.ts `serializeWatchList`), never a scan of
 * every person's preferences per write. Kept 30 s per tenant; a save in this process drops it at
 * once (another process sees the change within 30 s).
 */

export type WatchFlag = 'wl_alerts' | 'wl_auto' | 'wl_digest' | 'wl_done'

const TTL_MS = 30_000
const MAX_PEOPLE = 5000

interface Entry {
  at: number
  people: Map<string, WatchListPrefs>
  pending?: Promise<Map<string, WatchListPrefs>>
}

const cache = tenantState(() => new Map<WatchFlag, Entry>())

onWatchListSaved(() => {
  try {
    cache().clear()
  } catch {
    /* no tenant context: nothing cached here */
  }
})

/** The people with `flag` set, with their (normalized) lists. */
export async function peopleWith(
  flag: WatchFlag,
  now: number = Date.now()
): Promise<Map<string, WatchListPrefs>> {
  const c = cache()
  const hit = c.get(flag)
  if (hit && now - hit.at < TTL_MS) return hit.pending ?? hit.people
  const pending = (async () => {
    const rows = (await db('nivaro_users')
      .where('preferences', 'like', `%"${flag}":true%`)
      .limit(MAX_PEOPLE)
      .select('id', 'preferences')
      .catch(() => [])) as Array<{ id: string; preferences: unknown }>
    const out = new Map<string, WatchListPrefs>()
    for (const r of rows) {
      const prefs = parsePreferences(r.preferences)
      const raw = prefs[WATCH_KEY] as Record<string, unknown> | undefined
      if (raw?.[flag] !== true) continue
      out.set(String(r.id), normalizeWatchList(raw))
    }
    return out
  })()
  c.set(flag, { at: now, people: new Map(), pending })
  const people = await pending
  c.set(flag, { at: now, people })
  return people
}

/** Drop the cached lists (tests; a save does it on its own). */
export function forgetWatchFlags(): void {
  cache().clear()
}
