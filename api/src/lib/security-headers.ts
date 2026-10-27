/**
 * Baseline security headers on every API and admin-SPA response (M21, security audit
 * 2026-10-27).
 *
 * - X-Content-Type-Options: nosniff — a response is never run as a type it was not served as.
 * - Referrer-Policy: strict-origin-when-cross-origin — record URLs never leak in full to
 *   another site.
 * - X-Frame-Options: SAMEORIGIN + CSP frame-ancestors 'self' — the admin cannot be framed by
 *   another site (clickjacking). Same-origin frames (file previews, API reference) still work.
 * - CSP base-uri 'self'; object-src 'none' — no <base> hijack, no plugins.
 * - Strict-Transport-Security only when the request itself came over https (req.protocol, so
 *   it follows TRUST_PROXY); a plain-http dev server never pins a browser to https.
 *
 * No script-src is enforced (the admin and extension UI bundles still need a survey first).
 *
 * A route that already set its own header keeps it (the public form renderer allows any
 * framer; OAuth pages and file responses send stricter policies). Leaf module.
 */

export const BASE_CSP = "frame-ancestors 'self'; base-uri 'self'; object-src 'none'"
export const HSTS = 'max-age=31536000; includeSubDomains'

interface HeaderReply {
  getHeader(name: string): unknown
  header(name: string, value: string): unknown
}

function setIfAbsent(reply: HeaderReply, name: string, value: string): void {
  if (reply.getHeader(name) === undefined) reply.header(name, value)
}

export function applySecurityHeaders(req: { protocol?: string }, reply: HeaderReply): void {
  try {
    setIfAbsent(reply, 'X-Content-Type-Options', 'nosniff')
    setIfAbsent(reply, 'Referrer-Policy', 'strict-origin-when-cross-origin')
    // A route that chose its own framing policy (CSP or XFO) owns both headers.
    const ownCsp = reply.getHeader('content-security-policy') !== undefined
    const ownXfo = reply.getHeader('x-frame-options') !== undefined
    if (!ownCsp && !ownXfo) {
      reply.header('X-Frame-Options', 'SAMEORIGIN')
      reply.header('Content-Security-Policy', BASE_CSP)
    }
    if (req.protocol === 'https') setIfAbsent(reply, 'Strict-Transport-Security', HSTS)
  } catch {
    /* a header must never fail a response */
  }
}
