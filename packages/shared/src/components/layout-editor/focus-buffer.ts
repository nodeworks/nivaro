import { useEffect, useRef, useState } from 'react'

/**
 * While focus is inside an editor, what it shows comes from what was typed,
 * not from the draft: each autosave rebuilds the draft from the server's
 * answer, and a value the server normalises (trimmed, a number parsed from
 * "1.") would eat characters mid-typing. The draft shows again once focus
 * leaves. Focus moving into a popover the editor opened (a portal, but a
 * React child) does not count as leaving.
 *
 * Spread `props` on the element that holds the inputs; call `set` next to
 * every apply. `onBlur` runs on every blur (send typed text now).
 */
export function useFocusBuffer<T>(stored: T, onBlur?: () => void) {
  const [box, setBox] = useState<{ v: T } | null>(null)
  const focused = useRef(false)
  const leaving = useRef<ReturnType<typeof setTimeout> | null>(null)
  const storedRef = useRef(stored)
  storedRef.current = stored
  const onBlurRef = useRef(onBlur)
  onBlurRef.current = onBlur
  useEffect(
    () => () => {
      if (leaving.current) clearTimeout(leaving.current)
    },
    []
  )
  return {
    value: box ? box.v : stored,
    /** Record an edit. Without focus inside there is nothing to protect: the draft shows. */
    set: (v: T) => {
      if (focused.current) setBox({ v })
    },
    props: {
      onFocusCapture: () => {
        if (leaving.current) clearTimeout(leaving.current)
        leaving.current = null
        focused.current = true
        setBox((b) => b ?? { v: storedRef.current })
      },
      onBlurCapture: () => {
        onBlurRef.current?.()
        if (leaving.current) clearTimeout(leaving.current)
        leaving.current = setTimeout(() => {
          leaving.current = null
          focused.current = false
          setBox(null)
        }, 0)
      }
    }
  }
}
