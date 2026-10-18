import { type ComponentType, useSyncExternalStore } from 'react'
import { byOrder, type Registered } from './registry'

/**
 * Whole-page views (#2244): a feature can replace the map's technical body (strip, canvas,
 * ticker, panels) and its filter row with a plain view of its own — the executive summary. A view
 * is active while its `active()` says so (a feature usually ties it to a view param, so the URL
 * carries it); the page re-renders when a view calls `notifyPageViews()`.
 */
export interface PageView extends Registered {
  active(): boolean
  Component: ComponentType
}

export const pageViews: PageView[] = []

let version = 0
const subs = new Set<() => void>()
export function notifyPageViews(): void {
  version++
  for (const fn of subs) fn()
}
function subscribe(fn: () => void): () => void {
  subs.add(fn)
  return () => subs.delete(fn)
}

/** The active page view, or null for the map. */
export function useActivePageView(): PageView | null {
  useSyncExternalStore(subscribe, () => version)
  for (const v of byOrder(pageViews)) {
    try {
      if (v.active()) return v
    } catch {
      /* a broken view never takes the page */
    }
  }
  return null
}
