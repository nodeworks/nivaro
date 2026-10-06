/**
 * Polymorphic (M2A) links on REST (#1220) — the pure half.
 *
 * An M2A alias (`inventory_request.internal_contact`) is a junction whose item
 * column points at a different collection per row, named by a discriminator
 * column. The alias leg carries `junction_field` (the item column); the
 * COMPANION leg (`many_collection = junction, many_field = item column`) carries
 * the discriminator name and the allowed list — never the alias leg.
 *
 * `fields=internal_contact.*` answers one row per link:
 *   { id: <junction row id>, <discriminator>: 'directus_users', item_id, item }
 * where `item` is the linked record read as the caller (or null when the
 * collection is unknown, unreadable, or the record is gone).
 */

/** Fields the link row itself carries — never forwarded to the item read. */
const LINK_KEYS = new Set(['id', 'item_id', 'item'])

/** Parse `one_allowed_collections`: a JSON array on newer rows, a bare comma
 *  list on legacy Directus rows. */
export function parseAllowedList(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean)
  if (typeof raw !== 'string' || raw.trim() === '') return []
  const trimmed = raw.trim()
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed)
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean)
    } catch {
      // fall through to the comma list
    }
  }
  return trimmed
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((c) => c.trim().replace(/^"|"$/g, ''))
    .filter(Boolean)
}

/**
 * The collection a stored discriminator value should be read from, or null
 * when the link names a collection the relation does not allow. Legacy
 * Directus rows say `directus_users`; those people live in `nivaro_users`
 * (same uuid space).
 */
export function m2aReadCollection(stored: unknown, allowed: string[]): string | null {
  if (typeof stored !== 'string' || stored.trim() === '') return null
  const name = stored.trim()
  const match = allowed.find((a) => a.toLowerCase() === name.toLowerCase())
  if (!match) return null
  const lower = match.toLowerCase()
  if (lower === 'directus_users' || lower === 'nivaro_users') return 'nivaro_users'
  return match
}

/**
 * Which fields of the linked record a `fields=` entry asks for.
 *   `alias.*`          → ['*']
 *   `alias.item.*`     → ['*']
 *   `alias.item.name`  → ['name']
 *   `alias.name`       → ['name']   (shorthand: a non-link key means the item)
 *   `alias.item`       → ['*']
 *   `alias.id` only    → []         (only link keys asked — the item is not read)
 */
export function m2aItemFields(requested: string[], discriminator: string): string[] {
  const out: string[] = []
  let wantsItem = false
  for (const raw of requested) {
    const f = raw.trim()
    if (!f) continue
    if (f === '*' || f === 'item.*' || f === 'item') return ['*']
    if (f.startsWith('item.')) {
      out.push(f.slice(5))
      wantsItem = true
      continue
    }
    if (LINK_KEYS.has(f) || f === discriminator) continue
    out.push(f)
    wantsItem = true
  }
  return wantsItem ? [...new Set(out)] : []
}

/** Ids compare case-insensitively: uniqueidentifiers come back upper-case,
 *  junction rows store either case. */
export function m2aIdKey(id: unknown): string {
  return String(id).toUpperCase()
}
