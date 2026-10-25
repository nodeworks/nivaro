import { useEffect, useRef } from 'react'

/**
 * Should a click on `a` be held because it leaves a page with unsaved work?
 * Same-origin, same-tab, plain left click to another path; a link inside
 * `keep` (the form itself) or inside a dialog the form did not open from
 * (a drill sheet, a picker) is that surface's own business. Pure, for tests.
 */
export function isLeavingLink(
  e: Pick<
    MouseEvent,
    'button' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'defaultPrevented'
  >,
  a: HTMLAnchorElement | null,
  here: { origin: string; pathname: string; search: string },
  keep?: HTMLElement | null
): boolean {
  if (e.defaultPrevented || e.button !== 0) return false
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return false
  if (!a || (a.target && a.target !== '_self') || a.hasAttribute('download')) return false
  let url: URL
  try {
    url = new URL(a.href, `${here.origin}${here.pathname}${here.search}`)
  } catch {
    return false
  }
  if (url.origin !== here.origin) return false
  if (url.pathname + url.search === here.pathname + here.search) return false
  if (keep?.contains(a)) return false
  const dlg = a.closest('[role="dialog"]')
  if (dlg && !(keep && dlg.contains(keep))) return false
  return true
}

/**
 * In-app links clicked while there is unsaved work (a sidebar item, a
 * breadcrumb): held, and `ask` decides; `go` follows the link after all. Works
 * in every host without a data router (admin's BrowserRouter has no
 * useBlocker): React Router's Link skips a click whose default was prevented.
 * Only the first guard registered asks — two dirty forms never stack prompts.
 */
export function useLeaveLinkGuard(
  dirty: boolean,
  ask: (go: () => void, anchor: HTMLElement) => void,
  keep?: { current: HTMLElement | null }
): void {
  const askRef = useRef(ask)
  askRef.current = ask
  useEffect(() => {
    if (!dirty) return
    let passing = false
    const onClick = (e: MouseEvent) => {
      if (passing) return
      const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
      if (!isLeavingLink(e, a, window.location, keep?.current) || !a) return
      e.preventDefault()
      e.stopImmediatePropagation()
      askRef.current(() => {
        passing = true
        try {
          a.click()
        } finally {
          passing = false
        }
      }, a)
    }
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, [dirty, keep])
}
