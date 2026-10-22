import { useEffect, useRef } from 'react'

/**
 * Huddle popovers and menus also close when the window loses focus. Radix closes them on a
 * click elsewhere in this page, but a click into another app, the mini-player window, the
 * browser's screen picker or an embedded frame never reaches the page as a click — the menu
 * stayed open behind it.
 */
export function useCloseOnWindowBlur(open: boolean, close: () => void): void {
  const closeRef = useRef(close)
  closeRef.current = close
  useEffect(() => {
    if (!open || typeof window === 'undefined') return
    const onBlur = () => closeRef.current()
    window.addEventListener('blur', onBlur)
    return () => window.removeEventListener('blur', onBlur)
  }, [open])
}
