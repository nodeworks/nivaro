import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * How long a layout save's config:update can still arrive after the save itself: the server's
 * per-collection push gap (config-live MIN_GAP_MS, 2 s) plus socket delivery.
 */
export const LAYOUT_PUSH_SETTLE_MS = 2_500

/**
 * A record page's `layoutEditing` for its ItemEditForm (configUpdateReaction): true while Edit
 * layout is open, and after it closes until the editor's last save settles plus the push gap,
 * so the admin's own saves never raise "This form was changed" on the record under the overlay.
 *
 * `settle(saved)` is called on close with LayoutEditor onBack's `saved` promise. Reopening
 * before the tail ends is covered by `editing`; a later close starts a new tail.
 */
export function useLayoutEditingQuiet(editing: boolean): {
  layoutEditing: boolean
  settle: (saved: Promise<unknown>) => void
} {
  const [tail, setTail] = useState(false)
  const gen = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      gen.current++
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )
  const settle = useCallback((saved: Promise<unknown>) => {
    const g = ++gen.current
    if (timer.current) clearTimeout(timer.current)
    setTail(true)
    void Promise.resolve(saved)
      .catch(() => undefined)
      .then(() => {
        if (g !== gen.current) return
        timer.current = setTimeout(() => {
          if (g === gen.current) setTail(false)
        }, LAYOUT_PUSH_SETTLE_MS)
      })
  }, [])
  return { layoutEditing: editing || tail, settle }
}
