// Unread attention count in the browser tab: "(3) CR26-76773 · Nivaro" in the
// title and a numbered badge on the favicon, so a person working in another
// tab sees that something needs them. One module-level controller: the bell
// can be mounted more than once (admin shows a compact and a full one), and
// several pages rewrite document.title as they mount, so the prefix is
// re-applied whenever the title changes instead of being set once.

import { useEffect, useRef } from 'react'

export interface TabAttention {
  count: number
  /** A critical notification is among them — the badge turns red. */
  critical?: boolean
}

const PREFIX = /^\(\d+\+?\) /
const owners = new Map<symbol, TabAttention>()
let observer: MutationObserver | null = null
let iconRequest = 0

/** "(3) " / "(99+) " / "" — what goes in front of the title. */
export function tabTitlePrefix(count: number): string {
  if (!(count > 0)) return ''
  return `(${count > 99 ? '99+' : Math.floor(count)}) `
}

/** The title with our prefix swapped for the one `count` calls for. */
export function withTitlePrefix(title: string, count: number): string {
  return tabTitlePrefix(count) + title.replace(PREFIX, '')
}

/** Badge text for the favicon: "1".."9", then "9+". */
export function faviconBadgeText(count: number): string {
  return count > 9 ? '9+' : String(Math.floor(count))
}

function current(): TabAttention {
  let count = 0
  let critical = false
  for (const o of owners.values()) {
    count = Math.max(count, o.count)
    critical = critical || !!o.critical
  }
  return { count, critical }
}

function applyTitle() {
  const want = withTitlePrefix(document.title, current().count)
  if (document.title !== want) document.title = want
}

function iconLinks(): HTMLLinkElement[] {
  return [...document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]')]
}

function applyFavicon() {
  const { count, critical } = current()
  const links = iconLinks()
  if (links.length === 0) return
  for (const l of links) if (l.dataset.nvrIcon === undefined) l.dataset.nvrIcon = l.href
  const request = ++iconRequest
  if (!(count > 0)) {
    for (const l of links) if (l.dataset.nvrIcon) l.href = l.dataset.nvrIcon
    return
  }
  const source = links[0].dataset.nvrIcon ?? ''
  const img = new Image()
  img.onload = () => {
    if (request !== iconRequest) return // a newer count won the race
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
    ctx.drawImage(img, 0, 0, size, size)
    const text = faviconBadgeText(count)
    const r = text.length > 1 ? 21 : 18
    const cx = size - r
    const cy = r
    // A white ring keeps the badge readable on any icon.
    ctx.beginPath()
    ctx.arc(cx, cy, r + 3, 0, Math.PI * 2)
    ctx.fillStyle = '#ffffff'
    ctx.fill()
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI * 2)
    ctx.fillStyle = critical ? '#dc2626' : '#ea580c'
    ctx.fill()
    ctx.fillStyle = '#ffffff'
    ctx.font = `bold ${text.length > 1 ? 22 : 28}px system-ui, -apple-system, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(text, cx, cy + 2)
    let url = ''
    try {
      url = canvas.toDataURL('image/png')
    } catch {
      return
    }
    for (const l of iconLinks()) {
      if (l.dataset.nvrIcon === undefined) l.dataset.nvrIcon = l.href
      l.href = url
    }
  }
  img.src = source
}

function ensureObserver() {
  if (observer || typeof MutationObserver === 'undefined') return
  observer = new MutationObserver(() => {
    if (owners.size > 0) applyTitle()
  })
  observer.observe(document.head, { subtree: true, childList: true, characterData: true })
}

function apply() {
  applyTitle()
  applyFavicon()
  if (owners.size === 0 && observer) {
    observer.disconnect()
    observer = null
  }
}

/**
 * Show `count` in the tab title and on the favicon while the calling
 * component is mounted; 0 clears it. Several callers combine (largest count
 * wins, any critical makes it red).
 */
export function useTabAttention(
  count: number,
  options: { critical?: boolean; enabled?: boolean } = {}
) {
  const key = useRef<symbol>(Symbol('tab-attention'))
  const enabled = options.enabled ?? true
  const critical = !!options.critical
  useEffect(() => {
    if (typeof document === 'undefined') return
    const k = key.current
    if (!enabled) {
      if (owners.delete(k)) apply()
      return
    }
    const prev = owners.get(k)
    if (prev && prev.count === count && !!prev.critical === critical) return
    owners.set(k, { count, critical })
    ensureObserver()
    apply()
  }, [count, critical, enabled])
  useEffect(() => {
    const k = key.current
    return () => {
      if (owners.delete(k)) apply()
    }
  }, [])
}
