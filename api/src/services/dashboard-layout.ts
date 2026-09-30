// A person's home-page layout (#848) and the per-role defaults an admin
// publishes (#917) share one shape and one validator. The layout is stored
// as JSON — on `nivaro_users.preferences.dashboard` for a person, in
// `nivaro_settings.dashboard_role_defaults` keyed by role id for a role — and
// both writers run every incoming blob through `normalizeDashboardLayout`
// before it lands: a client may only ever store a layout the renderer can
// draw, capped in size so a preference blob cannot grow without bound.
//
// The shape is deliberately host-agnostic: `kind` says what the cell holds,
// `key` names a widget or a tile in the HOST's catalog (never validated here —
// a catalog entry the host no longer has renders as a "gone" placeholder, and
// the person removes it), and a `section` carries one level of children on
// its own 12-column grid. Nothing deeper.

export type DashboardItemKind = 'widget' | 'section' | 'figures'

export interface DashboardItem {
  id: string
  kind: DashboardItemKind
  /** Catalog widget key (kind 'widget'). */
  key?: string
  x: number
  y: number
  w: number
  h: number
  /** Section title (kind 'section'); a report widget's name (kind 'widget'). */
  title?: string
  /** Section folded to its header (kind 'section'). */
  collapsed?: boolean
  /** Tile catalog keys, in order (kind 'figures'). */
  tiles?: string[]
  /** Inner grid (kind 'section' only; children never nest further). */
  children?: DashboardItem[]
}

export interface DashboardLayout {
  version: 1
  items: DashboardItem[]
}

export const DASHBOARD_LAYOUT_COLUMNS = 12
export const DASHBOARD_LAYOUT_MAX_BYTES = 64 * 1024
const MAX_TOP_ITEMS = 200
const MAX_TOTAL_ITEMS = 400
const MAX_TILES = 40
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/

type Result = { layout: DashboardLayout; error?: undefined } | { error: string; layout?: undefined }

const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max

function normalizeItem(
  raw: unknown,
  path: string,
  seen: Set<string>,
  depth: number
): { item: DashboardItem } | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: `${path} must be an object` }
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || !ID_RE.test(r.id)) return { error: `${path}.id must be a short id` }
  if (seen.has(r.id)) return { error: `${path}.id "${r.id}" is used twice` }
  seen.add(r.id)
  const kind = r.kind
  if (kind !== 'widget' && kind !== 'section' && kind !== 'figures')
    return { error: `${path}.kind must be widget, section or figures` }
  if (!isInt(r.x, 0, DASHBOARD_LAYOUT_COLUMNS - 1)) return { error: `${path}.x must be 0–11` }
  if (!isInt(r.w, 1, DASHBOARD_LAYOUT_COLUMNS)) return { error: `${path}.w must be 1–12` }
  if (r.x + r.w > DASHBOARD_LAYOUT_COLUMNS) return { error: `${path} runs past the last column` }
  if (!isInt(r.y, 0, 10_000)) return { error: `${path}.y must be a whole number` }
  if (!isInt(r.h, 1, 40)) return { error: `${path}.h must be 1–40` }
  const item: DashboardItem = { id: r.id, kind, x: r.x, y: r.y, w: r.w, h: r.h }

  if (kind === 'widget') {
    if (typeof r.key !== 'string' || r.key.trim() === '' || r.key.length > 80)
      return { error: `${path}.key must name a widget` }
    item.key = r.key.trim()
    // A widget placed from a report (#1044) carries its own name — the host
    // cannot know a report widget's title from the key alone.
    if (r.title != null) {
      if (typeof r.title !== 'string') return { error: `${path}.title must be text` }
      const t = r.title.trim().slice(0, 80)
      if (t) item.title = t
    }
  }
  if (kind === 'section') {
    if (depth > 0) return { error: `${path}: a section cannot sit inside a section` }
    if (r.title != null) {
      if (typeof r.title !== 'string') return { error: `${path}.title must be text` }
      item.title = r.title.trim().slice(0, 80)
    }
    if (r.collapsed === true) item.collapsed = true
    const kids = r.children ?? []
    if (!Array.isArray(kids)) return { error: `${path}.children must be a list` }
    const children: DashboardItem[] = []
    for (let i = 0; i < kids.length; i++) {
      const c = normalizeItem(kids[i], `${path}.children[${i}]`, seen, depth + 1)
      if ('error' in c) return c
      children.push(c.item)
    }
    item.children = children
  }
  if (kind === 'figures') {
    const tiles = r.tiles ?? []
    if (!Array.isArray(tiles) || tiles.length > MAX_TILES)
      return { error: `${path}.tiles must be a list of at most ${MAX_TILES}` }
    const clean: string[] = []
    for (const t of tiles) {
      if (typeof t !== 'string' || t.trim() === '' || t.length > 80)
        return { error: `${path}.tiles must name tiles` }
      if (!clean.includes(t.trim())) clean.push(t.trim())
    }
    item.tiles = clean
  }
  return { item }
}

/**
 * Validate and canonicalise a layout blob. Unknown keys are dropped, ids must
 * be unique across the whole tree, sections nest one level, and the result
 * must serialise under 64 KB.
 */
export function normalizeDashboardLayout(raw: unknown): Result {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'layout must be an object' }
  const r = raw as Record<string, unknown>
  if (r.version !== 1) return { error: 'layout.version must be 1' }
  if (!Array.isArray(r.items)) return { error: 'layout.items must be a list' }
  if (r.items.length > MAX_TOP_ITEMS) return { error: `layout holds more than ${MAX_TOP_ITEMS} items` }
  const seen = new Set<string>()
  const items: DashboardItem[] = []
  for (let i = 0; i < r.items.length; i++) {
    const it = normalizeItem(r.items[i], `items[${i}]`, seen, 0)
    if ('error' in it) return { error: it.error }
    items.push(it.item)
  }
  if (seen.size > MAX_TOTAL_ITEMS) return { error: `layout holds more than ${MAX_TOTAL_ITEMS} items` }
  const layout: DashboardLayout = { version: 1, items }
  if (JSON.stringify(layout).length > DASHBOARD_LAYOUT_MAX_BYTES)
    return { error: 'layout is larger than 64 KB' }
  return { layout }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The per-role defaults map an admin publishes: `{ <role uuid>: layout }`.
 * Every layout is normalised; a role id that is not a uuid is refused.
 */
export function normalizeDashboardRoleDefaults(
  raw: unknown
): { map: Record<string, DashboardLayout>; error?: undefined } | { error: string; map?: undefined } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return { error: 'dashboard_role_defaults must be an object keyed by role id' }
  const entries = Object.entries(raw as Record<string, unknown>)
  if (entries.length > 50) return { error: 'dashboard_role_defaults holds more than 50 roles' }
  const map: Record<string, DashboardLayout> = {}
  for (const [role, layout] of entries) {
    if (!UUID_RE.test(role)) return { error: `"${role}" is not a role id` }
    const n = normalizeDashboardLayout(layout)
    if (!n.layout) return { error: `role ${role}: ${n.error}` }
    map[role.toUpperCase()] = n.layout
  }
  return { map }
}
