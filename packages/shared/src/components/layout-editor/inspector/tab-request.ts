import { useEffect, useRef } from 'react'

/**
 * "Open this field's Rules tab" from outside the inspector (a canvas chip,
 * #2632). The request waits until the field's inspector is showing — it may
 * mount after the click selected the field — and is taken once.
 */

const EVENT = 'nvr:layout-inspector-tab'
let pending: { key: string; tab: string } | null = null

/** `key`: the selected target's targetKey. */
export function requestInspectorTab(key: string, tab: string) {
  pending = { key, tab }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(EVENT))
}

export function useInspectorTabRequest(key: string, open: (tab: string) => void) {
  const openRef = useRef(open)
  openRef.current = open
  useEffect(() => {
    const take = () => {
      if (pending?.key !== key) return
      const { tab } = pending
      pending = null
      openRef.current(tab)
    }
    take()
    window.addEventListener(EVENT, take)
    return () => window.removeEventListener(EVENT, take)
  }, [key])
}
