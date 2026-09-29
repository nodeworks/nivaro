// Unread attention count in the browser tab title — "(3) CR26-76773 · Nivaro"
// — so a person working in another tab sees that something needs them. One
// module-level controller: the bell can be mounted more than once (admin
// shows a compact and a full one), and several pages rewrite document.title
// as they mount, so the prefix is re-applied whenever the title changes
// instead of being set once. The favicon is left alone on purpose.

import { useEffect, useRef } from 'react'

const PREFIX = /^\(\d+\+?\) /
const owners = new Map<symbol, number>()
let observer: MutationObserver | null = null

/** "(3) " / "(99+) " / "" — what goes in front of the title. */
export function tabTitlePrefix(count: number): string {
  if (!(count > 0)) return ''
  return `(${count > 99 ? '99+' : Math.floor(count)}) `
}

/** The title with our prefix swapped for the one `count` calls for. */
export function withTitlePrefix(title: string, count: number): string {
  return tabTitlePrefix(count) + title.replace(PREFIX, '')
}

function current(): number {
  let count = 0
  for (const c of owners.values()) count = Math.max(count, c)
  return count
}

function applyTitle() {
  const want = withTitlePrefix(document.title, current())
  if (document.title !== want) document.title = want
}

function ensureObserver() {
  if (observer || typeof MutationObserver === 'undefined') return
  observer = new MutationObserver(() => {
    if (owners.size > 0) applyTitle()
  })
  observer.observe(document.head, { subtree: true, childList: true, characterData: true })
}

function apply() {
  applyTitle()
  if (owners.size === 0 && observer) {
    observer.disconnect()
    observer = null
  }
}

/**
 * Show `count` in front of the tab title while the calling component is
 * mounted; 0 clears it. Several callers combine (largest count wins).
 */
export function useTabAttention(count: number, options: { enabled?: boolean } = {}) {
  const key = useRef<symbol>(Symbol('tab-attention'))
  const enabled = options.enabled ?? true
  useEffect(() => {
    if (typeof document === 'undefined') return
    const k = key.current
    if (!enabled) {
      if (owners.delete(k)) apply()
      return
    }
    if (owners.get(k) === count) return
    owners.set(k, count)
    ensureObserver()
    apply()
  }, [count, enabled])
  useEffect(() => {
    const k = key.current
    return () => {
      if (owners.delete(k)) apply()
    }
  }, [])
}
