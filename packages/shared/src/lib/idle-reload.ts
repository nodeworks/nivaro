/**
 * Reload old tabs when idle (#2937). After a release, a tab still on an older build reloads by
 * itself once nobody has typed or clicked in it for a minute (the instance setting) — never while
 * a form in it holds unsaved changes (lib/unsaved-work.ts, the only source of that answer), and
 * never during a huddle or a screen clip (lib/reload-holds.ts). Scroll position comes back after
 * the reload; drafts are untouched (nothing unsaved means nothing to lose, and stored drafts stay
 * stored).
 *
 * "Is this tab old?" is the server's answer, never the tab's guess: GET /realtime/build-status
 * judges the tab with the cluster's BuildJudge (api/src/services/client-versions-cluster.ts —
 * instance roster + 10 minute settle window), the same judgement the Realtime console's
 * "Old versions" refresh uses. A tab asks only when it is already idle and free, so busy tabs
 * cost nothing, and a tab reloads at most once per target build (the force-reload marker in
 * client-version.ts, id `idle-<app>-<build>`), so a cached old bundle never loops.
 *
 * Hidden counts as idle only with no input for the same time: a person who typed, switched tabs
 * and comes back a few seconds later finds the page as they left it.
 */

export const DEFAULT_IDLE_SECONDS = 60
/** How often an idle, free tab asks again (the first hour idle). */
export const CHECK_EVERY_MS = 3 * 60_000
/** …and after that — a tab left open overnight asks a few times an hour, not twenty. */
export const CHECK_EVERY_LONG_IDLE_MS = 15 * 60_000
export const LONG_IDLE_MS = 60 * 60_000
/** With the setting off, ask this rarely (to notice it was turned back on). */
export const CHECK_EVERY_WHEN_OFF_MS = 15 * 60_000
/** One automatic reload per target build per tab. */
export const IDLE_RELOADS_PER_TARGET = 1

/** GET /realtime/build-status `data`. */
export interface BuildStatus {
  older: 'build' | 'api' | null
  target: string | null
  id: string | null
  reason: string
  auto_reload: { enabled: boolean; idle_seconds: number }
}

export interface IdleReloadInput {
  now: number
  /** Last typing / click / touch / wheel in this tab (ms). */
  lastInput: number
  /** Unsaved work labels (unsavedWorkLabels()). */
  unsaved: string[]
  /** Live things a reload would cut off (reloadHoldLabels()). */
  holds: string[]
  /** The last server answer and when it came (null = never asked). */
  status: BuildStatus | null
  statusAt: number
  /** How often this tab already reloaded for an id (reloadCountFor). */
  reloadedFor: (id: string) => number
  /** This page load already tried and the page stayed (its own leave prompt said stay). */
  declined?: boolean
}

export type IdleReloadDecision =
  | { action: 'reload'; id: string }
  | { action: 'check' }
  | {
      action: 'wait'
      reason: 'active' | 'unsaved' | 'held' | 'off' | 'current' | 'already' | 'declined'
    }

/** Idle seconds as the last answer set them (the default before any answer). */
export function idleMsFor(status: BuildStatus | null): number {
  const s = Number(status?.auto_reload?.idle_seconds)
  return (Number.isFinite(s) && s > 0 ? s : DEFAULT_IDLE_SECONDS) * 1000
}

/** How long an answer is good for, given how long the tab has been idle. */
export function checkEveryMs(status: BuildStatus | null, idleFor: number): number {
  if (status && !status.auto_reload?.enabled) return CHECK_EVERY_WHEN_OFF_MS
  return idleFor >= LONG_IDLE_MS ? CHECK_EVERY_LONG_IDLE_MS : CHECK_EVERY_MS
}

/**
 * Pure: what should this tab do right now? In order — someone is using it, it holds unsaved work,
 * something live is on, then the server's answer (asked again when it is stale).
 */
export function decideIdleReload(i: IdleReloadInput): IdleReloadDecision {
  if (i.declined) return { action: 'wait', reason: 'declined' }
  const idleFor = i.now - i.lastInput
  if (idleFor < idleMsFor(i.status)) return { action: 'wait', reason: 'active' }
  if (i.unsaved.length > 0) return { action: 'wait', reason: 'unsaved' }
  if (i.holds.length > 0) return { action: 'wait', reason: 'held' }
  const s = i.status
  if (!s || i.now - i.statusAt >= checkEveryMs(s, idleFor)) return { action: 'check' }
  if (!s.auto_reload?.enabled) return { action: 'wait', reason: 'off' }
  if (!s.older || !s.id) return { action: 'wait', reason: 'current' }
  if (i.reloadedFor(s.id) >= IDLE_RELOADS_PER_TARGET) return { action: 'wait', reason: 'already' }
  return { action: 'reload', id: s.id }
}

// ─── Input tracking (typing and clicking; mousemove alone is not "using the tab") ───────────

const INPUT_EVENTS = ['keydown', 'pointerdown', 'touchstart', 'wheel', 'input'] as const
let lastInput = Date.now()
let tracking = false

export function trackIdleReloadInput(): void {
  if (tracking || typeof window === 'undefined') return
  tracking = true
  const mark = () => {
    lastInput = Date.now()
  }
  for (const ev of INPUT_EVENTS) window.addEventListener(ev, mark, { passive: true, capture: true })
}

export function lastIdleReloadInput(): number {
  return lastInput
}

// ─── Scroll position across the reload ────────────────────────────────────────────────────

const SCROLL_KEY = 'nvr-idle-reload-scroll'
/** A saved position older than this is not restored (the reload never happened). */
const SCROLL_MAX_AGE_MS = 2 * 60_000
const SCROLL_RESTORE_FOR_MS = 8000
const MAX_SCROLLERS = 12

export interface SavedScroll {
  path: string
  at: number
  window: { x: number; y: number }
  /** Scrolled elements by DOM path (`#id` or child indexes from body). */
  boxes: Array<{ key: string; top: number; left: number }>
}

/** A stable key for an element: its id, else child indexes from <body>. */
export function domPathKey(el: Element): string | null {
  if (el.id) return `#${el.id}`
  const parts: number[] = []
  let node: Element | null = el
  while (node && node !== document.body) {
    const parent: Element | null = node.parentElement
    if (!parent) return null
    parts.unshift(Array.prototype.indexOf.call(parent.children, node))
    node = parent
  }
  return node === document.body ? `>${parts.join('>')}` : null
}

export function findByDomPathKey(key: string): Element | null {
  if (key.startsWith('#')) return document.getElementById(key.slice(1))
  if (!key.startsWith('>')) return null
  let node: Element | null = document.body
  for (const raw of key.slice(1).split('>')) {
    const i = Number(raw)
    if (!node || raw === '' || !Number.isInteger(i)) return null
    node = node.children[i] ?? null
  }
  return node
}

function currentPath(): string {
  return `${window.location.pathname}${window.location.search}`
}

/** Store where the page is scrolled (window + every scrolled box), for after the reload. */
export function saveScrollForReload(): void {
  try {
    const boxes: SavedScroll['boxes'] = []
    for (const el of document.querySelectorAll('body *')) {
      if (boxes.length >= MAX_SCROLLERS) break
      if (el.scrollTop <= 0 && el.scrollLeft <= 0) continue
      const key = domPathKey(el)
      if (key) boxes.push({ key, top: el.scrollTop, left: el.scrollLeft })
    }
    const saved: SavedScroll = {
      path: currentPath(),
      at: Date.now(),
      window: { x: window.scrollX, y: window.scrollY },
      boxes
    }
    sessionStorage.setItem(SCROLL_KEY, JSON.stringify(saved))
  } catch {
    /* storage off: the reload still happens, at the top of the page */
  }
}

/** Pure: may a stored position be used on this page load? */
export function usableScroll(
  raw: string | null,
  path: string,
  now = Date.now()
): SavedScroll | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as SavedScroll
    if (!v || v.path !== path || typeof v.at !== 'number') return null
    if (now - v.at > SCROLL_MAX_AGE_MS || now < v.at - 5000) return null
    return { ...v, boxes: Array.isArray(v.boxes) ? v.boxes : [] }
  } catch {
    return null
  }
}

/**
 * Once per page load: put back the position saved just before an idle reload. Content loads
 * after the page does, so each box is retried until it exists and is tall enough (8 s at most).
 */
export function restoreScrollAfterReload(): () => void {
  if (typeof window === 'undefined') return () => {}
  let saved: SavedScroll | null = null
  try {
    saved = usableScroll(sessionStorage.getItem(SCROLL_KEY), currentPath())
    sessionStorage.removeItem(SCROLL_KEY)
  } catch {
    saved = null
  }
  if (!saved) return () => {}
  const s = saved
  const pending = new Map(s.boxes.map((b) => [b.key, b]))
  let windowDone = s.window.y <= 0 && s.window.x <= 0
  let stopped = false
  // Someone who starts scrolling or clicking takes over: stop moving the page under them.
  const stop = () => {
    stopped = true
  }
  window.addEventListener('pointerdown', stop, { once: true, capture: true })
  window.addEventListener('keydown', stop, { once: true, capture: true })
  window.addEventListener('wheel', stop, { once: true, capture: true, passive: true })
  const started = Date.now()
  const tick = () => {
    if (stopped) return
    if (!windowDone) {
      window.scrollTo(s.window.x, s.window.y)
      windowDone = Math.abs(window.scrollY - s.window.y) < 2
    }
    for (const [key, b] of pending) {
      const el = findByDomPathKey(key)
      if (!el || el.scrollHeight - el.clientHeight < b.top - 1) continue
      el.scrollTop = b.top
      el.scrollLeft = b.left
      pending.delete(key)
    }
    if ((windowDone && pending.size === 0) || Date.now() - started > SCROLL_RESTORE_FOR_MS) {
      stopped = true
      return
    }
    setTimeout(tick, 200)
  }
  setTimeout(tick, 0)
  return stop
}
