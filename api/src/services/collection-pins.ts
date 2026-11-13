import { db } from '../db/index.js'
import { isDefaultWorkspace } from '../middleware/workspace.js'

/**
 * Pinned collections (2026-11-13): the short list of collections an administrator puts at
 * the top of the Collections page for EVERYONE, in the order they choose. Personal
 * favorites are something else (users.preferences.nav_favorites, the sidebar's Favorites).
 *
 * Stored without a migration as one `nivaro_extension_settings` row (extension
 * 'nivaro-core', key `collection_pins` for the default workspace, `collection_pins:<id>`
 * for any other) holding a JSON array of collection names. That table is configuration:
 * it moves the config epoch at the driver seam and promote:config already copies it, so
 * pins travel dev → staging with the rest of the config. Written only by PUT
 * /api/collection-pins (admin); read by GET /api/collection-pins, which answers only the
 * collections the caller may read (a pin never reveals a collection to someone who cannot
 * see it).
 */

export const PIN_EXT = 'nivaro-core'
export const MAX_PINS = 24
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,127}$/

export function pinsKey(workspaceId: string | null | undefined): string {
  if (!workspaceId || isDefaultWorkspace(workspaceId)) return 'collection_pins'
  return `collection_pins:${workspaceId.toLowerCase()}`
}

/** A request body's list → the clean list (order kept, repeats dropped), or why it is refused. */
export function normalizePinList(raw: unknown): { list: string[] } | { error: string } {
  if (!Array.isArray(raw)) return { error: 'collections must be a list of collection names' }
  const list: string[] = []
  for (const v of raw) {
    if (typeof v !== 'string') return { error: 'collections must be a list of collection names' }
    const name = v.trim()
    if (!name) continue
    if (!NAME_RE.test(name)) return { error: `Not a collection name: ${name.slice(0, 80)}` }
    if (!list.includes(name)) list.push(name)
  }
  if (list.length > MAX_PINS) return { error: `At most ${MAX_PINS} pinned collections` }
  return { list }
}

/** The stored JSON → names (junk reads as no pins, never an error). */
export function parseStoredPins(value: unknown): string[] {
  if (typeof value !== 'string' || !value) return []
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((v): v is string => typeof v === 'string' && NAME_RE.test(v))
  } catch {
    return []
  }
}

/** What a save changed, in words for the activity log; null = nothing changed. */
export function describePinChange(before: string[], after: string[]): string | null {
  const added = after.filter((n) => !before.includes(n))
  const removed = before.filter((n) => !after.includes(n))
  const parts: string[] = []
  if (added.length) parts.push(`pinned ${added.join(', ')}`)
  if (removed.length) parts.push(`unpinned ${removed.join(', ')}`)
  if (!parts.length) {
    if (before.join('\u0001') === after.join('\u0001')) return null
    parts.push(`reordered (${after.join(', ')})`)
  }
  return `Pinned collections: ${parts.join('; ')}`
}

export async function loadPins(workspaceId: string | null | undefined): Promise<string[]> {
  try {
    const row = (await db('nivaro_extension_settings')
      .where({ extension_id: PIN_EXT, key: pinsKey(workspaceId) })
      .first('value')) as { value: string | null } | undefined
    return parseStoredPins(row?.value ?? null)
  } catch {
    return []
  }
}

export async function savePins(workspaceId: string | null | undefined, list: string[]) {
  const key = pinsKey(workspaceId)
  const value = JSON.stringify(list)
  const existing = (await db('nivaro_extension_settings')
    .where({ extension_id: PIN_EXT, key })
    .first('id')) as { id: number } | undefined
  if (existing) {
    await db('nivaro_extension_settings')
      .where({ id: existing.id })
      .update({ value, updated_at: new Date() })
  } else {
    await db('nivaro_extension_settings').insert({
      extension_id: PIN_EXT,
      key,
      value,
      updated_at: new Date()
    })
  }
}

/**
 * Which of `names` are registered collections of this workspace (or of none) — and not
 * folders (a row another row names as its `group` is a folder, never a collection).
 */
export async function registeredCollections(
  workspaceId: string | null | undefined,
  names: string[]
): Promise<Set<string>> {
  if (!names.length) return new Set()
  const q = db('nivaro_collections').whereIn('collection', names).select('collection')
  if (workspaceId)
    q.where(function () {
      this.where('workspace', workspaceId).orWhereNull('workspace')
    })
  const [rows, folders] = await Promise.all([
    q as Promise<Array<{ collection: string }>>,
    db('nivaro_collections').whereIn('group', names).distinct('group') as Promise<
      Array<{ group: string }>
    >
  ])
  const folderSet = new Set(folders.map((f) => f.group))
  return new Set(rows.map((r) => r.collection).filter((c) => !folderSet.has(c)))
}
