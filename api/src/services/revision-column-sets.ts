import { db } from '../db/index.js'

/**
 * Shared column sets for the Revision history table (2026-11-17): named sets of columns an
 * administrator saves for a collection ("Finance audit", "Approver view"), each optionally the
 * default for some roles. A person's own picks always win; a role default is used before the
 * "fields that changed" fallback.
 *
 * Stored without a migration as one `nivaro_extension_settings` row per collection (extension
 * 'nivaro-core', key `revision_column_sets:<collection>`) holding {sets: [...]} — configuration,
 * so it travels with promote:config like collection pins.
 */

export const SETS_EXT = 'nivaro-core'
export const MAX_SETS = 30
const FIELD_RE = /^\$?[A-Za-z_][A-Za-z0-9_:-]{0,190}$/
const COLLECTION_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface ColumnSet {
  id: string
  name: string
  fields: string[]
  /** Role ids this set is the default for. */
  default_roles: string[]
  /** The collection's default for everyone (one set at most); a role's own default wins. */
  is_default: boolean
}

export const setsKey = (collection: string) => `revision_column_sets:${collection}`
export const validCollection = (c: string) => COLLECTION_RE.test(c)

/** A body's sets → clean sets, or why they are refused. Exported for tests. */
export function normalizeSets(raw: unknown): { sets: ColumnSet[] } | { error: string } {
  if (!Array.isArray(raw)) return { error: 'sets must be a list' }
  if (raw.length > MAX_SETS) return { error: `At most ${MAX_SETS} column sets` }
  const sets: ColumnSet[] = []
  const names = new Set<string>()
  let defaultTaken = false
  for (const [i, s] of raw.entries()) {
    const o = (s ?? {}) as Record<string, unknown>
    const name = String(o.name ?? '')
      .trim()
      .slice(0, 60)
    if (!name) return { error: 'Every column set needs a name' }
    if (names.has(name.toLowerCase())) return { error: `Two sets are called ${name}` }
    names.add(name.toLowerCase())
    const fields = Array.isArray(o.fields) ? o.fields : []
    if (fields.length > 200 || fields.some((f) => typeof f !== 'string' || !FIELD_RE.test(f)))
      return { error: `${name}: fields must be up to 200 field names` }
    const roles = Array.isArray(o.default_roles) ? o.default_roles : []
    if (roles.some((r) => typeof r !== 'string' || !UUID_RE.test(r)))
      return { error: `${name}: default_roles must be role ids` }
    const id =
      typeof o.id === 'string' && /^[\w-]{1,40}$/.test(o.id)
        ? o.id
        : `set-${Date.now().toString(36)}-${i}`
    const isDefault = o.is_default === true && !defaultTaken
    if (isDefault) defaultTaken = true
    sets.push({
      id,
      name,
      fields: [...new Set(fields as string[])],
      default_roles: [...new Set((roles as string[]).map((r) => r.toUpperCase()))],
      is_default: isDefault
    })
  }
  return { sets }
}

export async function loadSets(collection: string): Promise<ColumnSet[]> {
  try {
    const row = (await db('nivaro_extension_settings')
      .where({ extension_id: SETS_EXT, key: setsKey(collection) })
      .first('value')) as { value: string | null } | undefined
    const parsed = JSON.parse(row?.value ?? '{}') as { sets?: unknown }
    const clean = normalizeSets(parsed.sets ?? [])
    return 'sets' in clean ? clean.sets : []
  } catch {
    return []
  }
}

export async function saveSets(collection: string, sets: ColumnSet[]): Promise<void> {
  const key = setsKey(collection)
  const value = JSON.stringify({ sets })
  const existing = (await db('nivaro_extension_settings')
    .where({ extension_id: SETS_EXT, key })
    .first('id')) as { id: number } | undefined
  if (existing) {
    await db('nivaro_extension_settings')
      .where({ id: existing.id })
      .update({ value, updated_at: new Date() })
  } else {
    await db('nivaro_extension_settings').insert({
      extension_id: SETS_EXT,
      key,
      value,
      updated_at: new Date()
    })
  }
}

/** The set that is the default for this role (the first one listing it), if any. */
export function roleDefault(
  sets: ColumnSet[],
  roleId: string | null | undefined
): ColumnSet | null {
  // The person's role default first, else the collection's default for everyone.
  const r = roleId?.toUpperCase()
  return (
    (r ? sets.find((s) => s.default_roles.includes(r)) : undefined) ??
    sets.find((s) => s.is_default) ??
    null
  )
}
