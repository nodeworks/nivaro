/**
 * #28 — open several records in browser tabs from one click. Browsers allow
 * a burst of window.open calls from ONE user gesture only when pop-ups are
 * allowed for the site; otherwise the first opens and the rest are blocked
 * (window.open returns null). The caller reports the honest count.
 */
export const OPEN_IN_TABS_CAP = 15

export function openInTabs(urls: string[]): { opened: number; blocked: number; capped: number } {
  const list = urls.slice(0, OPEN_IN_TABS_CAP)
  let opened = 0
  let blocked = 0
  for (const url of list) {
    const w = window.open(url, '_blank', 'noopener')
    if (w) opened += 1
    else blocked += 1
  }
  return { opened, blocked, capped: Math.max(0, urls.length - list.length) }
}

export function openInTabsMessage(r: { opened: number; blocked: number; capped: number }): string {
  const parts = [`Opened ${r.opened} tab${r.opened === 1 ? '' : 's'}`]
  if (r.blocked > 0)
    parts.push(`${r.blocked} blocked — allow pop-ups for this site to open them all at once`)
  if (r.capped > 0) parts.push(`${r.capped} more not opened (cap ${OPEN_IN_TABS_CAP})`)
  return parts.join(' · ')
}
