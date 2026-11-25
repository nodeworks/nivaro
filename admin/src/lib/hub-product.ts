import { setTabTitleProduct } from '@nivaro/shared'
import { useEffect, useSyncExternalStore } from 'react'
import { useServerFeaturesQuery } from './useServerFeatures'

/**
 * The standalone Hub look (server feature `hub_only`, api services/hub/standalone.ts).
 *
 * One switch: `data-product="hub"` on <html>. Every Hub style lives under that attribute
 * (hub-brand.css) or in components rendered only while it is on, so a regular install, and a
 * Hub that also holds app data, never sees any of it.
 *
 * It is set as early as possible so a standalone Hub never flashes the Nivaro look:
 *  1. the server writes it into index.html for a standalone Hub (api services/hub/brand-index.ts),
 *  2. the inline boot script in index.html replays the last answer this browser saw
 *     (localStorage `nvr:product`), with the Hub icons and title,
 *  3. GET /api/app-info confirms or withdraws it (useHubProduct), and stores the answer for (2).
 */

export const HUB_PRODUCT_KEY = 'nvr:product'
export const HUB_PRODUCT_ATTR = 'data-product'
export const HUB_PRODUCT_VALUE = 'hub'

/** The Hub's own icons (admin/public/hub-brand). Regular installs keep index.html's links. */
export const HUB_ICONS = {
  svg: '/hub-brand/favicon.svg',
  png32: '/hub-brand/favicon-32.png',
  png16: '/hub-brand/favicon-16.png',
  appleTouch: '/hub-brand/apple-touch-icon.png',
  manifest: '/hub-brand/manifest.webmanifest',
  logo512: '/hub-brand/icon-512.png'
} as const

/** The browser tab says which product it is: "Hub · Apps — Nivaro Hub". */
export const HUB_TITLE_LABEL = 'Hub'
export const HUB_PRODUCT_NAME = 'Nivaro Hub'

/** Signal amber: the Hub's accent where Nivaro uses cyan (hub-brand.css carries the scale). */
export const HUB_ACCENT = '#f5a623'
/** The stock Nivaro accent: a project colour equal to it was never chosen by anyone. */
export const NIVARO_STOCK_ACCENT = '#00ceff'

/** Does this feature list mean "standalone Hub"? */
export function isHubProduct(features: Iterable<string> | null | undefined): boolean {
  if (!features) return false
  for (const f of features) if (f === 'hub_only') return true
  return false
}

export function hubProductOn(doc: Document = document): boolean {
  return doc.documentElement.getAttribute(HUB_PRODUCT_ATTR) === HUB_PRODUCT_VALUE
}

/** Point every icon link (and the manifest) at the Hub's icons, or back to Nivaro's. */
function swapIcons(doc: Document, on: boolean): void {
  const head = doc.head
  if (!head) return
  const links = [...head.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]')]
  for (const l of links) {
    if (on) {
      if (l.dataset.nvrBaseIcon === undefined) l.dataset.nvrBaseIcon = l.getAttribute('href') ?? ''
      if (l.dataset.hubIcon !== undefined) continue
      l.setAttribute('href', HUB_ICONS.svg)
      l.setAttribute('type', 'image/svg+xml')
    } else if (l.dataset.hubIcon !== undefined) {
      l.remove()
    } else if (l.dataset.nvrBaseIcon !== undefined) {
      l.setAttribute('href', l.dataset.nvrBaseIcon)
      delete l.dataset.nvrBaseIcon
    }
  }
  if (on) {
    for (const [size, href] of [
      ['32x32', HUB_ICONS.png32],
      ['16x16', HUB_ICONS.png16]
    ] as const) {
      if (head.querySelector(`link[data-hub-icon="${size}"]`)) continue
      const l = doc.createElement('link')
      l.rel = 'icon'
      l.type = 'image/png'
      l.setAttribute('sizes', size)
      l.setAttribute('href', href)
      l.dataset.hubIcon = size
      head.appendChild(l)
    }
  }
  const swapAttr = (selector: string, hubHref: string) => {
    const el = head.querySelector<HTMLLinkElement>(selector)
    if (!el) return
    if (on) {
      if (el.dataset.nvrBaseHref === undefined)
        el.dataset.nvrBaseHref = el.getAttribute('href') ?? ''
      el.setAttribute('href', hubHref)
    } else if (el.dataset.nvrBaseHref !== undefined) {
      el.setAttribute('href', el.dataset.nvrBaseHref)
      delete el.dataset.nvrBaseHref
    }
  }
  swapAttr('link[rel="manifest"]', HUB_ICONS.manifest)
  swapAttr('link[rel="apple-touch-icon"]', HUB_ICONS.appleTouch)
}

const listeners = new Set<() => void>()

/**
 * Turn the Hub look on or off for this document, and remember it for the next page load's boot
 * script. Idempotent; a change notifies useHubProductFlag subscribers.
 */
export function applyHubProduct(on: boolean, doc: Document = document): void {
  const root = doc.documentElement
  const was = root.getAttribute(HUB_PRODUCT_ATTR) === HUB_PRODUCT_VALUE
  if (on) root.setAttribute(HUB_PRODUCT_ATTR, HUB_PRODUCT_VALUE)
  else if (was) root.removeAttribute(HUB_PRODUCT_ATTR)
  // Only on a change: a refetch that says the same must not rewrite a badged tab icon.
  if (was !== on || (on && !doc.querySelector('link[data-hub-icon]'))) swapIcons(doc, on)
  // "Hub · Apps — Nivaro Hub": the product leads every tab title (packages/shared tab-attention).
  if (on || was) setTabTitleProduct(on ? HUB_TITLE_LABEL : null)
  try {
    if (on) localStorage.setItem(HUB_PRODUCT_KEY, HUB_PRODUCT_VALUE)
    else localStorage.removeItem(HUB_PRODUCT_KEY)
  } catch {
    /* private window: the server-side index.html still sets it */
  }
  if (was !== on) for (const l of listeners) l()
}

/**
 * The server's answer for this page, applied once: the first app-info answer decides (on or off);
 * a later answer may only turn the look ON. A later "off" (a database blip on the server, a
 * refetch racing a restart) never flips the look mid-session — the panels inside (a typed
 * confirmation, a plan) would be thrown away. A reload asks again.
 */
let decided = false

export function confirmHubProduct(on: boolean, doc: Document = document): void {
  if (!decided || on) applyHubProduct(on, doc)
  decided = true
}

/** Test hook: forget this page's decision. */
export function resetHubProductDecision(): void {
  decided = false
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** The attribute as it stands now (boot script / server / app-info), re-rendering on change. */
export function useHubProductFlag(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => hubProductOn(),
    () => false
  )
}

/**
 * Is this the standalone Hub? Reads the early flag at once (no flash), then follows GET
 * /api/app-info: `hub_only` turns it on, its absence turns it off. A failed read keeps what
 * the page started with (the server already decided index.html).
 */
export function useHubProduct(): boolean {
  const q = useServerFeaturesQuery()
  const on = useHubProductFlag()
  useEffect(() => {
    if (!q.isSuccess) return
    confirmHubProduct(isHubProduct(q.data))
  }, [q.isSuccess, q.data])
  return on
}

/**
 * useHubProduct without React Query, for pages outside the app's query client (the sign-in page
 * reads everything with fetch): one GET /api/app-info, same rule — an answer with a feature list
 * decides, anything else keeps what the page started with.
 */
export function useHubProductPublic(): boolean {
  const on = useHubProductFlag()
  useEffect(() => {
    let live = true
    fetch('/api/app-info')
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { features?: unknown } | null) => {
        if (!live || !Array.isArray(d?.features)) return
        confirmHubProduct(
          isHubProduct(d.features.filter((f): f is string => typeof f === 'string'))
        )
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])
  return on
}

/**
 * The accent a white-label setting does not override: an operator's colour (user pick,
 * workspace, project colour) always wins; with none chosen the Hub uses signal amber and Nivaro
 * its stock cyan. A project colour equal to the stock cyan counts as none.
 */
export function defaultAccentFor(
  hub: boolean,
  chosen: string | null | undefined,
  stock: string = NIVARO_STOCK_ACCENT
): string {
  if (!hub) return chosen ?? stock
  if (chosen && chosen.toLowerCase() !== NIVARO_STOCK_ACCENT) return chosen
  return HUB_ACCENT
}

/** Text that reads on `hex` (WCAG relative luminance): near-black on a light fill, else white. */
export function readableOn(hex: string): '#ffffff' | '#14110a' {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return '#ffffff'
  const n = Number.parseInt(m[1], 16)
  const lin = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  const L = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255)
  // White passes AA (4.5:1) only below L ≈ 0.183; above it the dark ink does better.
  return 1.05 / (L + 0.05) >= 4.5 ? '#ffffff' : '#14110a'
}

/**
 * A project name nobody chose: empty, the product's own name, or the database default
 * ("Nivaro CMS", base schema). Twin of api services/hub/brand.ts STOCK_PROJECT_NAMES — a test
 * keeps the two lists equal, so app-info, mail and the tab title agree.
 */
export const STOCK_PROJECT_NAMES: readonly string[] = ['', 'nivaro', 'nivaro cms']

export function isStockProjectName(name: string | null | undefined): boolean {
  return STOCK_PROJECT_NAMES.includes(
    String(name ?? '')
      .trim()
      .toLowerCase()
  )
}

// ─── An operator's colour on the Hub ─────────────────────────────────────────

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const n = Number.parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => {
    const v = c / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/** WCAG contrast of two colours. */
export function contrast(a: string, b: string): number {
  const x = hexToRgb(a)
  const y = hexToRgb(b)
  if (!x || !y) return 1
  const [hi, lo] = [luminance(x), luminance(y)].sort((p, q) => q - p)
  return (hi + 0.05) / (lo + 0.05)
}

const toHex = (rgb: number[]) =>
  `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`

/** `hex` darkened (mixed toward black) until it reaches `ratio` against white. */
export function inkOnWhite(hex: string, ratio = 4.5): string {
  const rgb = hexToRgb(hex)
  if (!rgb) return hex
  for (let k = 0; k <= 1.0001; k += 0.04) {
    const c = toHex(rgb.map((v) => v * (1 - k)))
    if (contrast(c, '#ffffff') >= ratio) return c
  }
  return '#000000'
}

/** `hex` as the "h s% l%" triplet the shadcn tokens use. */
export function hexToHslTriplet(hex: string): string | null {
  const rgb = hexToRgb(hex)
  if (!rgb) return null
  const [r, g, b] = rgb.map((v) => v / 255)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  let h = 0
  let sat = 0
  if (max !== min) {
    const d = max - min
    sat = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
    h *= 60
  }
  return `${Math.round(h)} ${Math.round(sat * 100)}% ${Math.round(l * 100)}%`
}

/**
 * The inline token values that make an operator's colour win across the Hub (primary buttons,
 * focus ring, links, selection), with ink chosen by contrast; null = the stock Hub amber (the
 * CSS defaults in hub-brand.css apply). Keys are CSS custom properties.
 */
export function operatorAccentTokens(color: string): Record<string, string> | null {
  if (color.toLowerCase() === HUB_ACCENT) return null
  const primary = hexToHslTriplet(color)
  if (!primary) return null
  return {
    '--hub-op-primary': primary,
    '--hub-op-primary-fg': readableOn(color) === '#ffffff' ? '0 0% 100%' : '32 45% 6%',
    '--hub-op-ring-light': hexToHslTriplet(inkOnWhite(color, 3)) ?? primary,
    '--hub-op-ink-light': inkOnWhite(color, 4.5),
    '--hub-op-ink-dark': color
  }
}

export const OPERATOR_ACCENT_PROPS = [
  '--hub-op-primary',
  '--hub-op-primary-fg',
  '--hub-op-ring-light',
  '--hub-op-ink-light',
  '--hub-op-ink-dark'
] as const
