import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { appBox } from '../app-state.js'
import { hubModeEnabled } from './mode.js'
import { hubStandalone } from './standalone.js'

/**
 * The standalone Hub's own look, server side (the admin half is admin/src/lib/hub-product.ts).
 *
 *  - hubStandaloneCached(): hubStandalone() kept 30 s — read on every SPA page load and every mail
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

const TTL_MS = 30_000
const standaloneCache = appBox<{ at: number; value: boolean } | null>(() => null)

export async function hubStandaloneCached(
  deps: { now?: number; read?: () => Promise<boolean>; env?: NodeJS.ProcessEnv } = {}
): Promise<boolean> {
  const env = deps.env ?? process.env
  if (!deps.read && !hubModeEnabled(env)) return false
  const now = deps.now ?? Date.now()
  const hit = standaloneCache.value
  if (hit && now - hit.at < TTL_MS) return hit.value
  const value = await (deps.read ?? (() => hubStandalone({ env })))()
  standaloneCache.value = { at: now, value }
  return value
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
