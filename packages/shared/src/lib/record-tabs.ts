import { useEffect, useRef, useState } from 'react'

/**
 * #1745 — the same record open in two tabs of one browser. Tabs announce the
 * record they show and whether it has unsaved changes over a BroadcastChannel
 * (no server round trip); a tab sees `otherDirty` while ANOTHER tab holds
 * unsaved edits to the same record, and `focusOther()` asks that tab to bring
 * itself forward (browsers only honour `window.focus()` from some tabs, so
 * the other tab also flags its title until it is looked at).
 */

const CHANNEL = 'nvr-record-tabs'

type TabMessage =
  | { type: 'state'; tab: string; key: string; dirty: boolean }
  | { type: 'hello'; tab: string; key: string }
  | { type: 'bye'; tab: string; key: string }
  | { type: 'focus'; tab: string; key: string; target: string }

function newTabId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  }
}

/** One id per page load, shared by every hook instance in this tab. */
const TAB_ID = newTabId()

export function useRecordTabs(
  collection: string | null | undefined,
  itemId: string | number | null | undefined,
  dirty: boolean
): { otherDirty: boolean; focusOther: () => void } {
  const key = collection && itemId != null && itemId !== 'new' ? `${collection}:${itemId}` : ''
  const [dirtyTabs, setDirtyTabs] = useState<string[]>([])
  const channelRef = useRef<BroadcastChannel | null>(null)
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty

  useEffect(() => {
    setDirtyTabs([])
    if (!key || typeof BroadcastChannel === 'undefined') return
    let ch: BroadcastChannel
    try {
      ch = new BroadcastChannel(CHANNEL)
    } catch {
      return
    }
    channelRef.current = ch
    const post = (m: TabMessage) => {
      try {
        ch.postMessage(m)
      } catch {
        /* channel closed */
      }
    }
    const originalTitle = document.title
    let titleTimer: ReturnType<typeof setTimeout> | null = null
    ch.onmessage = (e: MessageEvent<TabMessage>) => {
      const m = e.data
      if (!m || m.key !== key || m.tab === TAB_ID) return
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
    }
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
  }, [key])

  // Every dirty flip is announced so the other tabs' warnings follow it.
  useEffect(() => {
    if (!key) return
    try {
      channelRef.current?.postMessage({ type: 'state', tab: TAB_ID, key, dirty })
    } catch {
      /* channel closed */
    }
  }, [key, dirty])

  const focusOther = () => {
    const target = dirtyTabs[dirtyTabs.length - 1]
    if (!target || !key) return
    try {
      channelRef.current?.postMessage({ type: 'focus', tab: TAB_ID, key, target })
    } catch {
      /* channel closed */
    }
  }

  return { otherDirty: dirtyTabs.length > 0, focusOther }
}
