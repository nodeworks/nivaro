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

/** Tries one person's read → change → write gets before giving up (another writer kept winning). */
const CAS_ATTEMPTS = 3

/**
 * Writes for one person run one after another in this process: two changes to the same row
 * (two members pinning to a shared list at once) never read the same starting point here.
 * Across processes the compare-and-swap below catches it.
 */
const ownerQueues = new Map<string, Promise<unknown>>()
function serialized<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const key = userId.toLowerCase()
  const prev = ownerQueues.get(key) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  const tail = run.catch(() => undefined)
  ownerQueues.set(key, tail)
  void tail.then(() => {
    if (ownerQueues.get(key) === tail) ownerQueues.delete(key)
  })
  return run
}

function notifySaved(userId: string, announce: boolean | undefined): void {
  for (const fn of saveListeners) {
    try {
      fn()
    } catch {
      /* a cache that cannot drop simply expires */
    }
  }
  if (announce !== false) announcePrefsChanged(userId, [WATCH_KEY])
}

/**
 * Read → change → write ONE person's preferences row as a compare-and-swap (security review
 * L6): the UPDATE only lands while the row still holds exactly what was read
 * (`WHERE preferences = <read>`, or IS NULL); otherwise it re-reads and re-applies `fn`, up to
 * CAS_ATTEMPTS times. `fn` returns the next list, or null for "nothing to change". A person with
 * no row is left alone. Every other preference key is kept as it is on the row.
 */
async function casWatchList(
  userId: string,
  fn: (list: WatchListPrefs) => WatchListPrefs | null
): Promise<WatchListPrefs | null> {
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
    const row = (await db('nivaro_users').where({ id: userId }).first('preferences')) as
      | { preferences?: unknown }
      | undefined
    if (!row) return null
    const raw = row.preferences
    const prefs = parsePreferences(raw)
    const next = fn(normalizeWatchList(prefs[WATCH_KEY]))
    if (!next) return null
    const value = JSON.stringify({ ...prefs, [WATCH_KEY]: serializeWatchList(next) })
    let q = db('nivaro_users').where({ id: userId })
    q =
      raw == null
        ? q.whereNull('preferences')
        : q.where('preferences', typeof raw === 'string' ? raw : JSON.stringify(raw))
    const n = await q.update({ preferences: value })
    if (Number(Array.isArray(n) ? n.length : n) > 0) return next
  }
  throw Object.assign(new Error('The watch list changed while saving. Try again.'), {
    statusCode: 409,
    code: 'WATCH_LIST_BUSY'
  })
}

/** Store this list as the person's watch list (other preferences kept). */
export async function saveWatchList(
  userId: string,
  list: WatchListPrefs,
  opts: { announce?: boolean } = {}
): Promise<void> {
  const saved = await serialized(userId, () => casWatchList(userId, () => list))
  if (saved) notifySaved(userId, opts.announce)
}

/**
 * Read → change → write for one person, applied to what the row holds at write time (never to
 * an older copy). `fn` returns the next list, or null for "nothing to change" (no write).
 */
export async function updateWatchList(
  userId: string,
  fn: (list: WatchListPrefs) => WatchListPrefs | null,
  opts: { announce?: boolean } = {}
): Promise<WatchListPrefs | null> {
  const saved = await serialized(userId, () => casWatchList(userId, fn))
  if (saved) notifySaved(userId, opts.announce)
  return saved
}
