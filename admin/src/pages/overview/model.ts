/**
 * Pure shaping for the Overview's lists: recently viewed grouping and the quick-action row.
 */

// ─── Recently viewed ─────────────────────────────────────────────────────────

export interface RecentRecord {
  collection: string
  item_id: string
  label: string
  state: { key: string; label: string; color: string | null } | null
  last_viewed_at: string
  /** Set by the API once it knows the record changed after this person last looked. */
  changed?: boolean
  changed_since_viewed?: boolean
}

export const changedSinceViewed = (r: RecentRecord) => !!(r.changed ?? r.changed_since_viewed)

export type RecentBlock =
  | { kind: 'single'; record: RecentRecord }
  | { kind: 'group'; collection: string; records: RecentRecord[] }

/**
 * Three or more records from one collection fold into a group, placed where that collection's
 * most recent record sat; everything else stays a single row, newest first.
 */
export function groupRecent(rows: RecentRecord[], min = 3): RecentBlock[] {
  const counts = new Map<string, number>()
  for (const r of rows) counts.set(r.collection, (counts.get(r.collection) ?? 0) + 1)
  const out: RecentBlock[] = []
  const placed = new Map<string, Extract<RecentBlock, { kind: 'group' }>>()
  for (const r of rows) {
    if ((counts.get(r.collection) ?? 0) < min) {
      out.push({ kind: 'single', record: r })
      continue
    }
    const g = placed.get(r.collection)
    if (g) g.records.push(r)
    else {
      const block = { kind: 'group' as const, collection: r.collection, records: [r] }
      placed.set(r.collection, block)
      out.push(block)
    }
  }
  return out
}

// ─── Quick actions ───────────────────────────────────────────────────────────

export interface QuickAction {
  path: string
  label: string
  pinned: boolean
  /** Where it came from: pinned by the person, their usage, or the role's starting set. */
  source: 'pinned' | 'usage' | 'default'
  opens?: number
}

export const ADMIN_DEFAULT_ACTIONS = [
  '/collections',
  '/users',
  '/activity',
  '/flows',
  '/jobs',
  '/settings'
]
export const MEMBER_DEFAULT_ACTIONS = [
  '/my-work',
  '/collections',
  '/tasks',
  '/ask',
  '/dashboards',
  '/help-videos'
]

/**
 * Pinned first (in the person's order), then their most-opened screens of the last 30 days,
 * then the role's starting set, up to `max`. Paths the role may not open, paths with no label
 * and suggestions the person dismissed never show; Overview itself is never a quick action.
 */
export function buildQuickActions(opts: {
  pinned: Array<{ path: string; label: string }>
  usage: Array<{ path: string; opens: number }>
  defaults: string[]
  dismissed?: string[]
  labelFor: (path: string) => string | null
  allowed: (path: string) => boolean
  max?: number
}): QuickAction[] {
  const max = opts.max ?? 8
  const out: QuickAction[] = []
  const seen = new Set<string>(['/'])
  const dismissed = new Set(opts.dismissed ?? [])
  for (const p of opts.pinned) {
    if (seen.has(p.path) || !opts.allowed(p.path)) continue
    seen.add(p.path)
    out.push({
      path: p.path,
      label: opts.labelFor(p.path) ?? p.label,
      pinned: true,
      source: 'pinned'
    })
  }
  const suggest = (path: string, source: 'usage' | 'default', opens?: number) => {
    if (out.length >= max || seen.has(path) || dismissed.has(path) || !opts.allowed(path)) return
    const label = opts.labelFor(path)
    if (!label) return
    seen.add(path)
    out.push({ path, label, pinned: false, source, ...(opens != null ? { opens } : {}) })
  }
  for (const u of opts.usage) suggest(u.path, 'usage', u.opens)
  for (const d of opts.defaults) suggest(d, 'default')
  return out
}

/** Pin or unpin one action; the stored list keeps the person's order. */
export function togglePin(
  pinned: Array<{ path: string; label: string }>,
  action: { path: string; label: string }
): Array<{ path: string; label: string }> {
  return pinned.some((p) => p.path === action.path)
    ? pinned.filter((p) => p.path !== action.path)
    : [...pinned, { path: action.path, label: action.label }].slice(0, 12)
}
