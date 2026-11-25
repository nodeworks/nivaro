import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { appBox } from '../app-state.js'
import { hubModeEnabled } from './mode.js'
import { hasAppCollections } from './standalone.js'

/**
 * The standalone Hub's own look, server side (the admin half is admin/src/lib/hub-product.ts).
 *
 *  - hubStandaloneCached(): hubStandalone() kept 60 s — read on every SPA page load and every mail
 *    send, so it must not cost a database round trip each time. Off (HUB not on) answers at once.
 *  - hubIndexHtml(): index.html with the Hub's icons, manifest, title and `data-product="hub"` on
 *    <html>, so a standalone Hub's tab never shows the Nivaro icon, even on a browser that has
 *    never been here (the inline boot script covers later loads from localStorage).
 *  - HUB_BRAND: the public paths of the Hub artwork (admin/public/hub-brand, original art).
 *
 * A regular install (and a Hub that also holds app data) never takes any of these paths.
 */

export const HUB_BRAND = {
  favicon: '/hub-brand/favicon.svg',
  favicon32: '/hub-brand/favicon-32.png',
  favicon16: '/hub-brand/favicon-16.png',
  appleTouch: '/hub-brand/apple-touch-icon.png',
  manifest: '/hub-brand/manifest.webmanifest',
  logo512: '/hub-brand/icon-512.png',
  mailMark: '/hub-brand/mail-mark.png'
} as const

export const HUB_PRODUCT_NAME = 'Nivaro Hub'
/** Signal amber: the Hub's accent (admin hub-brand.css HUB_ACCENT). */
export const HUB_ACCENT = '#f5a623'
/** Nivaro's stock accent: a project colour equal to it was never chosen by anyone. */
export const NIVARO_STOCK_ACCENT = '#00ceff'

/**
 * A project name nobody chose: empty, the product's own name, or the database default
 * ("Nivaro CMS", base schema 000). Twin of admin/src/lib/hub-product.ts STOCK_PROJECT_NAMES (a
 * test keeps the two equal), so app-info, Hub mail and the tab title agree.
 */
export const STOCK_PROJECT_NAMES: readonly string[] = ['', 'nivaro', 'nivaro cms']

export function isStockProjectName(name: string | null | undefined): boolean {
  return STOCK_PROJECT_NAMES.includes(
    String(name ?? '')
      .trim()
      .toLowerCase()
  )
}

/** Text that reads on `hex` (WCAG): near-black on a light fill, white on a dark one. */
export function inkOn(hex: string): '#ffffff' | '#14110a' {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? '').trim())
  if (!m) return '#ffffff'
  const n = Number.parseInt(m[1], 16)
  const lin = (c: number) => {
    const v = c / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  const L = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255)
  return 1.05 / (L + 0.05) >= 4.5 ? '#ffffff' : '#14110a'
}

/** How long "is this a standalone Hub" is kept per app (app-info, index.html, mail). */
const TTL_MS = 60_000
const standaloneCache = appBox<{ at: number; value: boolean } | null>(() => null)

/**
 * hubStandalone(), kept 60 s per app. A failed read keeps the last known answer (and is asked
 * again next time): a database blip never flips the Hub look off mid-session. With no answer yet,
 * a failure answers false (the full Nivaro look, never a missing page).
 */
export async function hubStandaloneCached(
  deps: { now?: number; read?: () => Promise<boolean>; env?: NodeJS.ProcessEnv } = {}
): Promise<boolean> {
  const env = deps.env ?? process.env
  if (!deps.read && !hubModeEnabled(env)) return false
  const now = deps.now ?? Date.now()
  const hit = standaloneCache.value
  if (hit && now - hit.at < TTL_MS) return hit.value
  try {
    const value = await (deps.read ?? (async () => !(await hasAppCollections())))()
    standaloneCache.value = { at: now, value }
    return value
  } catch {
    return hit?.value ?? false
  }
}

/** Test hook. */
export function resetHubBrandCache(): void {
  standaloneCache.value = null
  indexCache.value = null
}

/**
 * index.html as a standalone Hub serves it. Pure: swaps the icon, manifest and apple-touch links
 * (keeping the originals in data-nvr-base-* like the boot script does), adds the PNG fallbacks,
 * names the tab and marks <html>. A file that does not look like the admin's index comes back
 * unchanged apart from what matched.
 */
export function hubIndexHtml(html: string): string {
  let out = html.replace(/<html(\s|>)/i, (_m, rest: string) => `<html data-product="hub"${rest}`)
  out = out.replace(
    /<link rel="icon"([^>]*?)href="([^"]*)"([^>]*)>/i,
    (_m, a: string, href: string, b: string) =>
      `<link rel="icon"${a.replace(/type="[^"]*"/, 'type="image/svg+xml"')}href="${HUB_BRAND.favicon}" data-nvr-base-icon="${href}"${b}>` +
      `\n    <link rel="icon" type="image/png" sizes="32x32" href="${HUB_BRAND.favicon32}" data-hub-icon="32x32" />` +
      `\n    <link rel="icon" type="image/png" sizes="16x16" href="${HUB_BRAND.favicon16}" data-hub-icon="16x16" />`
  )
  out = out.replace(
    /<link rel="manifest" href="([^"]*)"/i,
    (_m, href: string) =>
      `<link rel="manifest" href="${HUB_BRAND.manifest}" data-nvr-base-href="${href}"`
  )
  out = out.replace(
    /<link rel="apple-touch-icon" href="([^"]*)"/i,
    (_m, href: string) =>
      `<link rel="apple-touch-icon" href="${HUB_BRAND.appleTouch}" data-nvr-base-href="${href}"`
  )
  out = out.replace(/<title>[^<]*<\/title>/i, `<title>${HUB_PRODUCT_NAME}</title>`)
  out = out.replace(
    /<meta name="theme-color" content="#ffffff" media="\(prefers-color-scheme: light\)" \/>/i,
    '<meta name="theme-color" content="#0d1726" media="(prefers-color-scheme: light)" />'
  )
  return out
}

const indexCache = appBox<{ path: string; html: string } | null>(() => null)

/**
 * The Hub's index.html for this admin build, or null when this is not a standalone Hub (the
 * caller then serves the file as it always did). The build never changes under a running
 * process, so the rewritten file is kept.
 */
export async function hubIndexFor(adminBuildPath: string): Promise<string | null> {
  if (!(await hubStandaloneCached())) return null
  const path = join(adminBuildPath, 'index.html')
  const hit = indexCache.value
  if (hit && hit.path === path) return hit.html
  try {
    const html = hubIndexHtml(await readFile(path, 'utf8'))
    indexCache.value = { path, html }
    return html
  } catch {
    return null
  }
}
