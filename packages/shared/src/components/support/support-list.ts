/**
 * The support request list's pure half (desk rebuild 2026-11-16): filters ↔ the
 * GET /support/tickets query, the remembered filters per tab, times as "3h",
 * and the bulk result line. The server owns the meaning of every value.
 */

export type ListTab = 'mine' | 'desk'

export type TicketSort = 'attention' | 'newest' | 'oldest' | 'updated' | 'priority'

export interface ListFilters {
  /** open (open + in progress) | in_progress | closed (done + cancelled) | done | cancelled | all */
  status: string
  /** '' anyone | 'me' | 'unassigned' | a user id */
  assignee: string
  /** '' any | a type id */
  category: string
  /** '' any | low | normal | urgent */
  priority: string
  sort: TicketSort
}

export const STATUS_FILTERS: Array<{ value: string; label: string }> = [
  { value: 'open', label: 'Open' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'closed', label: 'Closed' },
  { value: 'done', label: 'Done' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'all', label: 'Any status' }
]

export const PRIORITY_FILTERS: Array<{ value: string; label: string }> = [
  { value: '', label: 'Any priority' },
  { value: 'urgent', label: 'Urgent' },
  { value: 'normal', label: 'Normal' },
  { value: 'low', label: 'Low' }
]

export const SORTS: Array<{ value: TicketSort; label: string; description: string }> = [
  {
    value: 'attention',
    label: 'Needs attention',
    description: 'Urgent first, then nobody has it, then longest waiting'
  },
  { value: 'newest', label: 'Newest', description: 'Most recently raised first' },
  { value: 'oldest', label: 'Oldest', description: 'Raised longest ago first' },
  { value: 'updated', label: 'Recently updated', description: 'Latest activity first' },
  { value: 'priority', label: 'Priority', description: 'Urgent, normal, low; oldest first' }
]

const SORT_VALUES = new Set(SORTS.map((s) => s.value))
const STATUS_VALUES = new Set(STATUS_FILTERS.map((s) => s.value))
const PRIORITY_VALUES = new Set(PRIORITY_FILTERS.map((s) => s.value))

export function defaultFilters(tab: ListTab): ListFilters {
  return {
    status: 'open',
    assignee: '',
    category: '',
    priority: '',
    sort: tab === 'desk' ? 'attention' : 'updated'
  }
}

/** Filters that differ from the tab's defaults (sort excluded): drives "Clear filters". */
export function activeFilterCount(tab: ListTab, f: ListFilters): number {
  const d = defaultFilters(tab)
  return (['status', 'assignee', 'category', 'priority'] as const).filter((k) => f[k] !== d[k])
    .length
}

/** The query GET /support/tickets reads. */
export function listParams(tab: ListTab, f: ListFilters, q: string): Record<string, string> {
  const p: Record<string, string> = { scope: tab, status: f.status, sort: f.sort }
  if (tab === 'desk' && f.assignee) p.assignee = f.assignee
  if (f.category) p.category = f.category
  if (f.priority) p.priority = f.priority
  if (q.trim()) p.q = q.trim()
  return p
}

const storeKey = (tab: ListTab) => `nvr:support-list:${tab}`

/** The person's remembered filters for a tab; anything unknown falls back to the default. */
export function readFilters(tab: ListTab, storage: Pick<Storage, 'getItem'> | null): ListFilters {
  const d = defaultFilters(tab)
  try {
    const raw = storage?.getItem(storeKey(tab))
    if (!raw) return d
    const v = JSON.parse(raw) as Partial<Record<keyof ListFilters, unknown>>
    const str = (x: unknown) => (typeof x === 'string' ? x : '')
    return {
      status: STATUS_VALUES.has(str(v.status)) ? str(v.status) : d.status,
      assignee:
        tab === 'desk' && /^(me|unassigned|[0-9a-f-]{36})$/i.test(str(v.assignee))
          ? str(v.assignee)
          : '',
      category: /^\d{1,9}$/.test(str(v.category)) ? str(v.category) : '',
      priority: PRIORITY_VALUES.has(str(v.priority)) ? str(v.priority) : '',
      sort: SORT_VALUES.has(str(v.sort) as TicketSort) ? (str(v.sort) as TicketSort) : d.sort
    }
  } catch {
    return d
  }
}

export function writeFilters(
  tab: ListTab,
  f: ListFilters,
  storage: Pick<Storage, 'setItem'> | null
): void {
  try {
    storage?.setItem(storeKey(tab), JSON.stringify(f))
  } catch {
    // Private window / blocked storage: the filters simply are not remembered.
  }
}

/** "now", "12m", "3h", "4d", "6w", "5mo", "1y" — how long ago, short enough for a table cell. */
export function shortAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return ''
  const m = Math.floor((now - t) / 60000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h`
  const d = Math.floor(h / 24)
  if (d < 14) return `${d}d`
  if (d < 60) return `${Math.floor(d / 7)}w`
  if (d < 365) return `${Math.floor(d / 30)}mo`
  return `${Math.floor(d / 365)}y`
}

/** "Mon, Nov 16, 9:45 AM" — the exact moment, 12-hour, for a tooltip. */
export function exactTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

export function initialsOf(name: string | null | undefined): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '?'
  return ((parts[0][0] ?? '') + (parts.length > 1 ? (parts.at(-1)?.[0] ?? '') : '')).toUpperCase()
}

export type BulkAction =
  | { kind: 'status'; status: string }
  | { kind: 'assign'; assignee: string | null; name: string }
  | { kind: 'priority'; priority: string }

const STATUS_DONE_WORD: Record<string, string> = {
  done: 'Closed',
  cancelled: 'Cancelled',
  open: 'Reopened',
  in_progress: 'Moved to In progress'
}

/** "Closed 12 · 1 not allowed (You do not work this request)" — the bulk bar's result line. */
export function bulkResultLine(
  action: BulkAction,
  r: {
    updated: number
    unchanged: number
    refused: number
    results: Array<{ outcome: string; reason?: string }>
  }
): string {
  const verb =
    action.kind === 'status'
      ? (STATUS_DONE_WORD[action.status] ?? 'Updated')
      : action.kind === 'assign'
        ? action.assignee
          ? `Assigned to ${action.name}`
          : 'Unassigned'
        : `Set to ${action.priority}`
  const parts = [`${verb}: ${r.updated}`]
  if (r.unchanged) parts.push(`${r.unchanged} already that way`)
  if (r.refused) {
    const reasons = [
      ...new Set(r.results.filter((x) => x.outcome === 'refused').map((x) => x.reason ?? ''))
    ].filter(Boolean)
    parts.push(
      `${r.refused} not allowed${reasons.length ? ` (${reasons.slice(0, 2).join('; ')})` : ''}`
    )
  }
  return parts.join(' · ')
}
