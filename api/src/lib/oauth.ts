/**
 * OAuth 2.1 building blocks for remote MCP clients (ChatGPT, claude.ai, Claude
 * Code, Codex): PKCE, redirect-URI rules and token shapes. Pure — the store
 * (services/oauth-store.ts) and the routes (routes/oauth.ts) use these.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/** The one scope: the connected app acts as the signed-in person, with their permissions. */
export const OAUTH_SCOPE = 'nivaro'

/** Access tokens start `nvo_`, refresh tokens `nvor_` — authenticate routes on the prefix. */
export const ACCESS_PREFIX = 'nvo_'
export const REFRESH_PREFIX = 'nvor_'

export function randomToken(prefix = ''): string {
  return `${prefix}${randomBytes(32).toString('base64url')}`
}

/** Tokens and codes are stored by hash only. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url')
}

/** RFC 7636 S256: BASE64URL(SHA256(verifier)) === challenge. Plain is not accepted. */
export function verifyPkceS256(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false
  const expected = Buffer.from(createHash('sha256').update(verifier).digest('base64url'))
  const given = Buffer.from(challenge)
  return expected.length === given.length && timingSafeEqual(expected, given)
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/**
 * A redirect URI a client may register: https anywhere, http only to a loopback
 * address (native apps — Claude Code, Codex — listen on localhost), never a
 * fragment, credentials or a non-http(s) scheme.
 */
export function isAllowedRedirectUri(raw: string): boolean {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  if (u.hash || u.username || u.password) return false
  if (u.protocol === 'https:') return true
  return u.protocol === 'http:' && LOOPBACK.has(u.hostname)
}

/**
 * Whether `given` matches a registered URI: exact, except that a loopback URI
 * may use any port (RFC 8252 §7.3 — the native app picks a free one per run).
 */
export function redirectMatches(registered: string[], given: string): boolean {
  if (registered.includes(given)) return true
  let g: URL
  try {
    g = new URL(given)
  } catch {
    return false
  }
  if (g.protocol !== 'http:' || !LOOPBACK.has(g.hostname)) return false
  return registered.some((r) => {
    try {
      const u = new URL(r)
      return (
        u.protocol === 'http:' &&
        LOOPBACK.has(u.hostname) &&
        u.hostname === g.hostname &&
        u.pathname === g.pathname &&
        u.search === g.search
      )
    } catch {
      return false
    }
  })
}

/** `redirect_uri` with the authorization response appended (RFC 6749 §4.1.2, RFC 9207 `iss`). */
export function withAuthResponse(redirectUri: string, params: Record<string, string | undefined>) {
  const u = new URL(redirectUri)
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') u.searchParams.set(k, v)
  return u.toString()
}

/** A display name a client registered, safe to show on the consent page. */
export function cleanClientName(raw: unknown): string {
  const s =
    typeof raw === 'string'
      ? [...raw]
          .filter((c) => {
            const code = c.charCodeAt(0)
            return code >= 0x20 && code !== 0x7f
          })
          .join('')
          .trim()
      : ''
  return (s || 'An AI assistant').slice(0, 80)
}

export function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
  )
}
