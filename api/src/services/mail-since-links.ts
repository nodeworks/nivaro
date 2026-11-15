/**
 * "Changed since this email" links (realtime round 3, item 2).
 *
 * Every email this instance sends gets its record links stamped with the send time
 * (`?since=<iso>`) right before it goes out — one pass at the send choke point (sendMail /
 * sendRawMail) instead of every builder. The record page opened from such a link shows a quiet
 * strip of what happened to the record after that moment (routes/record-views.ts `/since`).
 * The stamp is a timestamp only: no secret, no value, nothing a forwarded email could misuse.
 *
 * Only links to this instance's own record pages are touched: the admin route
 * `/collections/{collection}/{id}` and the portal's `record` / `record:<collection>` routes,
 * each on its own origin. A link that already names `since` keeps it.
 */

export interface RecordLinkMatcher {
  /** Absolute origin + path prefix, e.g. `https://app.example.com`. */
  base: string
  /** Path template with `{collection}` / `{id}` placeholders. */
  template: string
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** One regex that matches a full record URL (path end, then optional query / hash). */
export function recordUrlPattern(matchers: RecordLinkMatcher[]): RegExp | null {
  const parts: string[] = []
  for (const m of matchers) {
    if (!m.base || !m.template || !/\{id\}/.test(m.template)) continue
    // Templates with a query of their own (`/x?id={id}`) are left alone.
    if (m.template.includes('?')) continue
    const path = escapeRe(m.template)
      .replace(/\\\{collection\\\}/g, '[^/?#"\'\\s<>]+')
      .replace(/\\\{id\\\}/g, '[^/?#"\'\\s<>]+')
      .replace(/\\\{\w+\\\}/g, '[^/?#"\'\\s<>]+')
    parts.push(escapeRe(m.base.replace(/\/$/, '')) + path)
  }
  if (parts.length === 0) return null
  return new RegExp(`^(?:${parts.join('|')})/?(?:[?#]|$)`, 'i')
}

/** Add `since=<iso>` to one URL (before any hash). Pure — exported for tests. */
export function withSince(url: string, iso: string, ampersand = '&'): string {
  const hashAt = url.indexOf('#')
  const head = hashAt >= 0 ? url.slice(0, hashAt) : url
  const hash = hashAt >= 0 ? url.slice(hashAt) : ''
  if (/[?&](?:amp;)?since=/.test(head)) return url
  const sep = head.includes('?') ? ampersand : '?'
  return `${head}${sep}since=${encodeURIComponent(iso)}${hash}`
}

/**
 * Stamp every `href` in `html` that points at one of this instance's record pages, and every
 * bare record URL in a plain-text body. Pure — exported for tests.
 */
export function stampSinceOnRecordLinks(
  body: string,
  pattern: RegExp | null,
  iso: string,
  kind: 'html' | 'text' = 'html'
): string {
  if (!pattern || !body) return body
  if (kind === 'html') {
    return body.replace(/(href\s*=\s*)(["'])([^"']*)\2/gi, (all, pre: string, q: string, url) => {
      const decoded = String(url)
      return pattern.test(decoded.replace(/&amp;/g, '&'))
        ? `${pre}${q}${withSince(decoded, iso, '&amp;')}${q}`
        : all
    })
  }
  return body.replace(/https?:\/\/[^\s<>"')]+/gi, (url) =>
    pattern.test(url) ? withSince(url, iso) : url
  )
}

/** Matchers for this instance's own record pages (admin + portal). */
async function ownRecordMatchers(): Promise<RecordLinkMatcher[]> {
  const { recordLinkMatchers } = await import('./app-links.js')
  return recordLinkMatchers()
}

let cache: { at: number; pattern: RegExp | null } | null = null

/** The send-time stamp for one outgoing mail. Never throws; a failure sends the mail unchanged. */
export async function stampMailRecordLinks(
  html: string,
  text: string | undefined,
  at = new Date()
): Promise<{ html: string; text: string | undefined }> {
  try {
    if (!cache || Date.now() - cache.at > 30_000) {
      cache = { at: Date.now(), pattern: recordUrlPattern(await ownRecordMatchers()) }
    }
    const iso = at.toISOString()
    return {
      html: stampSinceOnRecordLinks(html, cache.pattern, iso, 'html'),
      text: text ? stampSinceOnRecordLinks(text, cache.pattern, iso, 'text') : text
    }
  } catch {
    return { html, text }
  }
}
