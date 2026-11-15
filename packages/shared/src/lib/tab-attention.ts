// Attention count in the browser tab — the title ("(3) CR26-76773 · Nivaro") and,
// for callers that ask for it, a small numbered dot on the favicon — so a
// person working in another tab sees that something needs them. One
// module-level controller: several components can ask (the My Work count, chat
// unread), and several pages rewrite document.title as they mount, so the
// prefix is re-applied whenever the title changes instead of being set once.
//
// One owner composes the title: `(<count>) <Label> · <page title>`. The environment label
// ("Staging · ", EnvironmentNotice) is registered here too (`useTabTitleLabel`) instead of
// running its own title observer: two observers that each put their part first rewrote each
// other forever and froze the tab (staging/dev with unread items, found 2026-11-14).
//
// The favicon is the host's own (a white-label icon included): the badge is
// drawn over whatever icon the page carries, the original href is kept on the
// link as data-nvr-icon and restored at zero, and an icon the host swaps in
// later (a white-label load) becomes the new base.

import { useEffect, useRef } from 'react'

const PREFIX = /^\(\d+\+?\) /
interface Owner {
  count: number
  favicon: boolean
}
const owners = new Map<symbol, Owner>()
/** The environment label in front of the title ("Staging"), and labels to take off. */
let titleLabel: string | null = null
let goneLabels: string[] = []
let observer: MutationObserver | null = null
let iconRequest = 0
/** The data URL this module last put on the icon links (to tell it from a host's own change). */
let ownIcon = ''

/** "(3) " / "(99+) " / "" — what goes in front of the title. */
export function tabTitlePrefix(count: number): string {
  if (!(count > 0)) return ''
  return `(${count > 99 ? '99+' : Math.floor(count)}) `
}

/** The title with our prefix swapped for the one `count` calls for. */
export function withTitlePrefix(title: string, count: number): string {
  return tabTitlePrefix(count) + title.replace(PREFIX, '')
}

/**
 * The one title: `(<count>) <label> · <page title>`. Whatever count and labels the title
 * already carries — in either order, from either writer, `stripLabels` included (a label that
 * just went away) — are taken off first, so composing a composed title changes nothing.
 */
export function composeTabTitle(
  title: string,
  count: number,
  label: string | null,
  stripLabels: Array<string | null | undefined> = []
): string {
  const labels = [...new Set([label, ...stripLabels].filter((l): l is string => !!l))]
  let rest = title
  for (let guard = 0; guard < 8; guard++) {
    const before = rest
    rest = rest.replace(PREFIX, '')
    for (const l of labels) if (rest.startsWith(`${l} · `)) rest = rest.slice(l.length + 3)
    if (rest === before) break
  }
  return tabTitlePrefix(count) + (label ? `${label} · ` : '') + rest
}

/** What the favicon dot says: "3", "9+" (a 16 px tab icon has room for one digit). */
export function faviconBadgeText(count: number): string {
  if (!(count > 0)) return ''
  return count > 9 ? '9+' : String(Math.floor(count))
}

/** Where the dot sits on an icon of `size` px: top right, a white ring around it. */
export function faviconBadgeLayout(
  text: string,
  size: number
): { cx: number; cy: number; r: number; ring: number; font: number } {
  const wide = text.length > 1
  const r = Math.round(size * (wide ? 0.33 : 0.28))
  return {
    cx: size - r,
    cy: r,
    r,
    ring: Math.max(1, Math.round(size * 0.05)),
    font: Math.round(size * (wide ? 0.34 : 0.44))
  }
}

function currentCount(): number {
  let count = 0
  for (const o of owners.values()) count = Math.max(count, o.count)
  return count
}

function wantsFavicon(): boolean {
  for (const o of owners.values()) if (o.favicon && o.count > 0) return true
  return false
}

function applyTitle() {
  const want = composeTabTitle(document.title, currentCount(), titleLabel, goneLabels)
  goneLabels = []
  if (document.title !== want) document.title = want
}

/** Anything for this module to keep in the title (a count owner or a label). */
function active(): boolean {
  return owners.size > 0 || !!titleLabel
}

function iconLinks(): HTMLLinkElement[] {
  return [...document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]')]
}

/** The icon the host intends to show (not our badged copy). */
function baseIcon(links: HTMLLinkElement[]): string {
  for (const l of links) {
    if (l.href && l.href !== ownIcon) return l.href
  }
  return links.find((l) => l.dataset.nvrIcon)?.dataset.nvrIcon ?? ''
}

function restoreFavicon() {
  iconRequest++
  for (const l of iconLinks()) {
    if (l.dataset.nvrIcon !== undefined) {
      if (l.dataset.nvrIcon) l.href = l.dataset.nvrIcon
      delete l.dataset.nvrIcon
    }
  }
  ownIcon = ''
}

function drawBadge(ctx: CanvasRenderingContext2D, size: number, count: number) {
  const text = faviconBadgeText(count)
  const g = faviconBadgeLayout(text, size)
  ctx.beginPath()
  ctx.arc(g.cx, g.cy, g.r + g.ring, 0, Math.PI * 2)
  ctx.fillStyle = '#ffffff'
  ctx.fill()
  ctx.beginPath()
  ctx.arc(g.cx, g.cy, g.r, 0, Math.PI * 2)
  ctx.fillStyle = '#dc2626'
  ctx.fill()
  ctx.fillStyle = '#ffffff'
  ctx.font = `bold ${g.font}px system-ui, -apple-system, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, g.cx, g.cy + size * 0.02)
}

function applyFavicon() {
  const links = iconLinks()
  if (links.length === 0) return
  if (!wantsFavicon()) {
    restoreFavicon()
    return
  }
  const source = baseIcon(links)
  for (const l of links) if (l.dataset.nvrIcon === undefined) l.dataset.nvrIcon = source
  const count = currentCount()
  const request = ++iconRequest
  const put = (canvas: HTMLCanvasElement) => {
    if (request !== iconRequest) return // a newer count won the race
    let url = ''
    try {
      url = canvas.toDataURL('image/png')
    } catch {
      return
    }
    ownIcon = url
    for (const l of iconLinks()) {
      if (l.dataset.nvrIcon === undefined) l.dataset.nvrIcon = source
      l.href = url
    }
  }
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  let ctx: CanvasRenderingContext2D | null = null
  try {
    ctx = canvas.getContext('2d')
  } catch {
    ctx = null
  }
  if (!ctx) return
  const c = ctx
  const img = new Image()
  img.onload = () => {
    c.drawImage(img, 0, 0, size, size)
    drawBadge(c, size, count)
    put(canvas)
  }
  // A cross-origin icon without CORS taints the canvas: the dot alone is better than no signal.
  img.onerror = () => {
    drawBadge(c, size, count)
    put(canvas)
  }
  if (!source) {
    drawBadge(c, size, count)
    put(canvas)
    return
  }
  img.src = source
}

function ensureObserver() {
  if (observer || typeof MutationObserver === 'undefined') return
  observer = new MutationObserver((records) => {
    if (!active()) return
    applyTitle()
    // The host changed its icon (a white-label load): the new one is the base now.
    const swapped = records.some(
      (r) =>
        r.type === 'attributes' &&
        r.target instanceof HTMLLinkElement &&
        r.target.href !== ownIcon &&
        r.target.rel.includes('icon')
    )
    if (swapped && wantsFavicon()) {
      for (const l of iconLinks()) delete l.dataset.nvrIcon
      applyFavicon()
    }
  })
  observer.observe(document.head, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['href']
  })
}

function apply() {
  applyTitle()
  applyFavicon()
  if (!active() && observer) {
    observer.disconnect()
    observer = null
  }
}

/**
 * Show `count` in front of the tab title while the calling component is
 * mounted; 0 clears it. `favicon: true` also draws the count on the tab icon.
 * Several callers combine (largest count wins).
 */
export function useTabAttention(
  count: number,
  options: { enabled?: boolean; favicon?: boolean } = {}
) {
  const key = useRef<symbol>(Symbol('tab-attention'))
  const enabled = options.enabled ?? true
  const favicon = options.favicon === true
  useEffect(() => {
    if (typeof document === 'undefined') return
    const k = key.current
    if (!enabled) {
      if (owners.delete(k)) apply()
      return
    }
    const prev = owners.get(k)
    if (prev && prev.count === count && prev.favicon === favicon) return
    owners.set(k, { count, favicon })
    ensureObserver()
    apply()
  }, [count, enabled, favicon])
  useEffect(() => {
    const k = key.current
    return () => {
      if (owners.delete(k)) apply()
    }
  }, [])
}

/**
 * Put `label · ` in front of the tab title while mounted ("Staging · My Work"), after the
 * attention count when there is one: `(3) Staging · My Work`. null = no label. The latest
 * label asked for wins; unmounting takes it off again.
 */
export function useTabTitleLabel(label: string | null) {
  useEffect(() => {
    if (typeof document === 'undefined' || !label) return
    if (titleLabel && titleLabel !== label) goneLabels.push(titleLabel)
    titleLabel = label
    ensureObserver()
    apply()
    return () => {
      if (titleLabel !== label) return
      titleLabel = null
      goneLabels.push(label)
      apply()
    }
  }, [label])
}
