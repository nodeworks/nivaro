/**
 * Board keyboard shortcuts (CC-25). Single keys, no modifiers, never while the person is typing
 * in a field. The shell maps each action to its handler; the "?" popover lists SHORTCUTS.
 */

export type ShortcutAction =
  | { kind: 'fullscreen' }
  | { kind: 'tv' }
  | { kind: 'refresh' }
  | { kind: 'focus-region' }
  | { kind: 'region'; index: number }
  | { kind: 'escape' }
  | { kind: 'help' }

export const SHORTCUTS: Array<{ keys: string; label: string }> = [
  { keys: 'F', label: 'Full screen' },
  { keys: 'T', label: 'TV mode (larger type, cycles regions)' },
  { keys: 'R', label: 'Refresh now' },
  { keys: 'g', label: 'Choose a region' },
  { keys: '1–9', label: 'Jump to region 1–9' },
  { keys: '0', label: 'Everywhere' },
  { keys: 'Esc', label: 'Close the record panel, then leave TV mode' },
  { keys: '?', label: 'Show these shortcuts' }
]

/** Event raised to ask the region picker (slice 1) to take focus. */
export const FOCUS_REGION_EVENT = 'cc:focus-region'
/** The region picker's trigger carries this attribute (fallback when nothing listens). */
export const REGION_PICKER_ATTR = 'data-cc-region-picker'

export interface KeyLike {
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  target?: EventTarget | null
  defaultPrevented?: boolean
  isComposing?: boolean
}

/** True when keys typed now belong to a field (input, textarea, select, editable, combobox). */
export function isTypingTarget(t: EventTarget | null | undefined): boolean {
  const el = t as (HTMLElement & { isContentEditable?: boolean }) | null | undefined
  if (!el || typeof el !== 'object' || !('tagName' in el)) return false
  const tag = String(el.tagName).toUpperCase()
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (el.isContentEditable) return true
  const role = typeof el.getAttribute === 'function' ? el.getAttribute('role') : null
  return role === 'textbox' || role === 'combobox' || role === 'searchbox'
}

/** The board action for a key press, or null when the board should leave it alone. */
export function shortcutFor(e: KeyLike): ShortcutAction | null {
  if (e.defaultPrevented || e.isComposing) return null
  if (e.ctrlKey || e.metaKey || e.altKey) return null
  if (e.key === 'Escape') return { kind: 'escape' }
  if (isTypingTarget(e.target)) return null
  const k = e.key
  if (k === 'f' || k === 'F') return { kind: 'fullscreen' }
  if (k === 't' || k === 'T') return { kind: 'tv' }
  if (k === 'r' || k === 'R') return { kind: 'refresh' }
  // Not '/': that is the app-wide "focus search" key (lib/useKeyboardShortcuts.ts).
  if (k === 'g' || k === 'G') return { kind: 'focus-region' }
  if (k === '?') return { kind: 'help' }
  if (/^[0-9]$/.test(k)) return { kind: 'region', index: Number(k) }
  return null
}

/** Region id for a number key: 0 = everywhere (null), n = the nth region; undefined = none. */
export function regionForIndex(
  regions: Array<{ id: string }>,
  index: number
): string | null | undefined {
  if (index === 0) return null
  return regions[index - 1]?.id
}
