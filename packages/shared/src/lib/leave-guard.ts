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
 * A control that navigates without being a link (a "New ▸ PO Request" menu
 * row calling navigate()) opts in with `data-leave-guard` (army11 f3: it left
 * a dirty form without the prompt the sidebar links show). Plain left click,
 * outside the form itself and outside a dialog the form did not open from.
 */
export function isLeavingControl(
  e: Pick<
    MouseEvent,
    'button' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'defaultPrevented'
  >,
  el: Element | null,
  keep?: HTMLElement | null
): boolean {
  if (!el || e.defaultPrevented || e.button !== 0) return false
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return false
  if (!el.hasAttribute('data-leave-guard')) return false
  if (el instanceof HTMLButtonElement && el.disabled) return false
  if (keep?.contains(el)) return false
  const dlg = el.closest('[role="dialog"]')
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
  keep?: { current: HTMLElement | null },
  /** The host's router navigate: replays a held control's `data-leave-href`
   *  when the control is gone by the time the person says Leave. */
  navigate?: (path: string) => void
): void {
  const askRef = useRef(ask)
  askRef.current = ask
  const navigateRef = useRef(navigate)
  navigateRef.current = navigate
  useEffect(() => {
    if (!dirty) return
    let passing = false
    const onClick = (e: MouseEvent) => {
      if (passing) return
      const target = e.target as Element | null
      const a = target?.closest?.('a[href]') as HTMLAnchorElement | null
      const ctl = a
        ? null
        : ((target?.closest?.('[data-leave-guard]') as HTMLElement | null) ?? null)
      const held = a
        ? isLeavingLink(e, a, window.location, keep?.current)
        : isLeavingControl(e, ctl, keep?.current)
      const el: HTMLElement | null = a ?? ctl
      if (!held || !el) return
      e.preventDefault()
      e.stopImmediatePropagation()
      // What Leave does, decided NOW: a menu row is often unmounted by the time
      // the person answers (army11 review #2 — the click went nowhere).
      const href = a ? null : el.getAttribute('data-leave-href')
      askRef.current(() => {
        passing = true
        try {
          replayLeave(el, href, navigateRef.current)
        } finally {
          passing = false
        }
      }, el)
    }
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, [dirty, keep])
}

/**
 * Follow a held link / control after "Leave": click it again while it is still
 * on the page; a control that is gone (its menu closed) goes to the path it
 * named in `data-leave-href` through the host's navigate. Pure, for tests.
 */
export function replayLeave(
  el: HTMLElement,
  href: string | null,
  navigate: ((path: string) => void) | undefined
): 'clicked' | 'navigated' | 'lost' {
  if (el.isConnected) {
    el.click()
    return 'clicked'
  }
  if (href && navigate) {
    navigate(href)
    return 'navigated'
  }
  return 'lost'
}
