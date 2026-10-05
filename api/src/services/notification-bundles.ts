/**
 * Record bundles in the bell (#1256) — the pure half. Rows that name the same
 * record fold into one entry: "3 things on <record>", the categories as
 * chips, the most urgent lane colouring the row. Only (collection, item)
 * pairs with two or more rows bundle; a lone row stays a row. The route adds
 * the record's friendly label and the recipient's URL afterwards (both need
 * the database).
 */

export type BundleLane = 'critical' | 'needs_you' | 'fyi'

/** The serialized row fields bundling reads — the GET /notifications shape. */
export interface BundleRow {
  id: number
  collection: string | null
  item: string | null
  read: boolean
  lane?: BundleLane | null
  category?: string | null
  created_at: string | Date | null
}

export interface NotificationBundle<R extends BundleRow = BundleRow> {
  collection: string
  item: string
  /** Filled by the route: the record's friendly id, else the raw item id. */
  label: string
  count: number
  unread: number
  lane: BundleLane
  categories: string[]
  newest: string | Date | null
  /** Filled by the route: where the record lives in the recipient's app. */
  url: string | null
  ids: number[]
  /** The rows the bundle holds, newest first — the expand list. */
  rows: R[]
}

const LANE_RANK: Record<BundleLane, number> = { critical: 0, needs_you: 1, fyi: 2 }

/** The most urgent of several lanes; an unknown/NULL lane counts as
 *  needs-you — the same under-count rule the badge uses. */
export function mostUrgentLane(lanes: Array<BundleLane | null | undefined>): BundleLane {
  if (lanes.length === 0) return 'fyi'
  let best: BundleLane = 'fyi'
  for (const l of lanes) {
    const lane: BundleLane = l && l in LANE_RANK ? l : 'needs_you'
    if (LANE_RANK[lane] < LANE_RANK[best]) best = lane
  }
  return best
}

/** A row belongs to a record when it names a collection + item that is not a
 *  pseudo-collection (chat rooms ride `__chat__`). */
export function bundleKeyOf(row: BundleRow): string | null {
  if (!row.collection || row.item == null || row.item === '') return null
  if (String(row.collection).startsWith('__')) return null
  return `${row.collection}:${row.item}`
}

const ts = (v: string | Date | null | undefined) => (v ? new Date(v).getTime() || 0 : 0)

/**
 * Split a page of rows into the rows that stay single and the bundles. Rows
 * keep their incoming order (newest first); a bundle's `newest` is its newest
 * row's timestamp and bundles come back newest first too.
 */
export function bundleNotifications<R extends BundleRow>(
  rows: R[]
): { rows: R[]; bundles: NotificationBundle<R>[] } {
  const byKey = new Map<string, R[]>()
  for (const r of rows) {
    const key = bundleKeyOf(r)
    if (!key) continue
    const list = byKey.get(key) ?? []
    list.push(r)
    byKey.set(key, list)
  }
  const bundled = new Set<number>()
  const bundles: NotificationBundle<R>[] = []
  for (const list of byKey.values()) {
    if (list.length < 2) continue
    const sorted = [...list].sort((a, b) => ts(b.created_at) - ts(a.created_at))
    for (const r of sorted) bundled.add(r.id)
    const first = sorted[0]
    const categories = [...new Set(sorted.map((r) => r.category).filter(Boolean))] as string[]
    // The lane is judged on the UNREAD rows while any remain — a read critical
    // row must not keep colouring a bundle whose open work is FYI.
    const unreadRows = sorted.filter((r) => !r.read)
    bundles.push({
      collection: String(first.collection),
      item: String(first.item),
      label: String(first.item),
      count: sorted.length,
      unread: unreadRows.length,
      lane: mostUrgentLane((unreadRows.length > 0 ? unreadRows : sorted).map((r) => r.lane)),
      categories,
      newest: first.created_at,
      url: null,
      ids: sorted.map((r) => r.id),
      rows: sorted
    })
  }
  bundles.sort((a, b) => ts(b.newest) - ts(a.newest))
  return { rows: rows.filter((r) => !bundled.has(r.id)), bundles }
}
