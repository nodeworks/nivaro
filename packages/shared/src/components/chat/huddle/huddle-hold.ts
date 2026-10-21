/**
 * Hold notifications during a huddle (#2852). While I am in a huddle (and
 * `preferences.huddle_hold_notifications` is not false) the toasts and sounds
 * for new notifications and chat messages are held: the inbox and the badges
 * still move, the stage shows a count, and on leaving the held ones are
 * released as one summary toast and one sound. Critical notifications are
 * never held (same rule as do not disturb).
 */

import { huddleStore } from './huddle-store'

export interface HeldItem {
  kind: 'notification' | 'chat'
  title: string
  at: number
}

type Listener = () => void
const listeners = new Set<Listener>()
let held: HeldItem[] = []
let releaseHandler: ((items: HeldItem[]) => void) | null = null

function notify() {
  for (const l of listeners) l()
}

/** Pure: is the preference on? Default on; only an explicit false turns it off. */
export function holdPreferenceOn(prefs: Record<string, unknown> | null | undefined): boolean {
  return prefs?.huddle_hold_notifications !== false
}

/** Am I in a live huddle, with holding on? Read at the moment a toast would fire. */
export function huddleHolds(prefs: Record<string, unknown> | null | undefined): boolean {
  const s = huddleStore.getSnapshot()
  return holdPreferenceOn(prefs) && s.status === 'live' && !!s.room
}

/** Queue one toast-worthy thing; returns true when it was held (caller shows nothing). */
export function holdNotification(item: Omit<HeldItem, 'at'>): boolean {
  held = [...held, { ...item, at: Date.now() }].slice(-200)
  notify()
  return true
}

export function heldCount(): number {
  return held.length
}

export function subscribeHeld(l: Listener): () => void {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

export function getHeldSnapshot(): number {
  return held.length
}

/** Pure: the one-line summary shown when the held items are released. */
export function heldSummary(items: HeldItem[]): string | null {
  if (!items.length) return null
  const n = items.filter((i) => i.kind === 'notification').length
  const c = items.length - n
  const parts: string[] = []
  if (n) parts.push(`${n} notification${n === 1 ? '' : 's'}`)
  if (c) parts.push(`${c} chat message${c === 1 ? '' : 's'}`)
  return `${parts.join(' and ')} arrived during your huddle`
}

/** The layer (HuddleCallLayer) registers how a release is shown — once per app. */
export function onHeldRelease(fn: ((items: HeldItem[]) => void) | null): () => void {
  releaseHandler = fn
  return () => {
    if (releaseHandler === fn) releaseHandler = null
  }
}

export function releaseHeld(): HeldItem[] {
  const items = held
  held = []
  notify()
  if (items.length) releaseHandler?.(items)
  return items
}

let watching = false
let wasLive = false
/** Release when the huddle ends — wired once by the layer. */
export function watchHuddleForRelease(): () => void {
  if (watching) return () => undefined
  watching = true
  wasLive = huddleStore.getSnapshot().status === 'live'
  const off = huddleStore.subscribe(() => {
    const live = huddleStore.getSnapshot().status === 'live'
    if (wasLive && !live) releaseHeld()
    wasLive = live
  })
  return () => {
    off()
    watching = false
  }
}
