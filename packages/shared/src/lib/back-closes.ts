import { useEffect, useRef } from 'react'

let markerSeq = 0

/**
 * Browser Back closes an open dialog or drawer instead of leaving the page
 * (army 6 L36 / army 8 b07-N5): while `active`, opening pushes a history
 * entry carrying a marker; Back (popstate to any other entry) calls
 * `onClose`; closing any other way pops the entry again — only while it is
 * still the current one, so a navigation made by a confirm is never undone.
 * efp-new's invoice-decision-dialog.tsx `useBackCloses` is the twin.
 */
export function useBackCloses(onClose: () => void, active = true) {
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    if (!active || typeof window === 'undefined') return
    const marker = `nvr-dialog-${++markerSeq}`
    const isOurs = () =>
      (window.history.state as { nvrDialog?: string } | null)?.nvrDialog === marker
    window.history.pushState({ ...(window.history.state ?? {}), nvrDialog: marker }, '')
    let closedByBack = false
    const onPop = () => {
      if (isOurs()) return
      closedByBack = true
      close.current()
    }
    window.addEventListener('popstate', onPop)
    return () => {
      window.removeEventListener('popstate', onPop)
      // Next tick: a StrictMode remount pushes its own entry first, and then
      // this one is no longer current — nothing is popped.
      if (!closedByBack)
        setTimeout(() => {
          if (isOurs()) window.history.back()
        }, 0)
    }
  }, [active])
}
