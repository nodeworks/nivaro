/**
 * #3227 — personal sidebar layouts and per-role starters.
 *
 * A layout only REARRANGES the admin's own nav map (layouts/nav-config.ts):
 * per category, which items are pinned to the top, which are hidden, and the
 * order inside each section. It never names a page the map does not already
 * have, and the client applies it AFTER the role's ui_permissions filter, so a
 * layout can never surface a page the person's role cannot open.
 *
 * Stored as:
 *  - a person's own: `nivaro_users.preferences.nav_layout` (PATCH /users/me/preferences)
 *  - a role's starter: `nivaro_settings.nav_role_defaults` = `{ <ROLE UUID>: layout }`
 *    (migration 520; written only by routes/nav-layout.ts)
 *
 * Effective layout = the person's own, else their role's starter, else the
 * code default. "Reset to default" clears the person's own.
 */

export interface NavLayoutCategory {
  order?: string[]
  hidden?: string[]
  pinned?: string[]
}

export interface NavLayout {
  v: 1
  categories: Record<string, NavLayoutCategory>
}

const CATEGORY_ID = /^[a-z0-9_-]{1,40}$/i
const PATH = /^\/(?!\/)\S{0,499}$/
const MAX_CATEGORIES = 30
const MAX_ORDER = 120
const MAX_HIDDEN = 120
const MAX_PINNED = 20
const ROLE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function cleanPaths(raw: unknown, max: number): string[] | null {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) return null
  const out: string[] = []
  for (const v of raw) {
    if (typeof v !== 'string') continue
    const p = v.trim()
    if (!PATH.test(p) || out.includes(p)) continue
    out.push(p)
    if (out.length >= max) break
  }
  return out
}

/**
 * Validate and trim a layout. `null`/empty answers `{ layout: null }` (no
 * layout = the default). Unknown keys are dropped; a malformed shape is an error.
 */
export function normalizeNavLayout(raw: unknown): { layout: NavLayout | null; error?: string } {
  if (raw === null || raw === undefined || raw === '') return { layout: null }
  let value = raw
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return { layout: null, error: 'nav_layout must be JSON' }
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { layout: null, error: 'nav_layout must be an object' }
  }
  const cats = (value as { categories?: unknown }).categories
  if (cats === undefined || cats === null) return { layout: null }
  if (typeof cats !== 'object' || Array.isArray(cats)) {
    return { layout: null, error: 'nav_layout.categories must be an object' }
  }
  const categories: Record<string, NavLayoutCategory> = {}
  let count = 0
  for (const [id, entry] of Object.entries(cats as Record<string, unknown>)) {
    if (!CATEGORY_ID.test(id)) continue
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { layout: null, error: `nav_layout.categories.${id} must be an object` }
    }
    const e = entry as Record<string, unknown>
    const order = cleanPaths(e.order, MAX_ORDER)
    const hidden = cleanPaths(e.hidden, MAX_HIDDEN)
    const pinned = cleanPaths(e.pinned, MAX_PINNED)
    if (!order || !hidden || !pinned) {
      return {
        layout: null,
        error: `nav_layout.categories.${id}: order, hidden and pinned are lists of paths`
      }
    }
    if (order.length === 0 && hidden.length === 0 && pinned.length === 0) continue
    categories[id] = {
      ...(order.length ? { order } : {}),
      ...(hidden.length ? { hidden } : {}),
      ...(pinned.length ? { pinned } : {})
    }
    if (++count >= MAX_CATEGORIES) break
  }
  if (Object.keys(categories).length === 0) return { layout: null }
  return { layout: { v: 1, categories } }
}

/** `nivaro_settings.nav_role_defaults` as a map keyed by UPPER-CASE role uuid. */
export function parseNavRoleDefaults(raw: unknown): Record<string, NavLayout> {
  let value = raw
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return {}
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, NavLayout> = {}
  for (const [role, layout] of Object.entries(value as Record<string, unknown>)) {
    if (!ROLE_ID.test(role)) continue
    const n = normalizeNavLayout(layout)
    if (n.layout) out[role.toUpperCase()] = n.layout
  }
  return out
}

export function isRoleId(v: unknown): v is string {
  return typeof v === 'string' && ROLE_ID.test(v)
}

/** The starter for one role from the stored map (null = none set). */
export function starterForRole(map: Record<string, NavLayout>, role: unknown): NavLayout | null {
  if (typeof role !== 'string' || !role) return null
  return map[role.toUpperCase()] ?? null
}
