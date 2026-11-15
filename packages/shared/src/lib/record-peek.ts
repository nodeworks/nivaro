import { createContext, useCallback, useContext, useSyncExternalStore } from 'react'
import { useItemNavigation } from '../context'

/**
 * Realtime #17 — peek at a record from anywhere, without leaving the page.
 *
 * Lists and queues already open a record in a side sheet (CollectionBrowserView's Peek,
 * QueueItemSheet). The app host mounts ONE `RecordPeekHost` (components/RecordPeekHost.tsx)
 * that renders the same `RecordDrilldownSheet`, and any surface — My Work, home worklists,
 * notifications, search results, record links in comments — opens a record in it through
 * `usePeekOrOpen()`:
 *
 * - a plain click opens the sheet (live, Esc closes, ↑ / ↓ walk the surface's own list when
 *   it passed one, "Open record" goes to the full page);
 * - Cmd / Ctrl / Shift / middle click opens the full page in a new tab;
 * - a host without a peek host keeps today's behaviour: the click navigates.
 */

export interface PeekTarget {
  collection: string
  itemId: string
  /** What the sheet calls it until the record loads. */
  title?: string | null
}

export interface RecordPeekApi {
  /** Open `target` in the app's record sheet; `list` (in order) enables ↑ / ↓. */
  open: (target: PeekTarget, opts?: { list?: PeekTarget[] }) => void
}

export const RecordPeekContext = createContext<RecordPeekApi | null>(null)

// The host may mount its sheet BESIDE the app rather than around it (no re-nesting of a big
// layout): the mounted host also registers here, and surfaces outside its subtree find it.
let mountedHost: RecordPeekApi | null = null
const hostListeners = new Set<() => void>()

/** Called by RecordPeekHost while it is mounted; returns the unregister. */
export function registerRecordPeekHost(api: RecordPeekApi): () => void {
  mountedHost = api
  for (const l of hostListeners) l()
  return () => {
    if (mountedHost !== api) return
    mountedHost = null
    for (const l of hostListeners) l()
  }
}

const subscribeHost = (fn: () => void) => {
  hostListeners.add(fn)
  return () => {
    hostListeners.delete(fn)
  }
}

/** The app's record sheet, or null when the host mounted none. */
export function useRecordPeek(): RecordPeekApi | null {
  const fromTree = useContext(RecordPeekContext)
  const mounted = useSyncExternalStore(
    subscribeHost,
    () => mountedHost,
    () => null
  )
  return fromTree ?? mounted
}

export interface ClickLike {
  metaKey?: boolean
  ctrlKey?: boolean
  shiftKey?: boolean
  button?: number
}

/** A click that asks for a new tab (Cmd / Ctrl / Shift / middle button). */
export function isNewTabClick(e?: ClickLike | null): boolean {
  return !!e && (!!e.metaKey || !!e.ctrlKey || !!e.shiftKey || e.button === 1)
}

/** Collections the sheet can show: business records, not system tables or chat. */
export function peekable(collection: string | null | undefined): boolean {
  return !!collection && !/^(nivaro_|directus_)/i.test(collection) && collection !== '__chat__'
}

export type PeekDecision = 'new-tab' | 'peek' | 'navigate'

/** What a click on a record link does (pure; see the module note). */
export function peekDecision(
  e: ClickLike | null | undefined,
  hasPeek: boolean,
  collection: string | null | undefined
): PeekDecision {
  if (isNewTabClick(e)) return 'new-tab'
  return hasPeek && peekable(collection) ? 'peek' : 'navigate'
}

/**
 * The record-link click handler every surface uses. Pass the click (for the new-tab rule)
 * and, from a list, the list's records in order (for ↑ / ↓ in the sheet). Returns what it did.
 */
export function usePeekOrOpen(): (
  target: PeekTarget,
  e?: (ClickLike & { preventDefault?: () => void }) | null,
  opts?: { list?: PeekTarget[] }
) => PeekDecision {
  const peek = useRecordPeek()
  const { open, urlFor } = useItemNavigation()
  return useCallback(
    (target, e, opts) => {
      const what = peekDecision(e, !!peek, target.collection)
      if (what === 'new-tab') {
        e?.preventDefault?.()
        window.open(
          urlFor({ collection: target.collection, itemId: target.itemId }),
          '_blank',
          'noopener'
        )
      } else if (what === 'peek' && peek) {
        e?.preventDefault?.()
        peek.open(target, opts)
      } else open({ collection: target.collection, itemId: target.itemId })
      return what
    },
    [peek, open, urlFor]
  )
}

/** The neighbour of `index` in a list of `length` for an arrow key, or null at an end. */
export function peekStep(index: number, length: number, key: string): number | null {
  if (length <= 0 || index < 0) return null
  if (key === 'ArrowDown') return index < length - 1 ? index + 1 : null
  if (key === 'ArrowUp') return index > 0 ? index - 1 : null
  return null
}

/** The shape of a notification this needs (lib/notification-target.ts NotificationLike). */
export interface PeekableNotification {
  collection?: string | null
  item?: string | null
  subject?: string | null
  target?: {
    kind?: string | null
    collection?: string | null
    id?: string | number | null
    focus?: string | null
    tab?: string | null
    query?: string | null
  } | null
}

/**
 * The record a notification may open in the sheet, or null when it must navigate: a plain
 * record (or deadline) target. One that points INTO the record (a comment to focus, a tab, a
 * query) keeps opening the full page, which knows how to land there.
 */
export function notificationPeekTarget(n: PeekableNotification): PeekTarget | null {
  const spec = n.target ?? null
  if (spec) {
    if (spec.kind !== 'record' && spec.kind !== 'sla') return null
    if (spec.focus || spec.tab || spec.query) return null
    if (!spec.collection || spec.id == null || !peekable(spec.collection)) return null
    return { collection: spec.collection, itemId: String(spec.id), title: n.subject ?? null }
  }
  if (!n.collection || n.item == null || String(n.item) === '' || !peekable(n.collection))
    return null
  return { collection: n.collection, itemId: String(n.item), title: n.subject ?? null }
}

/** Whether a keydown happened where arrow keys belong to something else (a field, a menu…). */
export function arrowsBelongElsewhere(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || typeof el.closest !== 'function') return false
  if (el.isContentEditable) return true
  return !!el.closest(
    'input, textarea, select, [contenteditable="true"], [role="combobox"], [role="listbox"], [role="menu"], [role="menuitem"], [role="option"], [role="grid"], [role="slider"], [role="tablist"], [role="radiogroup"], [data-radix-popper-content-wrapper]'
  )
}
