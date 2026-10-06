import type { NotificationLane, NotificationTargetSpec } from '../../lib/notification-target'

/**
 * Record bundles (#1256): the server's `bundle=record` grouping of a page —
 * every row that names the same record folded into one entry. The rows ride
 * along so the expand list needs no second request.
 */
export interface NotificationBundle<R = unknown> {
  collection: string
  item: string
  /** The record's headline — friendly id, display label, or (deleted) its
   *  trash snapshot's label. Only a client-side fold shows a raw id. */
  label: string
  /** The record no longer exists: no Open, a "deleted" chip. */
  deleted?: boolean
  /** "Region" — the collection's singular name for a chip beside the label. */
  collection_label?: string | null
  count: number
  unread: number
  lane: NotificationLane
  categories: string[]
  newest: string | null
  /** The server's URL for the recipient's app — the fallback when the host
   *  has no record route. */
  url: string | null
  ids: number[]
  rows: R[]
}

/** The bundle as a notification-like for the host's target resolver: a plain
 *  record target plus the server's url as the fallback. */
export function bundleAsNotification(b: NotificationBundle): {
  collection: string
  item: string
  target: NotificationTargetSpec
  url: string | null
} {
  return {
    collection: b.collection,
    item: b.item,
    target: { kind: 'record', collection: b.collection, id: b.item },
    url: b.url
  }
}

/** "3 things on CM26-80332" — the bundle's one-line headline. */
export function bundleHeadline(b: NotificationBundle): string {
  const n = b.count
  return `${n} thing${n === 1 ? '' : 's'} on ${b.label}`
}

const CATEGORY_LABELS: Record<string, string> = {
  mentions: 'Mentions',
  workflow: 'Workflow',
  sla: 'SLA',
  watch: 'Watches',
  alerts: 'Alerts',
  anomaly: 'Anomalies',
  reports: 'Reports',
  system: 'System',
  integrations: 'Integrations',
  other: 'Other'
}

/** Category key → the chip's word (unknown keys read as themselves, title-cased). */
export function categoryChipLabel(category: string): string {
  const hit = CATEGORY_LABELS[category]
  if (hit) return hit
  return category.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

/** Lane → the colour the bundle row carries (dot + headline tint). */
export function laneTone(lane: NotificationLane | null | undefined): {
  dot: string
  text: string
  chip: string
} {
  if (lane === 'critical')
    return {
      dot: 'bg-red-500',
      text: 'text-red-700 dark:text-red-400',
      chip: 'bg-red-500/10 text-red-600 dark:text-red-400'
    }
  if (lane === 'fyi')
    return {
      dot: 'bg-slate-400 dark:bg-slate-500',
      text: 'text-slate-700 dark:text-slate-200',
      chip: 'bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300'
    }
  return {
    dot: 'bg-nvr-cyan',
    text: 'text-slate-900 dark:text-slate-100',
    chip: 'bg-nvr-cyan/10 text-nvr-navy dark:bg-nvr-cyan/15 dark:text-nvr-cyan'
  }
}

/** A client-side fallback for servers that answer no `bundles` (an image
 *  behind this feature): the same grouping rule, labels = the raw item. */
export function bundleLocally<
  R extends {
    id: number
    collection: string | null
    item: string | null
    read?: boolean
    lane?: NotificationLane | null
    category?: string | null
    created_at?: string | null
  }
>(rows: R[]): { rows: R[]; bundles: NotificationBundle<R>[] } {
  const byKey = new Map<string, R[]>()
  for (const r of rows) {
    if (!r.collection || !r.item || r.collection.startsWith('__')) continue
    const key = `${r.collection}:${r.item}`
    byKey.set(key, [...(byKey.get(key) ?? []), r])
  }
  const bundled = new Set<number>()
  const bundles: NotificationBundle<R>[] = []
  const rank: Record<string, number> = { critical: 0, needs_you: 1, fyi: 2 }
  for (const list of byKey.values()) {
    if (list.length < 2) continue
    for (const r of list) bundled.add(r.id)
    const unreadRows = list.filter((r) => !r.read)
    const judged = unreadRows.length > 0 ? unreadRows : list
    const lane = judged.reduce<NotificationLane>((best, r) => {
      const l: NotificationLane = r.lane && r.lane in rank ? r.lane : 'needs_you'
      return rank[l] < rank[best] ? l : best
    }, 'fyi')
    bundles.push({
      collection: String(list[0].collection),
      item: String(list[0].item),
      label: String(list[0].item),
      deleted: false,
      collection_label: null,
      count: list.length,
      unread: unreadRows.length,
      lane,
      categories: [...new Set(list.map((r) => r.category).filter(Boolean))] as string[],
      newest: list[0].created_at ?? null,
      url: null,
      ids: list.map((r) => r.id),
      rows: list
    })
  }
  return { rows: rows.filter((r) => !bundled.has(r.id)), bundles }
}
