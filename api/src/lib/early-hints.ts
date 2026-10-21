import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 103 Early Hints for the admin build the release image serves (#2440).
 *
 * The browser asks for a page, and before index.html itself is on its way the server answers
 * with an informational 103 naming what that page will load first: the entry script (and any
 * modulepreload chunks), its stylesheet, the font origins and any font the entry stylesheet
 * pulls from /assets. The browser starts those fetches while the HTML is still in flight. The
 * same list rides the final response as a `Link` header, which a CDN in front can turn into
 * its own 103.
 *
 * `EARLY_HINTS`:
 *   - unset / `off` — nothing is sent (default: whether a 103 passes through depends on the
 *     proxy in front, so a deployment turns it on once it knows);
 *   - `link` — only the `Link` header on the HTML response;
 *   - `on` — the 103 as well, to HTTP/1.1 and newer clients. An HTTP/1.0 client never gets an
 *     informational response (RFC 9110 §15.2), so it cannot be broken by one.
 *
 * Transport only: the list names hashed, immutable files read from the built index.html at
 * boot, so nothing it points at can be stale.
 */

export type EarlyHintsMode = 'off' | 'link' | 'on'

export function earlyHintsMode(env: string | undefined = process.env.EARLY_HINTS): EarlyHintsMode {
  const v = (env ?? '').trim().toLowerCase()
  if (v === 'on' || v === '1' || v === 'true') return 'on'
  if (v === 'link') return 'link'
  return 'off'
}

/** Most links one hint carries — enough for the entry, its chunks and fonts, never a dump. */
const MAX_LINKS = 16
const MAX_FONTS = 4

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'))
  if (!m) return null
  return m[2] ?? m[3] ?? m[4] ?? ''
}

function hasAttr(tag: string, name: string): boolean {
  return new RegExp(`\\s${name}(\\s|=|>|/)`, 'i').test(tag)
}

/** A URL a Link header may carry: same-origin paths and https origins, nothing with `<>` or `,`. */
function safeHref(href: string | null): string | null {
  if (!href) return null
  if (/[<>\s,]/.test(href)) return null
  if (href.startsWith('/') && !href.startsWith('//')) return href
  if (/^https:\/\/[^/]+/i.test(href)) return href
  return null
}

/**
 * The Link values for one built index.html, in fetch order: preconnects, stylesheets, module
 * scripts, then fonts. `readAsset` returns a local asset's text (the entry stylesheet, to find
 * its fonts) or null. A stylesheet's `crossorigin` is mirrored onto its preload so the browser
 * reuses the hinted response instead of fetching twice.
 */
export function hintLinksFromHtml(
  html: string,
  readAsset: (path: string) => string | null = () => null
): string[] {
  const head = html.split(/<\/head>/i)[0] ?? html
  const preconnect: string[] = []
  const styles: string[] = []
  const scripts: string[] = []
  const fonts: string[] = []
  const localCss: string[] = []

  for (const m of head.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0]
    const rel = (attr(tag, 'rel') ?? '').toLowerCase()
    const href = safeHref(attr(tag, 'href'))
    if (!href) continue
    const cors = hasAttr(tag, 'crossorigin') ? '; crossorigin' : ''
    if (rel === 'preconnect') preconnect.push(`<${href}>; rel=preconnect${cors}`)
    else if (rel === 'stylesheet') {
      styles.push(`<${href}>; rel=preload; as=style${cors}`)
      if (href.startsWith('/')) localCss.push(href)
    } else if (rel === 'modulepreload') scripts.push(`<${href}>; rel=modulepreload`)
  }
  for (const m of html.matchAll(/<script\b[^>]*>/gi)) {
    const tag = m[0]
    if ((attr(tag, 'type') ?? '').toLowerCase() !== 'module') continue
    const src = safeHref(attr(tag, 'src'))
    if (src) scripts.push(`<${src}>; rel=modulepreload`)
  }
  for (const css of localCss) {
    const text = readAsset(css)
    if (!text) continue
    for (const f of text.matchAll(/url\(\s*["']?(\/assets\/[^"')\s]+\.woff2)["']?\s*\)/gi)) {
      const href = safeHref(f[1])
      const link = href ? `<${href}>; rel=preload; as=font; type="font/woff2"; crossorigin` : null
      if (link && !fonts.includes(link) && fonts.length < MAX_FONTS) fonts.push(link)
    }
  }
  return [...new Set([...preconnect, ...styles, ...scripts, ...fonts])].slice(0, MAX_LINKS)
}

/** The hint list for a built admin folder, read once at boot; [] when there is no build. */
export function loadEarlyHints(buildDir: string): string[] {
  const index = join(buildDir, 'index.html')
  if (!existsSync(index)) return []
  try {
    const html = readFileSync(index, 'utf8')
    return hintLinksFromHtml(html, (path) => {
      const file = join(buildDir, path.replace(/^\/+/, ''))
      if (!file.startsWith(buildDir)) return null
      try {
        return readFileSync(file, 'utf8')
      } catch {
        return null
      }
    })
  } catch {
    return []
  }
}

interface HintRequest {
  method: string
  headers: Record<string, string | string[] | undefined>
  raw: { httpVersionMajor: number; httpVersionMinor: number }
}

interface HintReply {
  header(name: string, value: string): unknown
  raw: {
    headersSent: boolean
    writeEarlyHints?: (hints: Record<string, string | string[]>, cb?: () => void) => void
  }
}

/** A navigation to the app: a GET/HEAD that asks for HTML. */
export function wantsDocument(req: Pick<HintRequest, 'method' | 'headers'>): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false
  const accept = req.headers.accept
  const text = Array.isArray(accept) ? accept.join(',') : (accept ?? '')
  return /text\/html/i.test(text)
}

/**
 * Hint one HTML response. Never throws — a hint is decoration and the page must still go out.
 * Returns what was done, for tests.
 */
export function applyEarlyHints(
  req: HintRequest,
  reply: HintReply,
  links: string[],
  mode: EarlyHintsMode = earlyHintsMode()
): 'none' | 'link' | 'early' {
  if (mode === 'off' || links.length === 0 || !wantsDocument(req)) return 'none'
  try {
    reply.header('Link', links.join(', '))
    const { httpVersionMajor: major, httpVersionMinor: minor } = req.raw
    const modern = major > 1 || (major === 1 && minor >= 1)
    if (mode === 'on' && modern && !reply.raw.headersSent && reply.raw.writeEarlyHints) {
      reply.raw.writeEarlyHints({ link: links })
      return 'early'
    }
    return 'link'
  } catch {
    return 'none'
  }
}
