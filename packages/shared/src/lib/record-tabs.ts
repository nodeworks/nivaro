import { useEffect, useRef, useState } from 'react'

/**
 * #1745 — the same record open in two tabs of one browser. Tabs announce the
 * record they show and whether it has unsaved changes over a BroadcastChannel
 * (no server round trip); a tab sees `otherDirty` while ANOTHER tab holds
 * unsaved edits to the same record, and `focusOther()` asks that tab to bring
 * itself forward (browsers only honour `window.focus()` from some tabs, so
 * the other tab also flags its title until it is looked at).
 *
 * #2131 (pop out a record): the same channel keeps a popped-out window and
 * the main tab in step. A save in one window announces `saved` and the other
 * refreshes the record — the socket cannot do it, since live events by the
 * viewer themselves count as their own and are skipped. A window that drops
 * the record's edit lock on its way out announces `lock-released`, so the
 * window still showing the record takes the lock straight back.
 *
 * The channel is keyed by sign-in (`scope` = the signed-in user id): a
 * "View as" tab is another person and never shares state with the admin's
 * own tabs.
 */

const CHANNEL = 'nvr-record-tabs'

type TabMessage =
  | { type: 'state'; tab: string; key: string; dirty: boolean }
  | { type: 'hello'; tab: string; key: string }
  | { type: 'bye'; tab: string; key: string }
  | { type: 'focus'; tab: string; key: string; target: string }
  | { type: 'saved'; tab: string; key: string }
  | { type: 'lock-released'; tab: string; key: string }

function channelName(scope: string | null | undefined): string {
  return scope ? `${CHANNEL}:${scope}` : CHANNEL
}

function recordKey(
  collection: string | null | undefined,
  itemId: string | number | null | undefined
): string {
  return collection && itemId != null && itemId !== 'new' ? `${collection}:${itemId}` : ''
}

function newTabId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  }
}

/** One id per page load, shared by every hook instance in this tab. */
const TAB_ID = newTabId()

/**
 * ONE BroadcastChannel per name per tab, fanned out to every listener here.
 * A channel object never hears its own posts, so this tab's announcements
 * reach only the other windows — and no hook instance hears another one in
 * the same tab.
 */
interface TabsChannel {
  post: (m: TabMessage) => void
  close: () => void
}
const openChannels = new Map<
  string,
  { ch: BroadcastChannel; listeners: Set<(m: TabMessage) => void> }
>()

function openTabsChannel(
  scope: string | null | undefined,
  listener: (m: TabMessage) => void
): TabsChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null
  const name = channelName(scope)
  let entry = openChannels.get(name)
  if (!entry) {
    let ch: BroadcastChannel
    try {
      ch = new BroadcastChannel(name)
    } catch {
      return null
    }
    const listeners = new Set<(m: TabMessage) => void>()
    ch.onmessage = (e: MessageEvent<TabMessage>) => {
      const m = e.data
      if (!m || m.tab === TAB_ID) return
      for (const l of listeners) l(m)
    }
    entry = { ch, listeners }
    openChannels.set(name, entry)
  }
  const { ch, listeners } = entry
  listeners.add(listener)
  return {
    post: (m) => {
      try {
        ch.postMessage(m)
      } catch {
        /* channel closed */
      }
    },
    close: () => {
      listeners.delete(listener)
      if (listeners.size === 0 && openChannels.get(name)?.ch === ch) {
        openChannels.delete(name)
        ch.close()
      }
    }
  }
}

/**
 * Tell this record's other windows (same sign-in) that something happened
 * here: `saved` (refresh) or `lock-released` (take the lock back).
 */
export function announceRecordTabs(
  scope: string | null | undefined,
  type: 'saved' | 'lock-released',
  collection: string,
  itemId: string | number
): void {
  const key = recordKey(collection, itemId)
  if (!key) return
  const ch = openTabsChannel(scope, () => {})
  ch?.post({ type, tab: TAB_ID, key })
  ch?.close()
}

/** Listen for another window's `type` announcement for one record (no React). */
export function subscribeRecordTabs(
  scope: string | null | undefined,
  type: 'saved' | 'lock-released',
  collection: string,
  itemId: string | number,
  cb: () => void
): () => void {
  const key = recordKey(collection, itemId)
  if (!key) return () => {}
  const ch = openTabsChannel(scope, (m) => {
    if (m.type === type && m.key === key) cb()
  })
  return () => ch?.close()
}

/** Run `cb` when ANOTHER window of this sign-in announces `type` for the record. */
export function useRecordTabsSignal(
  scope: string | null | undefined,
  type: 'saved' | 'lock-released',
  collection: string | null | undefined,
  itemId: string | number | null | undefined,
  cb: () => void
): void {
  const cbRef = useRef(cb)
  cbRef.current = cb
  useEffect(() => {
    if (!collection || itemId == null) return
    return subscribeRecordTabs(scope, type, collection, itemId, () => cbRef.current())
  }, [scope, type, collection, itemId])
}

export function useRecordTabs(
  collection: string | null | undefined,
  itemId: string | number | null | undefined,
  dirty: boolean,
  scope?: string | null
): { otherDirty: boolean; focusOther: () => void } {
  const key = recordKey(collection, itemId)
  const [dirtyTabs, setDirtyTabs] = useState<string[]>([])
  const channelRef = useRef<TabsChannel | null>(null)
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty

  useEffect(() => {
    setDirtyTabs([])
    if (!key) return
    const originalTitle = document.title
    let titleTimer: ReturnType<typeof setTimeout> | null = null
    const ch = openTabsChannel(scope, (m) => {
      if (m.key !== key) return
      if (m.type === 'hello') post({ type: 'state', tab: TAB_ID, key, dirty: dirtyRef.current })
      else if (m.type === 'state')
        setDirtyTabs((cur) => {
          const rest = cur.filter((t) => t !== m.tab)
          return m.dirty ? [...rest, m.tab] : rest
        })
      else if (m.type === 'bye') setDirtyTabs((cur) => cur.filter((t) => t !== m.tab))
      else if (m.type === 'focus' && m.target === TAB_ID) {
        try {
          window.focus()
        } catch {
          /* not allowed from here */
        }
        if (document.visibilityState !== 'visible') {
          document.title = `● Unsaved changes here — ${originalTitle}`
          const restore = () => {
            document.title = originalTitle
            document.removeEventListener('visibilitychange', restore)
          }
          document.addEventListener('visibilitychange', restore)
          if (titleTimer) clearTimeout(titleTimer)
          titleTimer = setTimeout(restore, 30_000)
        }
      }
    })
    if (!ch) return
    channelRef.current = ch
    const post = ch.post
    post({ type: 'hello', tab: TAB_ID, key })
    post({ type: 'state', tab: TAB_ID, key, dirty: dirtyRef.current })
    const bye = () => post({ type: 'bye', tab: TAB_ID, key })
    window.addEventListener('pagehide', bye)
    return () => {
      bye()
      window.removeEventListener('pagehide', bye)
      if (titleTimer) clearTimeout(titleTimer)
      ch.close()
      channelRef.current = null
    }
  }, [key, scope])

  // Every dirty flip is announced so the other tabs' warnings follow it.
  useEffect(() => {
    if (!key) return
    channelRef.current?.post({ type: 'state', tab: TAB_ID, key, dirty })
  }, [key, dirty])

  const focusOther = () => {
    const target = dirtyTabs[dirtyTabs.length - 1]
    if (!target || !key) return
    channelRef.current?.post({ type: 'focus', tab: TAB_ID, key, target })
  }

  return { otherDirty: dirtyTabs.length > 0, focusOther }
}
