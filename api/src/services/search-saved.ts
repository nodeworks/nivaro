import { randomUUID } from 'node:crypto'
import { db } from '../db/index.js'
import { updateUser } from './users.js'

/**
 * Saved searches (search program 2026-10-28, item 13): a person's own named
 * queries in `nivaro_users.preferences.saved_searches` — no table, no migration.
 * Written through updateUser (users service) so the user-row caches see it.
 * Only the owner reads or writes their list; the query is re-run as them, so a
 * saved search never carries results or anyone else's access.
 */

export const SAVED_MAX = 25

export interface SavedSearch {
  id: string
  name: string
  q: string
  scope: string | null
  created_at: string
}

export class SavedSearchError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message)
  }
}

/** A stored list as it can be trusted: well-formed entries only, capped. */
export function normalizeSaved(raw: unknown): SavedSearch[] {
  if (!Array.isArray(raw)) return []
  const out: SavedSearch[] = []
  const seen = new Set<string>()
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue
    const r = e as Record<string, unknown>
    const id = typeof r.id === 'string' ? r.id.slice(0, 64) : ''
    const q = typeof r.q === 'string' ? r.q.trim().slice(0, 200) : ''
    if (!id || !q || seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      name: (typeof r.name === 'string' && r.name.trim().slice(0, 80)) || q.slice(0, 80),
      q,
      scope: typeof r.scope === 'string' && r.scope.trim() ? r.scope.trim().slice(0, 32) : null,
      created_at: typeof r.created_at === 'string' ? r.created_at : new Date(0).toISOString()
    })
    if (out.length >= SAVED_MAX) break
  }
  return out
}

/** The list with one search added (pure). The same q + scope replaces its older copy. */
export function addSaved(
  list: SavedSearch[],
  input: { name?: unknown; q?: unknown; scope?: unknown },
  now: Date = new Date(),
  id: string = randomUUID()
): { list: SavedSearch[]; entry: SavedSearch } {
  const q = typeof input.q === 'string' ? input.q.replace(/\s+/g, ' ').trim().slice(0, 200) : ''
  if (q.length < 1) throw new SavedSearchError(400, 'q is required')
  const scope =
    typeof input.scope === 'string' && input.scope.trim() ? input.scope.trim().slice(0, 32) : null
  const name =
    (typeof input.name === 'string' && input.name.replace(/\s+/g, ' ').trim().slice(0, 80)) ||
    q.slice(0, 80)
  const entry: SavedSearch = { id, name, q, scope, created_at: now.toISOString() }
  const rest = list.filter((s) => !(s.q === q && s.scope === scope))
  if (rest.length >= SAVED_MAX)
    throw new SavedSearchError(409, `At most ${SAVED_MAX} saved searches — delete one first`)
  return { list: [entry, ...rest], entry }
}

export function removeSaved(list: SavedSearch[], id: string): SavedSearch[] | null {
  const next = list.filter((s) => s.id !== id)
  return next.length === list.length ? null : next
}

async function readPreferences(userId: string): Promise<Record<string, unknown>> {
  const row = (await db('nivaro_users').where({ id: userId }).first('preferences')) as
    | { preferences?: unknown }
    | undefined
  const raw = row?.preferences
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export async function listSavedSearches(userId: string): Promise<SavedSearch[]> {
  return normalizeSaved((await readPreferences(userId)).saved_searches)
}

async function writeSaved(userId: string, list: SavedSearch[]): Promise<void> {
  const prefs = await readPreferences(userId)
  await updateUser(userId, { preferences: { ...prefs, saved_searches: list } })
}

export async function createSavedSearch(
  userId: string,
  input: { name?: unknown; q?: unknown; scope?: unknown }
): Promise<SavedSearch> {
  const { list, entry } = addSaved(await listSavedSearches(userId), input)
  await writeSaved(userId, list)
  return entry
}

export async function deleteSavedSearch(userId: string, id: string): Promise<boolean> {
  const next = removeSaved(await listSavedSearches(userId), id)
  if (!next) return false
  await writeSaved(userId, next)
  return true
}
