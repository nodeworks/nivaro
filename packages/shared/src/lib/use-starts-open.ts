import { useEffect, useRef, useState } from 'react'

/**
 * A record-page panel's open state, seeded from its layout's "Starts open"
 * (default_expanded). The panel follows every CHANGE of that setting — the
 * layout editor's toggle folds or opens the panel on the canvas at once, with
 * no reload — and otherwise keeps whatever the person did with it.
 *
 * `undefined` = the layout has not said yet (still loading): `fallback` until it does.
 */
export function useStartsOpen(
  startsOpen: boolean | undefined,
  fallback: boolean
): [boolean, React.Dispatch<React.SetStateAction<boolean>>] {
  const [open, setOpen] = useState(startsOpen ?? fallback)
  const last = useRef(startsOpen)
  useEffect(() => {
    if (startsOpen === undefined || startsOpen === last.current) return
    last.current = startsOpen
    setOpen(startsOpen)
  }, [startsOpen])
  return [open, setOpen]
}
