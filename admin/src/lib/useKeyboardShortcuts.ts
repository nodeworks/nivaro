import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

const STORAGE_KEY = 'nivaro_shortcuts'
const SEQUENCE_TIMEOUT_MS = 800

export interface ShortcutDef {
  /** Stable action id — handlers are keyed by this. */
  id: string
  /** Human label shown in the shortcuts overlay. */
  label: string
  /** Default key combo. Space-separated keys form a sequence (e.g. "g c"). */
  keys: string
}

export const DEFAULT_SHORTCUTS: ShortcutDef[] = [
  { id: 'toggle-overlay', label: 'Show keyboard shortcuts', keys: '?' },
  { id: 'go-dashboard', label: 'Go to dashboard', keys: 'g d' },
  { id: 'go-collections', label: 'Go to collections', keys: 'g c' },
  { id: 'go-notifications', label: 'Go to notifications', keys: 'g n' },
  { id: 'new-item', label: 'New item (on list pages)', keys: 'n' },
  { id: 'focus-search', label: 'Focus search', keys: '/' }
]

export function loadShortcutOverrides(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as Record<string, string>) : {}
  } catch {
    return {}
  }
}

export function saveShortcutOverride(id: string, keys: string | null): void {
  const overrides = loadShortcutOverrides()
  if (keys === null) delete overrides[id]
  else overrides[id] = keys
  localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides))
}

/** Effective shortcut list: defaults merged with localStorage overrides. */
export function resolveShortcuts(overrides: Record<string, string>): ShortcutDef[] {
  return DEFAULT_SHORTCUTS.map((s) => ({ ...s, keys: overrides[s.id] ?? s.keys }))
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    target.isContentEditable ||
    !!target.closest('[contenteditable="true"]')
  )
}

/**
 * Global keyboard shortcuts. Ignores keystrokes while typing in inputs,
 * textareas, or contenteditable regions, and any modifier-laden combos.
 * Supports two-key sequences (e.g. "g c") within an 800ms window.
 * Overrides are persisted in localStorage under `nivaro_shortcuts`.
 */
export function useKeyboardShortcuts(handlers: Record<string, () => void>) {
  const [overrides, setOverrides] = useState<Record<string, string>>(loadShortcutOverrides)
  const shortcuts = useMemo(() => resolveShortcuts(overrides), [overrides])
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers
  const shortcutsRef = useRef(shortcuts)
  shortcutsRef.current = shortcuts

  const pendingRef = useRef<{ key: string; at: number } | null>(null)

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (isTypingTarget(e.target)) return
      const key = e.key
      if (key === 'Shift' || key.length > 1) {
        // Ignore non-character keys (arrows, Escape, etc.) — Escape is handled by the overlay.
        return
      }

      const now = Date.now()
      const pending =
        pendingRef.current && now - pendingRef.current.at < SEQUENCE_TIMEOUT_MS
          ? pendingRef.current
          : null

      const defs = shortcutsRef.current

      // 1. Try to complete a pending sequence.
      if (pending) {
        const seq = `${pending.key} ${key}`
        const match = defs.find((s) => s.keys === seq)
        pendingRef.current = null
        if (match) {
          e.preventDefault()
          handlersRef.current[match.id]?.()
          return
        }
      }

      // 2. Single-key shortcut.
      const single = defs.find((s) => s.keys === key)
      if (single) {
        e.preventDefault()
        handlersRef.current[single.id]?.()
        return
      }

      // 3. Possible start of a sequence.
      if (defs.some((s) => s.keys.startsWith(`${key} `))) {
        pendingRef.current = { key, at: now }
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const rebind = useCallback((id: string, keys: string | null) => {
    saveShortcutOverride(id, keys)
    setOverrides(loadShortcutOverrides())
  }, [])

  return { shortcuts, rebind }
}
