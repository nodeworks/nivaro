import { db } from '../../db/index.js'
import { announcePrefsChanged } from '../user-sync.js'
import {
  normalizeWatchList,
  parsePreferences,
  serializeWatchList,
  type WatchListPrefs
} from './store.js'

/**
 * Read and write ONE person's watch list (`nivaro_users.preferences.watch_list`). The routes use
 * it for the person themselves; the background passes (alerts, auto-add, shared lists, the daily
 * email) use it for others. Every write re-reads the row first so a preference saved meanwhile is
 * kept, tells the person's tabs (`prefs:changed`) unless asked not to, and drops this process's
 * cached "who turned what on" lists (services/watch-list/flags.ts).
 */

export const WATCH_KEY = 'watch_list'

type Listener = () => void
const saveListeners = new Set<Listener>()
/** Called after every save (the flag caches drop their copy). */
export function onWatchListSaved(fn: Listener): () => void {
  saveListeners.add(fn)
  return () => saveListeners.delete(fn)
}

export async function loadWatchList(userId: string): Promise<{
  prefs: Record<string, unknown>
  list: WatchListPrefs
}> {
  const row = (await db('nivaro_users').where({ id: userId }).first('preferences')) as
    | { preferences?: unknown }
    | undefined
  const prefs = parsePreferences(row?.preferences)
  return { prefs, list: normalizeWatchList(prefs[WATCH_KEY]) }
}

export async function saveWatchList(
  userId: string,
  list: WatchListPrefs,
  opts: { announce?: boolean } = {}
): Promise<void> {
  const { prefs } = await loadWatchList(userId)
  await db('nivaro_users')
    .where({ id: userId })
    .update({ preferences: JSON.stringify({ ...prefs, [WATCH_KEY]: serializeWatchList(list) }) })
  for (const fn of saveListeners) {
    try {
      fn()
    } catch {
      /* a cache that cannot drop simply expires */
    }
  }
  if (opts.announce !== false) announcePrefsChanged(userId, [WATCH_KEY])
}

/**
 * Read → change → write for one person. `fn` returns the next list, or null for "nothing to
 * change" (no write).
 */
export async function updateWatchList(
  userId: string,
  fn: (list: WatchListPrefs) => WatchListPrefs | null,
  opts: { announce?: boolean } = {}
): Promise<WatchListPrefs | null> {
  const { list } = await loadWatchList(userId)
  const next = fn(list)
  if (!next) return null
  await saveWatchList(userId, next, opts)
  return next
}
